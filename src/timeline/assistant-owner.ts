/** Consume task-assistant v1 events as a separate advice slot. Do not import timeline UI classes from task-assistant. */
import {
	TASK_ASSISTANT_CHANNEL,
	parseTaskAssistantEvent,
	type SuggestionItem,
	type TaskAssistantAdviceContext,
	type TaskAssistantCovered,
	type TaskAssistantEvent,
	type TaskAssistantUpdate,
} from "../advice/events.ts";
import type { NextV1, TimelineStep } from "./contracts.ts";
import { isEmptyTurn, redact, splitTurns, textOf, turnDecisions, type Entry } from "./core.ts";
import { latestSettledReply } from "../advice/postreply.ts";
import type { Predictions } from "./sidebar.ts";

export { TASK_ASSISTANT_CHANNEL, parseTaskAssistantEvent };
export type { TaskAssistantAdviceContext, TaskAssistantCovered, TaskAssistantEvent };

/** Goal anchor pushed to the lower pane: goal + settled decisions + the user's own recent words. */
export function adviceContextEvent(sessionId: string, goal: string, decisions: readonly string[], userMessages: readonly string[], replyEntryId?: string): TaskAssistantAdviceContext {
	return { type: "advice-context", version: 1, sessionId, replyEntryId, goal, decisions: [...decisions], userMessages: [...userMessages] };
}

/** Current branch facts, including answers before the latest summary has been written. */
export function adviceAnchorFromBranch(branch: readonly Entry[], records: ReadonlyMap<string, TimelineStep>, fallbackGoal = "") {
	const turns = splitTurns(branch);
	const settled = latestSettledReply(branch);
	if (!settled || !turns.length) return undefined;
	let goal = fallbackGoal;
	for (const turn of turns) if (records.get(turn.fromId)?.goal) goal = records.get(turn.fromId)!.goal;
	const current = turnDecisions(turns.at(-1)!);
	const history = turns.filter((t) => !isEmptyTurn(t)).flatMap((t) => records.get(t.fromId)?.decisions ?? []);
	const decisions = [...new Set([...history, ...current])].slice(-Math.max(3, current.length));
	const userMessages = turns.slice(-3).map((t) => redact(textOf(t.entries[0]?.message?.content)).slice(0, 400)).filter(Boolean);
	return { replyEntryId: settled.replyEntryId, goal, decisions, userMessages };
}

/** What the upper pane is showing right now, so the lower pane can yield instead of repeating it. */
export function adviceCoveredEvent(sessionId: string, texts: readonly string[], replyEntryId?: string): TaskAssistantCovered {
	return { type: "advice-covered", version: 1, sessionId, replyEntryId, texts: texts.filter((t) => t.trim()) };
}

/** Conversation next-message prediction. Provider presence never disables this. */
export function shouldGenerateNext(isLatestTurn: boolean): boolean {
	return isLatestTurn;
}

export type AdviceSlot = {
	provider: boolean;
	/** Explicitly off/shutdown; an enabled provider without a snapshot still owns an idle pane. */
	suspended?: boolean;
	update: TaskAssistantUpdate | undefined;
};

export const EMPTY_ADVICE_SLOT: AdviceSlot = { provider: false, update: undefined };

/** Record hello/update/clear without taking the prediction slot. */
export function applyAdviceEvent(slot: AdviceSlot, data: unknown): AdviceSlot {
	const event = parseTaskAssistantEvent(data);
	if (!event) return slot;
	if (event.type === "hello") {
		if (event.role !== "provider") return slot;
		const suspended = event.enabled === false;
		if (slot.provider && Boolean(slot.suspended) === suspended) return slot;
		return { ...slot, provider: true, suspended };
	}
	if (!slot.provider) return slot;
	if (event.type === "clear") {
		const suspended = event.reason === "off" || event.reason === "shutdown" ? true
			: event.reason === "session_start" ? false : Boolean(slot.suspended);
		if (!slot.update && Boolean(slot.suspended) === suspended) return slot;
		return { ...slot, update: undefined, suspended };
	}
	if (event.type === "update") return { ...slot, update: event };
	return slot;
}

/** Map stored advice for a later lower region. Must not replace the prediction view. */
export function predictionsFromUpdate(update: TaskAssistantUpdate | undefined, agentActive: boolean): Predictions | undefined {
	if (agentActive || !update) return undefined;
	if (update.status === "pending") {
		return { steps: [], directions: [], pending: true, source: "task-assistant" };
	}
	if (update.status === "failed") {
		return { steps: [], directions: [], pending: false, error: update.error || "未判定", source: "task-assistant" };
	}
	if (update.status === "empty") {
		return { steps: [], directions: [], pending: false, source: "task-assistant", empty: true };
	}
	const items = [...update.directions, ...update.actions];
	return {
		steps: items.map((s) => ({
			text: s.label,
			id: s.id,
			prompt: s.prompt,
		})),
		directions: [],
		pending: false,
		source: "task-assistant",
		items,
	};
}

export function adviceView(slot: AdviceSlot, agentActive: boolean): Predictions | undefined {
	if (!slot.provider || slot.suspended || agentActive) return undefined;
	return predictionsFromUpdate(slot.update, false)
		?? { steps: [], directions: [], pending: false, source: "task-assistant", idle: true };
}

export function nextPredictions(input: {
	enabled: boolean;
	nextModule: boolean;
	agentActive: boolean;
	next: NextV1 | undefined;
	latestTurnId: string | undefined;
	scoringNext: ReadonlySet<string>;
	shown: number;
}): Predictions | undefined {
	if (!input.enabled || !input.nextModule || input.agentActive) return undefined;
	const next = input.next;
	const id = input.latestTurnId;
	if (!next || !id) return undefined;
	const scored = next.steps.some((s) => typeof s.score === "number");
	return {
		steps: next.steps.slice(0, input.shown),
		directions: next.directions,
		pending: input.scoringNext.has(id) && !scored,
		error: next.scoreError,
	};
}

export function pickNextFill(predictions: Predictions | undefined, n: number): string | undefined {
	return predictions?.steps[n - 1]?.text;
}

export function fillItem(predictions: Predictions | undefined, n: number): SuggestionItem | undefined {
	const items = predictions?.items ?? [];
	return items[n - 1];
}

export function pickAdviceItem(predictions: Predictions | undefined, itemId: string): SuggestionItem | undefined {
	return predictions?.items?.find((item) => item.id === itemId);
}

export function selectEvent(key: string, item: SuggestionItem, selectionId: string): TaskAssistantEvent {
	return { type: "select", version: 1, key, itemId: item.id, selectionId };
}

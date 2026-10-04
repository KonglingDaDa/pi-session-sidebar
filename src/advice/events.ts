/** Public versioned EventBus contract: `pi.events` channel `pi-local:task-assistant:v1`. */

export const TASK_ASSISTANT_CHANNEL = "pi-local:task-assistant:v1";
export const TASK_ASSISTANT_EVENT_VERSION = 1 as const;

export type SuggestionKind = "direction" | "action";
export type SuggestionStatus = "pending" | "ready" | "empty" | "failed";
export type HandshakeRole = "provider" | "sidebar";

export interface SuggestionItem {
	id: string;
	kind: SuggestionKind;
	label: string;
	prompt: string;
	/** One short line saying what this rests on (the user's words or a settled decision). Absent when the model gave none. */
	evidence?: string;
}

export interface TaskAssistantHello {
	type: "hello";
	version: 1;
	role: HandshakeRole;
	/** Provider availability; absent on legacy hello means enabled. Sidebar hello omits it. */
	enabled?: boolean;
}

export interface TaskAssistantUpdate {
	type: "update";
	version: 1;
	key: string;
	sessionId: string;
	replyEntryId: string;
	revision: number;
	status: SuggestionStatus;
	directions: SuggestionItem[];
	actions: SuggestionItem[];
	error?: string;
}

export interface TaskAssistantClear {
	type: "clear";
	version: 1;
	key?: string;
	reason: string;
}

/**
 * Read-only push from the timeline owner: the anchor the lower pane must judge against.
 * Sent before the provider generates, never a request. Providers ignore it when absent (fall back to messages only).
 */
export interface TaskAssistantAdviceContext {
	type: "advice-context";
	version: 1;
	sessionId: string;
	/** Exact settled assistant reply; older unscoped v1 pushes are parsed but not used. */
	replyEntryId?: string;
	/** Session goal as the timeline last understood it ("" when unknown). */
	goal: string;
	/** Decisions the user already settled, oldest first ("问：… → 用户选：…" or "定了什么"). */
	decisions: string[];
	/** The user's own recent messages, oldest first. */
	userMessages: string[];
}

/** Next-message texts the upper pane is already showing; the lower pane must not repeat them. */
export interface TaskAssistantCovered {
	type: "advice-covered";
	version: 1;
	sessionId: string;
	/** Exact reply the shown predictions belong to. Empty texts explicitly clear coverage. */
	replyEntryId?: string;
	/** Raw prediction texts (not normalized); the provider normalizes when filtering. */
	texts: string[];
}

/** Sidebar (or command) asks the provider to fill. Fill is not a sent dispatch. */
export interface TaskAssistantSelect {
	type: "select";
	version: 1;
	key: string;
	itemId: string;
	selectionId: string;
}

export type TaskAssistantEvent =
	| TaskAssistantHello
	| TaskAssistantUpdate
	| TaskAssistantClear
	| TaskAssistantSelect
	| TaskAssistantAdviceContext
	| TaskAssistantCovered;

export function suggestionKey(sessionId: string, replyEntryId: string, revision: number): string {
	return `${sessionId}:${replyEntryId}:${revision}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asItem(value: unknown, kind: SuggestionKind): SuggestionItem | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || !value.id.trim()) return undefined;
	if (value.kind !== kind) return undefined;
	if (typeof value.label !== "string" || !value.label.trim()) return undefined;
	if (typeof value.prompt !== "string" || !value.prompt.trim()) return undefined;
	if (value.evidence !== undefined && (typeof value.evidence !== "string" || !value.evidence.trim())) return undefined;
	const evidence = typeof value.evidence === "string" ? value.evidence.trim() : undefined;
	return evidence ? { id: value.id, kind, label: value.label, prompt: value.prompt, evidence } : { id: value.id, kind, label: value.label, prompt: value.prompt };
}

function asItems(value: unknown, kind: SuggestionKind): SuggestionItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: SuggestionItem[] = [];
	for (const row of value) {
		const item = asItem(row, kind);
		if (!item) return undefined;
		out.push(item);
	}
	return out;
}

/** Returns undefined when the payload is not a v1 event on this channel. */
export function parseTaskAssistantEvent(data: unknown): TaskAssistantEvent | undefined {
	if (!isRecord(data) || data.version !== 1 || typeof data.type !== "string") return undefined;
	if (data.type === "hello") {
		if (data.role !== "provider" && data.role !== "sidebar") return undefined;
		if (data.enabled !== undefined && typeof data.enabled !== "boolean") return undefined;
		return { type: "hello", version: 1, role: data.role, ...(typeof data.enabled === "boolean" ? { enabled: data.enabled } : {}) };
	}
	if (data.type === "clear") {
		if (typeof data.reason !== "string" || !data.reason.trim()) return undefined;
		if (data.key !== undefined && typeof data.key !== "string") return undefined;
		return { type: "clear", version: 1, key: data.key, reason: data.reason };
	}
	if (data.type === "advice-context") {
		if (typeof data.sessionId !== "string" || !data.sessionId) return undefined;
		if (typeof data.goal !== "string") return undefined;
		if (!Array.isArray(data.decisions) || !data.decisions.every((d) => typeof d === "string")) return undefined;
		if (!Array.isArray(data.userMessages) || !data.userMessages.every((m) => typeof m === "string")) return undefined;
		if (data.replyEntryId !== undefined && (typeof data.replyEntryId !== "string" || !data.replyEntryId.trim())) return undefined;
		return { type: "advice-context", version: 1, sessionId: data.sessionId, replyEntryId: data.replyEntryId as string | undefined, goal: data.goal, decisions: data.decisions as string[], userMessages: data.userMessages as string[] };
	}
	if (data.type === "advice-covered") {
		if (typeof data.sessionId !== "string" || !data.sessionId) return undefined;
		if (!Array.isArray(data.texts) || !data.texts.every((t) => typeof t === "string")) return undefined;
		if (data.replyEntryId !== undefined && (typeof data.replyEntryId !== "string" || !data.replyEntryId.trim())) return undefined;
		return { type: "advice-covered", version: 1, sessionId: data.sessionId, replyEntryId: data.replyEntryId as string | undefined, texts: data.texts as string[] };
	}
	if (data.type === "select") {
		if (typeof data.key !== "string" || !data.key) return undefined;
		if (typeof data.itemId !== "string" || !data.itemId) return undefined;
		if (typeof data.selectionId !== "string" || !data.selectionId) return undefined;
		return { type: "select", version: 1, key: data.key, itemId: data.itemId, selectionId: data.selectionId };
	}
	if (data.type === "update") {
		if (typeof data.key !== "string" || !data.key) return undefined;
		if (typeof data.sessionId !== "string" || !data.sessionId) return undefined;
		if (typeof data.replyEntryId !== "string" || !data.replyEntryId) return undefined;
		if (!Number.isInteger(data.revision) || (data.revision as number) < 1) return undefined;
		if (data.status !== "pending" && data.status !== "ready" && data.status !== "empty" && data.status !== "failed") return undefined;
		const directions = asItems(data.directions, "direction");
		const actions = asItems(data.actions, "action");
		if (!directions || !actions) return undefined;
		if (data.error !== undefined && typeof data.error !== "string") return undefined;
		return {
			type: "update",
			version: 1,
			key: data.key,
			sessionId: data.sessionId,
			replyEntryId: data.replyEntryId,
			revision: data.revision as number,
			status: data.status,
			directions,
			actions,
			error: data.error,
		};
	}
	return undefined;
}

/**
 * Detached post-reply jobs. `kick` returns immediately; Gemini/Jev never run inside agent_settled.
 * Fill-only v1: selecting writes an empty editor. That is not a sent dispatch.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskAssistantEvent, TaskAssistantUpdate, SuggestionItem } from "./events.ts";
import { suggestionKey } from "./events.ts";
import { cachedPostReply, postReplyCache, type PostReplyCache } from "./postreply-cache.ts";
import { LIMITS } from "./limits.ts";
import {
	assignIds,
	buildJudgeQuestions,
	buildJudgeState,
	buildPostReplyTarget,
	coveredByUpperPane,
	dropCovered,
	generateWithRetry,
	judgeItems,
	POSTREPLY_BUILD,
	stillFresh,
	type AdviceAnchor,
	type GenerateResult,
	type GeneratedSuggestions,
	type PostReplyTarget,
} from "./postreply.ts";
import { callGeminiJson } from "./gemini.ts";
import { sanitizeText } from "./redact.ts";
import { askJev, resolveEndpoint, DEFAULT_JEV_URL } from "../shared/jev-client.ts";

export interface PostReplySink {
	emit(event: TaskAssistantEvent): void;
	notify(message: string, level?: "info" | "warning" | "error"): void;
	persist?(cache: PostReplyCache): void;
}

export interface FillUi {
	isIdle(): boolean;
	hasPendingMessages(): boolean;
	editorText(): string;
	setEditorText(text: string): void;
	busyDialog?: boolean;
}

interface Job {
	revision: number;
	target: PostReplyTarget;
	abort: AbortController;
	/** Diagnostic counts/scores only; retained for this job, never persisted. */
	candidateCount?: number;
	scores?: { label: string; score: number }[];
}

const FILLED_MAX = 64;

/** How long a pushed anchor stays usable for the session it was pushed for. */
const ANCHOR_TTL_MS = 30 * 60 * 1000;

export class PostReplyController {
	private revision = 0;
	private job: Job | undefined;
	private snapshot: TaskAssistantUpdate | undefined;
	private cacheCtx: ExtensionContext | undefined;
	/** Accepted fills only, oldest first. Blocked attempts are not recorded. */
	private readonly filledSelect: string[] = [];
	private sidebarPresent = false;
	private enabled = true;
	/** Last goal anchor pushed by the timeline owner, with the time it arrived. Never persisted. */
	private anchor: { sessionId: string; value: AdviceAnchor; at: number } | undefined;
	/** Texts the upper prediction pane is currently showing (raw, not normalized) and the session they belong to. */
	private covered: { sessionId: string; replyEntryId: string; texts: string[] } | undefined;
	/** How many candidates the last run dropped because the upper pane already showed them. Diagnostic only. */
	private lastDropped = 0;
	private readonly sink: PostReplySink;

	constructor(sink: PostReplySink) {
		this.sink = sink;
	}

	private alreadyFilled(id: string): boolean {
		return this.filledSelect.includes(id);
	}

	private rememberFilled(id: string): void {
		if (this.filledSelect.includes(id)) return;
		this.filledSelect.push(id);
		if (this.filledSelect.length > FILLED_MAX) this.filledSelect.shift();
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		this.helloProvider();
	}

	helloProvider(): void {
		this.sink.emit({ type: "hello", version: 1, role: "provider", enabled: this.enabled });
		if (this.enabled && this.snapshot) this.sink.emit(this.snapshot);
	}

	onBus(data: TaskAssistantEvent, ui?: FillUi): void {
		if (data.type === "hello" && data.role === "sidebar") {
			this.sidebarPresent = true;
			this.helloProvider();
			return;
		}
		if (data.type === "select" && ui) this.fill(data.key, data.itemId, data.selectionId, ui);
	}

	// Read-only timeline pushes, independently scoped to a settled reply.
	onAdviceContext(data: { sessionId: string; replyEntryId?: string; goal: string; decisions: string[]; userMessages: string[] }): void {
		this.setAnchor(data.sessionId, { sessionId: data.sessionId, replyEntryId: data.replyEntryId, goal: data.goal, decisions: [...data.decisions], userMessages: [...data.userMessages] });
	}

	onAdviceCovered(data: { sessionId: string; replyEntryId?: string; texts: string[] }): void {
		this.setCovered(data.sessionId, data.texts, data.replyEntryId);
	}

	abort(reason: string): void {
		this.job?.abort.abort();
		this.job = undefined;
		this.snapshot = undefined;
		this.cacheCtx = undefined;
		this.anchor = undefined;
		this.covered = undefined;
		this.lastDropped = 0;
		this.sink.emit({ type: "clear", version: 1, reason });
	}

	/** Restore completed UI state only. A missing cache never triggers a model request on entry. */
	restore(ctx: ExtensionContext): boolean {
		const cached = cachedPostReply(ctx.sessionManager.getSessionId(), ctx.sessionManager.getBranch());
		if (!cached) return false;
		this.job?.abort.abort();
		this.job = undefined;
		this.cacheCtx = ctx;
		this.snapshot = cached;
		this.revision = Math.max(this.revision, cached.revision);
		this.applyLateCovered();
		this.helloProvider(); // Replays snapshot; safe in either extension load order.
		return true;
	}

	private saveSnapshot(): void {
		const ctx = this.cacheCtx;
		const snap = this.snapshot;
		if (!ctx || !snap || !this.sink.persist) return;
		const branch = ctx.sessionManager.getBranch();
		if (ctx.sessionManager.getSessionId() !== snap.sessionId) return;
		const cache = postReplyCache(snap, branch);
		if (!cache) return;
		try { this.sink.persist(cache); }
		catch (error) {
			this.sink.notify(`回复后建议缓存没存上：${sanitizeText(error instanceof Error ? error.message : String(error), 180)}`, "warning");
		}
	}

	/** Must return without awaiting model calls. Explicit retry bypasses the completed cache. */
	kick(ctx: ExtensionContext, force = false): void {
		if (!force && this.restore(ctx)) return;
		this.cacheCtx = ctx;
		const sessionId = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getBranch() as unknown[];
		const target = buildPostReplyTarget(sessionId, entries);
		this.job?.abort.abort();
		if (!target) {
			this.abort("no-reply");
			return;
		}
		target.anchor = this.usableAnchor(sessionId, target.replyEntryId);
		if (this.covered?.sessionId === sessionId && this.covered.replyEntryId === target.replyEntryId) target.covered = [...this.covered.texts];
		this.lastDropped = 0;
		this.revision += 1;
		const abort = new AbortController();
		const job: Job = { revision: this.revision, target, abort };
		this.job = job;
		const pending = this.updateOf(job, "pending", [], []);
		this.snapshot = pending;
		this.sink.emit(pending);
		// Start after this event dispatch so synchronous timeline pushes work in either load order.
		setImmediate(() => {
			void Promise.resolve().then(() => {
				if (this.live(ctx, job)) return this.run(ctx, job);
			}).catch((error) => {
				if (job.abort.signal.aborted || this.job !== job) return;
				this.fail(job, error instanceof Error ? error.message : String(error));
			});
		});
	}

	/** The pushed anchor, but only for this session and not older than ANCHOR_TTL_MS. */
	private usableAnchor(sessionId: string, replyEntryId: string): AdviceAnchor | undefined {
		const a = this.anchor;
		if (!a || a.sessionId !== sessionId || a.value.replyEntryId !== replyEntryId) return undefined;
		if (Date.now() - a.at > ANCHOR_TTL_MS) return undefined;
		return a.value;
	}

	/** Timeline owner pushed the goal anchor: the lower pane judges against this, not the last reply. */
	setAnchor(sessionId: string, value: AdviceAnchor): void {
		if (!value.replyEntryId) return;
		if (this.job && (this.job.target.sessionId !== sessionId || this.job.target.replyEntryId !== value.replyEntryId)) return;
		this.anchor = { sessionId, value, at: Date.now() };
		if (this.job) this.job.target.anchor = value;
	}

	/** Upper pane told us which prediction texts are on screen; the lower pane yields to them. */
	setCovered(sessionId: string, texts: readonly string[], replyEntryId?: string): void {
		if (this.job && (this.job.target.sessionId !== sessionId || (replyEntryId && this.job.target.replyEntryId !== replyEntryId))) return;
		if (!replyEntryId) {
			// Legacy nonempty pushes have no safe scope. Empty pushes can invalidate coverage.
			if (texts.some((t) => t.trim())) return;
			this.covered = undefined;
			if (this.job) this.job.target.covered = [];
			return;
		}
		this.covered = { sessionId, replyEntryId, texts: texts.filter((t) => t.trim()) };
		this.applyLateCovered();
	}

	/**
	 * Publish-time yield: predictions land 10–25s after the reply, so the lower pane may already have answered.
	 * A late `covered` push therefore has to reach both the running job and a live snapshot. Returns true when dropped.
	 */
	private applyLateCovered(): boolean {
		const covered = this.covered;
		if (!covered) return false;
		// Empty coverage must reach the job too; otherwise a cleared prediction still suppresses candidates.
		if (this.job && this.job.target.sessionId === covered.sessionId && this.job.target.replyEntryId === covered.replyEntryId) this.job.target.covered = [...covered.texts];
		const snap = this.snapshot;
		if (!covered.texts.length || !snap || snap.status !== "ready" || snap.sessionId !== covered.sessionId || snap.replyEntryId !== covered.replyEntryId) return false;
		const all = [...snap.directions, ...snap.actions];
		if (!all.length) return false;
		const kept = all.filter((item) => !coveredByUpperPane(item.label, item.prompt, covered.texts));
		if (kept.length === all.length) return false;
		this.lastDropped += all.length - kept.length;
		if (!kept.length) {
			this.publishEmpty();
			return true;
		}
		this.snapshot = { ...snap, directions: kept.filter((i) => i.kind === "direction"), actions: kept.filter((i) => i.kind === "action") };
		this.saveSnapshot();
		this.sink.emit(this.snapshot);
		return true;
	}

	private publishEmpty(): void {
		const snap = this.snapshot;
		if (!snap) return;
		this.snapshot = { ...snap, status: "empty", directions: [], actions: [] };
		this.saveSnapshot();
		this.sink.emit(this.snapshot);
	}

	statusLine(): string {
		const s = this.snapshot;
		const mark = POSTREPLY_BUILD;
		if (!s) return `回复后建议：无 · ${mark}`;
		if (s.status === "pending") return `回复后建议：生成中 · ${mark}`;
		if (s.status === "failed") return `回复后建议：未判定（${s.error ?? "失败"}） · ${mark}`;
		if (s.status === "empty") {
			const scores = this.job?.scores;
			const dropped = this.lastDropped ? `，其中 ${this.lastDropped} 条与上半区预测重复已让位` : "";
			if (scores?.length) {
				const best = Math.max(...scores.map((row) => row.score)).toFixed(2);
				const detail = scores.map((row) => `${row.label} ${row.score.toFixed(2)}`).join("；");
				return `回复后建议：无过线项（候选 ${scores.length} 条，最高 ${best}，门槛 ${LIMITS.postReplyScoreMin}${dropped}） · ${mark}。候选分数：${detail}`;
			}
			const reason = this.job?.candidateCount === 0 ? "模型未生成候选或全被上半区覆盖，未调用 Jev" : "无过线项";
			return `回复后建议：${reason}${dropped} · ${mark}`;
		}
		return `回复后建议：方向 ${s.directions.length} · 动作 ${s.actions.length} · ${mark}`;
	}

	current(): TaskAssistantUpdate | undefined {
		return this.snapshot;
	}

	ownedArea(): boolean {
		return true;
	}

	sidebarHeard(): boolean {
		return this.sidebarPresent;
	}

	fill(key: string, itemId: string, selectionId: string, ui: FillUi): "filled" | "ignored" | "blocked" {
		if (this.alreadyFilled(selectionId)) return "ignored";
		const snap = this.snapshot;
		if (!snap || snap.key !== key) {
			this.sink.notify("这条建议已经过期", "info");
			return "blocked";
		}
		const item = [...snap.directions, ...snap.actions].find((i) => i.id === itemId);
		if (!item) {
			this.sink.notify("没有这条建议", "info");
			return "blocked";
		}
		if (!ui.isIdle() || ui.hasPendingMessages() || ui.busyDialog) {
			this.sink.notify("当前有进行中的提问或权限框，未填入、未代答", "warning");
			return "blocked";
		}
		if (ui.editorText().trim()) {
			this.sink.notify(`输入框里已经有字，没覆盖。${item.kind === "direction" ? "方向" : "动作"}：${item.label}`, "info");
			return "blocked";
		}
		ui.setEditorText(item.prompt);
		this.rememberFilled(selectionId);
		return "filled";
	}

	fillIndex(n: number, ui: FillUi): "filled" | "ignored" | "blocked" {
		const snap = this.snapshot;
		if (!snap) {
			this.sink.notify("现在没有回复后建议", "info");
			return "blocked";
		}
		const items = [...snap.directions, ...snap.actions];
		const item = items[n - 1];
		if (!item) {
			this.sink.notify(`没有第 ${n} 条建议`, "info");
			return "blocked";
		}
		return this.fill(snap.key, item.id, `${snap.key}:${item.id}:${this.revision}:${n}`, ui);
	}

	private async run(ctx: ExtensionContext, job: Job): Promise<void> {
		const raw = await this.generate(ctx, job);
		if (!this.live(ctx, job)) return;
		if (raw.kind === "failed") {
			this.fail(job, raw.error);
			return;
		}
		let keptValue: GeneratedSuggestions | undefined;
		if (raw.kind !== "empty") {
			const afterDrop = await this.yieldToUpperPane(raw.value, job);
			if (afterDrop.kind === "empty") {
				job.candidateCount = 0;
				this.publish(job, this.updateOf(job, "empty", [], []));
				return;
			}
			if (afterDrop.kind === "failed") {
				this.fail(job, afterDrop.error);
				return;
			}
			keptValue = afterDrop.value;
		}
		if (!keptValue) {
			job.candidateCount = 0;
			this.publish(job, this.updateOf(job, "empty", [], []));
			return;
		}
		const items = assignIds(keptValue, job.revision);
		job.candidateCount = items.length;
		const judged = await this.judge(items, job);
		if (!this.live(ctx, job)) return;
		if (judged.kind === "failed") {
			this.fail(job, judged.error);
			return;
		}
		if (judged.kind === "empty") {
			this.publish(job, this.updateOf(job, "empty", [], []));
			return;
		}
		this.publish(job, this.updateOf(job, "ready", judged.directions, judged.actions));
	}

	private async yieldToUpperPane(value: GeneratedSuggestions, job: Job): Promise<GenerateResult> {
		const covered = job.target.covered ?? [];
		if (!covered.length) return { kind: "ok", value };
		const { kept, dropped } = dropCovered(value, covered);
		this.lastDropped += dropped.length;
		if (!kept.directions.length && !kept.actions.length) return { kind: "empty" };
		return { kind: "ok", value: kept };
	}

	private async generate(ctx: ExtensionContext, job: Job): Promise<GenerateResult> {
		return generateWithRetry(
			job.target,
			async (system, user, thinking, timeoutMs) => {
				const r = await callGeminiJson(ctx.modelRegistry, system, user, job.abort.signal, timeoutMs, thinking);
				return { text: r.text, thinking: r.thinking, error: r.error, stopReason: r.stopReason };
			},
			job.abort.signal,
		);
	}

	private async judge(items: SuggestionItem[], job: Job): Promise<ReturnType<typeof judgeItems>> {
		try {
			const endpoint = resolveEndpoint(DEFAULT_JEV_URL);
			const reply = await askJev(
				endpoint,
				"jev-latest",
				buildJudgeState(job.target, items),
				buildJudgeQuestions(items, job.target.waiting),
				LIMITS.jevTimeoutMs,
				job.abort.signal,
			);
			const judged = judgeItems(items, reply.answers);
			if (judged.kind !== "failed") {
				job.scores = items.map((item) => ({
					label: item.label,
					score: (reply.answers[item.id] as { score: number }).score,
				}));
			}
			return judged;
		} catch (error) {
			if (job.abort.signal.aborted) return { kind: "failed", error: "aborted" };
			return { kind: "failed", error: sanitizeText(error instanceof Error ? error.message : String(error), 180) };
		}
	}

	private live(ctx: ExtensionContext, job: Job): boolean {
		if (this.job !== job || job.abort.signal.aborted) return false;
		const sessionId = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getBranch() as unknown[];
		return stillFresh(job.target, sessionId, entries);
	}

	private fail(job: Job, error: string): void {
		if (error === "aborted" || this.job !== job) return;
		const msg = sanitizeText(error, 180) || "未判定";
		this.publish(job, this.updateOf(job, "failed", [], [], msg));
		this.sink.notify(`回复后建议未判定：${msg}`, "warning");
	}

	private publish(job: Job, update: TaskAssistantUpdate): void {
		if (this.job !== job || job.abort.signal.aborted) return;
		// No await between this last filter and emit: includes predictions arriving during Jev judgment.
		if (update.status === "ready") {
			const covered = job.target.covered ?? [];
			const keep = (items: SuggestionItem[]) => items.filter((item) => !coveredByUpperPane(item.label, item.prompt, covered));
			const directions = keep(update.directions);
			const actions = keep(update.actions);
			this.lastDropped += update.directions.length + update.actions.length - directions.length - actions.length;
			update = { ...update, directions, actions, status: directions.length || actions.length ? "ready" : "empty" };
		}
		this.snapshot = update;
		this.saveSnapshot();
		this.sink.emit(update);
	}

	private updateOf(
		job: Job,
		status: TaskAssistantUpdate["status"],
		directions: SuggestionItem[],
		actions: SuggestionItem[],
		error?: string,
	): TaskAssistantUpdate {
		return {
			type: "update",
			version: 1,
			key: suggestionKey(job.target.sessionId, job.target.replyEntryId, job.revision),
			sessionId: job.target.sessionId,
			replyEntryId: job.target.replyEntryId,
			revision: job.revision,
			status,
			directions,
			actions,
			error,
		};
	}
}

export function fillUiFrom(ctx: ExtensionContext, busyDialog = false): FillUi {
	return {
		isIdle: () => ctx.isIdle(),
		hasPendingMessages: () => ctx.hasPendingMessages(),
		editorText: () => ctx.ui.getEditorText(),
		setEditorText: (text) => ctx.ui.setEditorText(text),
		busyDialog,
	};
}

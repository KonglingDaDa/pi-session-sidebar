/**
 * session-timeline — a right-hand sidebar listing what this Pi window has done, phase by phase: what you wanted,
 * what came of it, how complete Jev thinks it is, what might come next, and how each context compaction kept
 * (or lost) the goal. See README.md for scope and architecture.
 *
 * Registered by the package entry in src/index.ts.
 *
 * Scheduling (INTENT "调度"): one background Gemini queue, one request at a time, re-picked after every request:
 * interim summary of a running turn at a mid-turn compaction > just-finished turns > backfill batches (oldest
 * first) > gap re-runs and retries. Jev calls follow their Gemini result through a separate limiter (3 at a time)
 * and never block the queue. Records are written only when Pi is idle, only onto the branch they belong to.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { copyToClipboard, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type BatchTurnOutput,
	COMPACTION_ENTRY,
	type CompactionCheckV1,
	MODULE_NAMES,
	type ModuleName,
	type NextV1,
	STEP_ENTRY,
	type StepStatus,
	type TimelineConfig,
	type TimelineStep,
} from "./contracts.ts";
import {
	actionList,
	buildView,
	collectRecords,
	computeStats,
	type Entry,
	entryTime,
	extractGoalSection,
	formatClock,
	isContinueMessage,
	keptMessages,
	type PhaseLine,
	phaseList,
	phasesBefore,
	previousContext,
	compactionProblems,
	isEmptyTurn,
	redact,
	scoreFlags,
	scrubNextSteps,
	splitTurns,
	stepLine,
	textOf,
	type TimelineView,
	type Turn,
	turnDecisions,
	turnText,
	turnUntil,
	userMessagesBefore,
} from "./core.ts";
import { checkCompaction, scoreNext, scoreTurn } from "./jev.ts";
import {
	adviceAnchorFromBranch,
	adviceContextEvent,
	adviceCoveredEvent,
	EMPTY_ADVICE_SLOT,
	TASK_ASSISTANT_CHANNEL,
	adviceView,
	applyAdviceEvent,
	nextPredictions,
	pickNextFill,
	shouldGenerateNext,
	type AdviceSlot,
} from "./assistant-owner.ts";
import { latestSettledReply } from "../advice/postreply.ts";
import { CIRCLED, clampWidth, JEV_UNSURE, type Predictions, purple, type SidebarModel, SplitHost, WIDTH_STEP } from "./sidebar.ts";
import { batchLabels, briefGoal, summarizeBatch, summarizeTurn, type TurnInput } from "./summarize.ts";

import { defaultSummaryModel } from "../shared/models.ts";

const WIDGET_KEY = "session-timeline";
const AGENT_ROOT = process.env.PI_CODING_AGENT_DIR?.trim()
	? path.resolve(process.env.PI_CODING_AGENT_DIR.trim().replace(/^~(?=$|\/)/, os.homedir()))
	: path.join(os.homedir(), ".pi", "agent");
const CONFIG_PATH = path.join(AGENT_ROOT, "session-timeline.json");
/** Newest kept-verbatim messages passed to Jev after a compaction. */
const KEPT_MESSAGES = 8;
/** Jev requests in flight at once (turn scores, next-step ranking, compaction checks). */
const JEV_CONCURRENCY = 3;
const SHOWN_PREDICTIONS = 3;
/** Rough USD per backfilled turn (its share of a Gemini batch + one Jev score), from the v2 estimate ($0.1–0.2 / 60 turns). */
const COST_PER_TURN = { low: 0.0017, high: 0.0033 };
/** The batch prompt labels turns T1…T8. */
const BATCH_MAX = 8;
/** User messages kept in the goal anchor pushed to the lower pane. */

/** Settings layout version; files from before v2 get the new small-print defaults once. */
const CONFIG_VERSION = 2;
/** Code-counted small print: off by default since v2 (you found it not useful); each can be turned back on. */
const SMALL_PRINT: readonly ModuleName[] = ["duration", "tools", "diff", "agents", "errors", "commits", "cost"];

const MODULE_LABELS: Record<ModuleName, string> = {
	time: "每轮开始时间",
	duration: "每轮耗时（小字，默认关）",
	tools: "工具次数（小字，默认关）",
	diff: "增删行数和文件数（小字，默认关）",
	agents: "子代理（小字，默认关）",
	errors: "出错次数（小字，默认关）",
	commits: "git 提交（小字，默认关）",
	cost: "本轮花费（默认关，底栏已有总额）",
	goal: "会话目标",
	compaction: "压缩分隔线和一致性打分",
	score: "每轮完成度（Jev）",
	next: "下一步预测（紫色分支，alt+1~3 填入）",
	hints: "顶部图例和底部操作提示",
};

function defaultConfig(): TimelineConfig {
	return {
		version: CONFIG_VERSION,
		enabled: true,
		width: 42,
		modules: {
			time: true,
			duration: false,
			tools: false,
			diff: false,
			agents: false,
			errors: false,
			commits: false,
			cost: false,
			goal: true,
			compaction: true,
			score: true,
			next: true,
			hints: true,
		},
		summary: { ...defaultSummaryModel(), thinking: "high", timeoutMs: 90000 },
		jev: { enabled: true, timeoutMs: 12000 },
		backfill: { auto: true, maxTurns: 60, batchSize: 8 },
	};
}

const intIn = (v: unknown, lo: number, hi: number, fallback: number) =>
	typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : fallback;

function loadConfig(): { config: TimelineConfig; error?: string } {
	const config = defaultConfig();
	let text: string;
	try {
		text = fs.readFileSync(CONFIG_PATH, "utf-8");
	} catch {
		return { config }; // first run: defaults
	}
	try {
		const raw = JSON.parse(text) as Partial<TimelineConfig>;
		if (typeof raw.enabled === "boolean") config.enabled = raw.enabled;
		if (typeof raw.width === "number") config.width = clampWidth(raw.width);
		const old = raw.version !== CONFIG_VERSION; // saved before v2: its small-print switches were just the old defaults
		for (const m of MODULE_NAMES) {
			if (old && SMALL_PRINT.includes(m)) continue;
			if (typeof raw.modules?.[m] === "boolean") config.modules[m] = raw.modules[m];
		}
		if (raw.summary && typeof raw.summary === "object") config.summary = { ...config.summary, ...raw.summary };
		if (raw.jev && typeof raw.jev === "object") config.jev = { ...config.jev, ...raw.jev };
		const b = raw.backfill;
		if (b && typeof b === "object") {
			if (typeof b.auto === "boolean") config.backfill.auto = b.auto;
			config.backfill.maxTurns = intIn(b.maxTurns, 0, 1000, config.backfill.maxTurns);
			config.backfill.batchSize = intIn(b.batchSize, 1, BATCH_MAX, config.backfill.batchSize);
		}
		return { config };
	} catch (error) {
		return { config, error: `${CONFIG_PATH} 读不了，用默认设置：${errorText(error)}` };
	}
}

function saveConfig(config: TimelineConfig): string | undefined {
	try {
		const tmp = `${CONFIG_PATH}.tmp-${process.pid}`;
		fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
		fs.renameSync(tmp, CONFIG_PATH);
		return undefined;
	} catch (error) {
		return errorText(error);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function head(text: string, max: number): string {
	const t = text.replace(/\s+/g, " ").trim();
	return [...t].length > max ? `${[...t].slice(0, max - 1).join("")}…` : t;
}

function toNext(next: readonly string[], directions: readonly string[]): NextV1 | undefined {
	const steps = scrubNextSteps(next);
	return steps.length || directions.length ? { steps: steps.map((text) => ({ text })), directions: [...directions] } : undefined;
}

/** Records of the turns before `fromId`, in branch order. */
function recordsBefore(turns: readonly Turn[], steps: ReadonlyMap<string, TimelineStep>, fromId: string): TimelineStep[] {
	const out: TimelineStep[] = [];
	for (const t of turns) {
		if (t.fromId === fromId) break;
		const s = steps.get(t.fromId);
		if (s && !isEmptyTurn(t)) out.push(s); // old records of unanswered turns are hidden, and are no context either
	}
	return out;
}

/** The last answered turn before `idx` (unanswered ones never get a record), or undefined. */
function answeredBefore(turns: readonly Turn[], idx: number): Turn | undefined {
	for (let j = idx - 1; j >= 0; j--) if (!isEmptyTurn(turns[j])) return turns[j];
	return undefined;
}

/** At most `max` tasks at once; a finishing task hands its slot straight to the next waiter. */
class Limiter {
	private active = 0;
	private readonly waiting: (() => void)[] = [];
	constructor(private readonly max: number) {}
	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active < this.max) this.active++;
		else await new Promise<void>((resolve) => this.waiting.push(resolve));
		try {
			return await fn();
		} finally {
			const next = this.waiting.shift();
			if (next) next();
			else this.active--;
		}
	}
}

type Fields = Omit<BatchTurnOutput, "id">;
type Job =
	| { kind: "interim"; turn: Turn; token: number }
	| { kind: "turn"; turn: Turn; reason: "live" | "gap" | "retry" | "grown" }
	| { kind: "batch"; turns: Turn[] }
	| { kind: "brief"; check: CompactionCheckV1 };

class Timeline implements SidebarModel {
	private ctx: ExtensionContext;
	private readonly host: SplitHost;
	/** User messages that existed when the plugin started: their turns are backfill, not live. */
	private readonly startIds = new Set<string>();
	private readonly pendingSteps = new Map<string, TimelineStep>();
	private readonly pendingChecks = new Map<string, CompactionCheckV1>();
	/** Interim summaries of the running turn (mid-turn compaction). Memory only, never written. */
	private readonly interim = new Map<string, TimelineStep>();
	private interimToken = 0;
	private interimJob?: { fromId: string; compactionId: string; token: number };
	private readonly checking = new Set<string>();
	private readonly checkTried = new Set<string>();
	/** Compactions whose Chinese goal gist was already asked for this session (success or not). */
	private readonly briefTried = new Set<string>();
	/** Jev jobs in flight per turn; a pending step is not written until its count drops to 0. */
	private readonly scoring = new Map<string, number>();
	private readonly scoringNext = new Set<string>();
	private readonly jev = new Limiter(JEV_CONCURRENCY);
	private readonly retryIds = new Set<string>();
	private backfillAll = false;
	/** `/timeline backfill` asked for the whole branch (kept after a redo finishes). */
	private backfillAllRequested = false;
	/** `/timeline redo`: turns to summarize and score again with the current prompts (their old records stay until replaced). */
	private readonly redoIds = new Set<string>();
	private bf?: { done: number; total: number };
	private cached: TimelineView = buildView([]);
	private running = false;
	private agentActive = false;
	private warnedSummary = false;
	private warnedJev = false;
	private lastMs = 0;
	private interimFailures = 0;
	private disposed = false;
	/** Post-reply advice only. Never replaces conversation next predictions. */
	private adviceSlot: AdviceSlot = EMPTY_ADVICE_SLOT;

	constructor(
		private readonly pi: ExtensionAPI,
		ctx: ExtensionContext,
		private readonly cfg: TimelineConfig,
	) {
		this.ctx = ctx;
		this.host = new SplitHost(this, (reason) => {
			this.notify(`时间线侧栏挂不上，改成在输入框下方显示最近 3 轮和预测：${reason}`, "warning");
		});
	}

	// ---------- SidebarModel ----------
	view(): TimelineView {
		return this.cached;
	}
	config(): TimelineConfig {
		return this.cfg;
	}
	busy() {
		return { summarizing: this.running, checking: this.checking, backfill: this.bf, agent: this.agentActive };
	}
	/** Predictions of the latest turn; none while the assistant is answering or when you switched the timeline off. */
	predictions(): Predictions | undefined {
		return nextPredictions({
			enabled: this.cfg.enabled,
			nextModule: this.cfg.modules.next,
			agentActive: this.agentActive,
			next: this.cached.next,
			latestTurnId: this.cached.latestTurnId,
			scoringNext: this.scoringNext,
			shown: SHOWN_PREDICTIONS,
		});
	}

	/** Goal-driven post-reply advice for the lower pane. Independent of predictions(). */
	advice(): Predictions | undefined {
		if (!this.cfg.enabled) return undefined;
		return adviceView(this.adviceSlot, this.agentActive);
	}

	/**
	 * The anchor the lower pane must judge against: the session goal the timeline last understood, the
	 * decisions the user settled (newest last), and the user's own recent words.
	 * Read from the branch, not from `cached`, so it is right at agent_settled even before this turn's summary lands.
	 */
	adviceAnchor(): ReturnType<typeof adviceAnchorFromBranch> {
		const branch = this.branch();
		return adviceAnchorFromBranch(branch, this.records(branch), this.cached.goal);
	}

	/** Tell the lower pane which prediction texts are on screen. Called when the prediction view actually changes. */
	private broadcastCovered(): void {
		const sessionId = this.ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const p = this.predictions();
		const texts = p && p.source !== "task-assistant" ? [...p.steps.map((s) => s.text), ...p.directions] : [];
		const event = adviceCoveredEvent(sessionId, texts, latestSettledReply(this.branch())?.replyEntryId);
		this.pi.events.emit(TASK_ASSISTANT_CHANNEL, event);
	}

	onAssistantEvent(data: unknown): void {
		const next = applyAdviceEvent(this.adviceSlot, data);
		if (next.provider === this.adviceSlot.provider && next.update === this.adviceSlot.update && next.suspended === this.adviceSlot.suspended) return;
		this.adviceSlot = next;
		this.refresh();
	}

	async copy(text: string): Promise<boolean> {
		try {
			await copyToClipboard(text);
			return true;
		} catch (error) {
			this.notify(`复制失败：${errorText(error)}`, "warning");
			return false;
		}
	}

	setWidth(width: number, persist: boolean): void {
		const next = clampWidth(width);
		if (next !== this.cfg.width) {
			this.cfg.width = next;
			this.host.sync();
			this.host.requestRender();
		}
		if (persist) this.persist();
	}

	// ---------- lifecycle ----------
	start(): void {
		for (const e of this.ctx.sessionManager.getEntries() as Entry[]) {
			if (e.type === "message" && e.id && e.message?.role === "user") this.startIds.add(e.id);
		}
		this.refresh();
		this.ctx.ui.setWidget(WIDGET_KEY, (tui: TUI, theme: Theme) => this.anchor(tui, theme), { placement: "belowEditor" });
		this.kick(); // backfill the latest turns of an old session
	}

	dispose(): void {
		if (this.disposed) return;
		this.flush(true);
		this.disposed = true;
		this.host.dispose();
		try {
			this.ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// UI already torn down.
		}
	}

	use(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	onAgentStart(ctx: ExtensionContext): void {
		this.use(ctx);
		this.agentActive = true; // predictions vanish the moment you send
		this.refresh();
	}

	onSettled(ctx: ExtensionContext): void {
		this.use(ctx);
		this.agentActive = false;
		this.interimToken++; // any interim still in flight is stale now
		this.interimJob = undefined;
		this.interim.clear();
		this.flush();
		this.refresh();
		this.pushAdviceAnchor(ctx);
		this.kick();
	}

	/**
	 * Push the goal anchor before the lower pane generates. Sent even when the timeline is switched off:
	 * the anchor is a read-only goal statement, and without it the lower pane falls back to guessing from the last reply.
	 */
	private pushAdviceAnchor(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId();
		if (!sessionId) return;
		const anchor = this.adviceAnchor();
		if (!anchor) return;
		this.pi.events.emit(TASK_ASSISTANT_CHANNEL, adviceContextEvent(sessionId, anchor.goal, anchor.decisions, anchor.userMessages, anchor.replyEntryId));
		this.broadcastCovered();
	}

	onTree(ctx: ExtensionContext): void {
		this.use(ctx);
		this.flush();
		this.refresh();
		this.kick(); // the queue re-picks from the new branch
	}

	/** Zero-height widget below the editor: hands us the TUI, re-checks the split, and is the fallback display. */
	private anchor(tui: TUI, theme: Theme): Component & { dispose(): void } {
		this.host.attach(tui, theme);
		return {
			render: (width: number) => {
				this.host.checkRoot();
				if (!this.cfg.enabled || this.host.wouldShow()) return [];
				return this.fallbackLines(theme, width);
			},
			invalidate() {},
			dispose: () => this.host.restore(),
		};
	}

	/** Shown only when the sidebar cannot be: not fullscreen, terminal too narrow, or the split broke. */
	private fallbackLines(theme: Theme, width: number): string[] {
		const steps: TimelineStep[] = [];
		for (const item of this.cached.items) if (item.kind === "phase") steps.push(...item.steps);
		const pred = this.predictions();
		const advice = this.advice();
		if (!steps.length && !pred && !advice) return [];
		const note = this.host.broken ? "侧栏不可用" : !this.host.canSplit() ? "全屏模式下显示为侧栏" : "终端太窄，侧栏已隐藏";
		const lines = [theme.fg("dim", `时间线（${note}，/timeline status 查看）`)];
		const now = this.cached.lastStep?.now;
		if (now && !this.agentActive) lines.push(`${theme.fg("dim", "现在")} ${now}`);
		const icon: Record<StepStatus, string> = {
			done: theme.fg("success", "✓"),
			blocked: theme.fg("error", "✗"),
			waiting_user: theme.fg("warning", "?"),
			in_progress: theme.fg("accent", "▶"),
		};
		for (const s of steps.slice(-3)) {
			const f = this.cfg.modules.score ? scoreFlags(s.score) : { offIntent: false, notDone: false };
			const flag = `${f.offIntent ? theme.fg("warning", " ⚠偏题") : ""}${f.notDone ? theme.fg("error", " ⚠没做完") : ""}`;
			const result = s.summary ? theme.fg("mdLink", ` → ${s.summary}`) : "";
			const decided = s.decisions?.length ? theme.fg("accent", ` ◆${s.decisions.length}`) : "";
			lines.push(`${theme.fg("dim", formatClock(s.startedAt))} ${icon[s.status]} ${theme.fg("text", s.intent)}${flag}${result}${decided}`);
		}
		if (pred?.steps.length || pred?.directions.length || pred?.pending || pred?.error) {
			const state = pred.pending ? "打分中…" : pred.error ? "未打分" : "下一句预测";
			lines.push(`${purple("╰┄")} ${purple("预测下一步")} ${theme.fg("dim", `${state} · alt+1~3 填入`)}`);
			pred.steps.forEach((s, i) => {
				const pct = typeof s.score === "number" ? `${purple(`${Math.round(s.score * 100)}%`)} ` : "";
				const unsure = typeof s.confidence === "number" && s.confidence < JEV_UNSURE ? theme.fg("dim", "?") : "";
				lines.push(`   ${purple(CIRCLED[i] ?? "·")} ${theme.fg("dim", "下一句")} ${pct}${s.text}${unsure}`);
			});
			if (pred.directions.length) {
				lines.push(`${purple("╰┄")} ${purple("预测下一步执行方向")}`);
				for (const d of pred.directions) lines.push(`   ${purple("◇")} ${theme.fg("dim", "执行方向")} ${d}`);
			}
		}
		if (advice) {
			const state = advice.idle ? "暂无缓存" : advice.pending ? "生成中…" : advice.error ? "未判定" : advice.empty ? "无过线项" : "点选复制";
			lines.push(`${theme.fg("dim", "┄")} ${theme.fg("accent", "回复后建议")} ${theme.fg("dim", state)}`);
			if (advice.idle) lines.push(theme.fg("dim", "   本轮回复结束后更新建议"));
			if (advice.error && !advice.items?.length) lines.push(`   ${theme.fg("warning", advice.error)}`);
			for (const it of advice.items ?? []) {
				const tag = it.kind === "direction" ? "目标方向" : "建议动作";
				lines.push(`   ${theme.fg("dim", tag)} ${it.label}`);
			}
		}
		return lines.map((l) => truncateToWidth(l, width, ""));
	}

	private branch(): Entry[] {
		return this.ctx.sessionManager.getBranch() as Entry[];
	}

	/** Final records (stored + not yet written), without interim summaries. */
	private records(branch: readonly Entry[]): Map<string, TimelineStep> {
		return collectRecords(branch, [...this.pendingSteps.values()]).steps;
	}

	refresh(): void {
		if (this.disposed) return;
		try {
			this.cached = buildView(this.branch(), [...this.pendingSteps.values()], [...this.pendingChecks.values()], [...this.interim.values()]);
		} catch (error) {
			this.notify(`时间线重建失败：${errorText(error)}`, "error");
		}
		this.host.requestRender();
		this.broadcastCovered();
	}

	private notify(message: string, level: "info" | "warning" | "error"): void {
		try {
			this.ctx.ui.notify(message, level);
		} catch {
			// UI gone.
		}
	}

	private persist(): void {
		const error = saveConfig(this.cfg);
		if (error) this.notify(`时间线设置没存上：${error}`, "warning");
	}

	/**
	 * Write in-memory results once Pi is idle, only onto the branch they belong to (else drop them).
	 * A step whose Jev scores are still coming waits, so a turn normally gets one record; on shutdown it goes as is.
	 */
	flush(shutdown = false): void {
		if (this.disposed) return;
		if (!this.pendingSteps.size && !this.pendingChecks.size) return;
		let idle = false;
		try {
			idle = this.ctx.isIdle();
		} catch {
			return;
		}
		if (!idle) return;
		const ids = new Set(this.branch().map((e) => e.id));
		for (const [fromId, step] of this.pendingSteps) {
			if (!shutdown && this.scoring.has(fromId) && ids.has(fromId)) continue;
			if (ids.has(fromId)) this.pi.appendEntry(STEP_ENTRY, step);
			this.pendingSteps.delete(fromId);
		}
		for (const [id, check] of this.pendingChecks) {
			if (!shutdown && this.checking.has(id)) continue;
			if (ids.has(id)) this.pi.appendEntry(COMPACTION_ENTRY, check);
			this.pendingChecks.delete(id);
		}
		if (!shutdown) this.refresh();
	}

	// ---------- the Gemini queue ----------
	kick(): void {
		if (this.disposed || this.running) return; // a running drain re-picks after every request
		this.running = true;
		this.host.requestRender();
		void this.drain();
	}

	private async drain(): Promise<void> {
		try {
			for (;;) {
				if (this.disposed) break;
				const job = this.pick();
				if (!job) break;
				try {
					await this.run(job);
				} catch (error) {
					this.failJob(job, errorText(error));
				}
				this.flush();
				this.refresh();
			}
		} finally {
			this.running = false;
			this.bf = undefined;
			if (!this.disposed) {
				this.flush();
				this.refresh();
				this.autoChecks();
			}
		}
	}

	/** Backfill window start on this branch (turn index); turns before it wait for /timeline backfill. */
	private windowStart(turns: number): number {
		if (this.backfillAll) return 0;
		if (!this.cfg.backfill.auto) return turns;
		return Math.max(0, turns - this.cfg.backfill.maxTurns);
	}

	private pick(): Job | undefined {
		const branch = this.branch();
		const turns = splitTurns(branch);
		const steps = this.records(branch);
		if (this.redoIds.size) {
			const onBranch = new Set(turns.map((t) => t.fromId));
			for (const id of [...this.redoIds]) if (!onBranch.has(id)) this.redoIds.delete(id); // left behind by /tree
			if (!this.redoIds.size) this.redoDone();
		}
		for (const id of this.redoIds) steps.delete(id); // being redone: treated as missing
		const last = turns.length - 1;
		// Unanswered turns (interrupted before any reply) are never summarized: nothing happened in them.
		const finished = (i: number) => !(this.agentActive && i === last) && !isEmptyTurn(turns[i]);

		// 0. interim summary of the running turn at a mid-turn compaction
		const ij = this.interimJob;
		this.interimJob = undefined;
		if (ij && ij.token === this.interimToken && this.agentActive && turns[last]?.fromId === ij.fromId && !steps.has(ij.fromId)) {
			return { kind: "interim", turn: turnUntil(turns[last], ij.compactionId), token: ij.token };
		}
		// 1. turns that finished while the plugin was running
		for (const [i, t] of turns.entries()) {
			if (finished(i) && !this.startIds.has(t.fromId) && !steps.has(t.fromId)) return { kind: "turn", turn: t, reason: "live" };
		}
		// 2. backfill: the oldest missing turn inside the window, plus the missing turns right after it
		const from = this.windowStart(turns.length);
		const missing: number[] = [];
		for (let i = from; i < turns.length; i++) if (finished(i) && !steps.has(turns[i].fromId)) missing.push(i);
		if (missing.length) {
			const size = this.cfg.backfill.batchSize;
			const done = this.bf?.done ?? 0;
			this.bf = { done, total: done + Math.ceil(missing.length / size) };
			const batch: Turn[] = [];
			for (let i = missing[0]; i < turns.length && batch.length < size; i++) {
				if (!finished(i) || steps.has(turns[i].fromId)) break; // an unanswered turn ends the batch too
				batch.push(turns[i]);
			}
			return { kind: "batch", turns: batch };
		}
		this.bf = undefined;
		// 3. retries, grown turns, and gap turns whose previous turn now has a good record
		for (const [i, t] of turns.entries()) {
			if (!finished(i)) continue;
			const s = steps.get(t.fromId);
			if (!s) continue;
			if (this.retryIds.delete(t.fromId) && !s.gen.ok) return { kind: "turn", turn: t, reason: "retry" };
			if (s.toId !== t.toId) return { kind: "turn", turn: t, reason: "grown" };
			if (s.gen.gap && !(t.fromId === turns[last]?.fromId && this.startIds.has(t.fromId) && s.next)) {
				// A completed latest prediction is the reopen cache. Repairing old phase gaps must
				// not re-analyse that reply until another user turn (or an explicit redo).
				const p = answeredBefore(turns, i);
				if (p && steps.get(p.fromId)?.gen.ok) return { kind: "turn", turn: t, reason: "gap" };
			}
		}
		// 4. a Chinese one-liner for the goal of a compaction whose check found a problem (only then is it shown)
		for (const item of this.cached.items) {
			if (item.kind !== "compaction" || !item.check?.postGoal || item.check.postBrief) continue;
			if (!compactionProblems(item.check).length) continue;
			if (this.briefTried.has(item.entryId) || this.checking.has(item.entryId)) continue;
			return { kind: "brief", check: item.check };
		}
		return undefined;
	}

	private async run(job: Job): Promise<void> {
		if (job.kind === "interim") await this.summarizeInterim(job.turn, job.token);
		else if (job.kind === "turn") await this.summarizeOne(job.turn);
		else if (job.kind === "brief") await this.briefJob(job.check);
		else await this.summarizeBatchJob(job.turns);
	}

	/** A job threw before it could record anything: record failures so the queue does not pick it again. */
	private failJob(job: Job, error: string): void {
		if (job.kind === "interim") {
			this.interimFailures++;
			return;
		}
		if (job.kind === "brief") return; // the English goal stays; tried once per session
		const turns = job.kind === "turn" ? [job.turn] : job.turns;
		const branch = this.branch();
		const all = splitTurns(branch);
		const steps = this.records(branch);
		const out: TimelineStep[] = [];
		const history = recordsBefore(all, steps, turns[0].fromId);
		for (const t of turns) {
			const step = this.makeStep(t, history, undefined, { ok: false, model: `${this.cfg.summary.provider}/${this.cfg.summary.model}`, ms: 0, error }, false);
			history.push(step);
			out.push(step);
		}
		this.warnSummary(error);
		this.accept(out);
	}

	private turnInput(turn: Turn, hasPrev: boolean, turns: readonly Turn[]): TurnInput {
		const text = turnText(turn);
		const idx = turns.findIndex((t) => t.fromId === turn.fromId);
		return {
			forcedContinue: hasPrev && isContinueMessage(textOf(turn.entries[0]?.message?.content)),
			previous: idx > 0 ? previousContext(turns, idx) : "",
			decisions: turnDecisions(turn),
			stats: computeStats(turn),
			actions: actionList(turn),
			user: text.user,
			assistant: text.assistant,
		};
	}

	/**
	 * Build a step record. `before` = records of earlier turns (branch order). With no earlier record, the step always
	 * opens a new phase. Without `fields` (Gemini failed) the user's own words stand in and the phase carries on.
	 */
	private makeStep(
		turn: Turn,
		before: readonly TimelineStep[],
		fields: Fields | undefined,
		gen: TimelineStep["gen"],
		forced: boolean,
		next?: NextV1,
		now?: string,
	): TimelineStep {
		const prev = before.at(-1);
		const lastPhase: PhaseLine | undefined = phaseList(before).at(-1);
		const base = {
			v: 2 as const,
			kind: "step" as const,
			fromId: turn.fromId,
			toId: turn.toId,
			startedAt: turn.startedAt,
			endedAt: turn.endedAt,
			stats: computeStats(turn),
		};
		if (fields) {
			const cont = !!prev && !!lastPhase && (forced || fields.continue_phase);
			return {
				...base,
				phase: cont && lastPhase ? { id: lastPhase.id, title: fields.phase_title || lastPhase.title, isNew: false } : { id: turn.fromId, title: fields.phase_title, isNew: true },
				intent: fields.intent,
				summary: fields.result,
				...(fields.decisions.length ? { decisions: fields.decisions } : {}),
				...(now ? { now } : {}),
				status: fields.status,
				goal: fields.goal || prev?.goal || "",
				gen: { ...gen, prompt: 2 },
				...(next ? { next } : {}),
			};
		}
		const userRaw = redact(textOf(turn.entries[0]?.message?.content));
		return {
			...base,
			phase: prev && lastPhase ? { id: lastPhase.id, title: lastPhase.title, isNew: false } : { id: turn.fromId, title: head(userRaw, 16) || "（未命名）", isNew: true },
			intent: head(userRaw, 28) || "（空消息）",
			summary: "",
			status: "in_progress",
			goal: prev?.goal ?? "",
			gen,
		};
	}

	private warnSummary(error: string | undefined): void {
		if (this.warnedSummary) return;
		this.warnedSummary = true;
		this.notify(`时间线摘要失败（${error ?? "未知错误"}），这一轮先用你的原话占位；/timeline retry 可重跑`, "warning");
	}

	private warnJev(error: string): void {
		if (this.warnedJev) return;
		this.warnedJev = true;
		this.notify(`时间线 Jev 打分失败（${error}），摘要照常；/timeline retry 可重打`, "warning");
	}

	/** One turn on its own (live, retry, gap re-run, grown). */
	private async summarizeOne(turn: Turn): Promise<void> {
		const branch = this.branch();
		const turns = splitTurns(branch);
		const steps = this.records(branch);
		const before = recordsBefore(turns, steps, turn.fromId);
		const prev = before.at(-1);
		const idx = turns.findIndex((t) => t.fromId === turn.fromId);
		const p = answeredBefore(turns, idx);
		const gap = !!p && !steps.has(p.fromId);
		const input = this.turnInput(turn, !!prev, turns);
		const res = await summarizeTurn(this.ctx, this.cfg, { goal: prev?.goal ?? "", phases: phaseList(before).slice(-8), ...input, includeNext: shouldGenerateNext(true) });
		if (this.disposed) return;
		this.lastMs = res.ms;
		const o = res.output;
		const gen: TimelineStep["gen"] = { ok: !!o, model: res.model, ms: res.ms, ...(o ? {} : { error: res.error ?? "未知错误" }), ...(gap ? { gap: true } : {}) };
		if (!o) this.warnSummary(res.error);
		this.accept([this.makeStep(turn, before, o, gen, input.forcedContinue, o ? toNext(o.next, o.directions) : undefined, o?.now)]);
	}

	/** Up to 8 consecutive old turns in one request. A whole-batch failure records every turn as failed. */
	private async summarizeBatchJob(batch: Turn[]): Promise<void> {
		const branch = this.branch();
		const turns = splitTurns(branch);
		const steps = this.records(branch);
		const before = recordsBefore(turns, steps, batch[0].fromId);
		const idx = turns.findIndex((t) => t.fromId === batch[0].fromId);
		const p = answeredBefore(turns, idx);
		const gap = !!p && !steps.has(p.fromId);
		const includeNext = shouldGenerateNext(batch.at(-1)?.fromId === turns.at(-1)?.fromId);
		const inputs = batch.map((t, i) => this.turnInput(t, i > 0 || before.length > 0, turns));
		const res = await summarizeBatch(this.ctx, this.cfg, { goal: before.at(-1)?.goal ?? "", phases: phaseList(before).slice(-8), turns: inputs, includeNext });
		if (this.disposed) return;
		this.lastMs = res.ms;
		if (this.bf) this.bf.done++;
		const labels = batchLabels(batch.length);
		const history = [...before];
		const out: TimelineStep[] = [];
		let firstError: string | undefined;
		batch.forEach((t, i) => {
			const f = res.parsed?.turns.get(labels[i]);
			const fields = f && typeof f !== "string" ? f : undefined;
			const error = fields ? undefined : typeof f === "string" ? f : (res.error ?? "未知错误");
			firstError ??= error;
			const gen: TimelineStep["gen"] = {
				ok: !!fields,
				model: res.model,
				ms: res.ms,
				backfill: true,
				...(error ? { error } : {}),
				...(i === 0 && gap ? { gap: true } : {}),
			};
			const last = i === batch.length - 1;
			const next = last && includeNext && res.parsed ? toNext(res.parsed.next, res.parsed.directions) : undefined;
			const step = this.makeStep(t, history, fields, gen, inputs[i].forcedContinue, next, last ? res.parsed?.now : undefined);
			history.push(step);
			out.push(step);
		});
		if (firstError) this.warnSummary(firstError);
		this.accept(out);
	}

	/** Interim summary of the part of a running turn before a compaction; dropped if stale by the time it is back. */
	private async summarizeInterim(turn: Turn, token: number): Promise<void> {
		const branch = this.branch();
		const turns = splitTurns(branch);
		const steps = this.records(branch);
		const before = recordsBefore(turns, steps, turn.fromId);
		const input = this.turnInput(turn, before.length > 0, turns);
		const res = await summarizeTurn(this.ctx, this.cfg, { goal: before.at(-1)?.goal ?? "", phases: phaseList(before).slice(-8), ...input, includeNext: false });
		if (this.disposed) return;
		const now = this.branch();
		const stale =
			token !== this.interimToken || !this.agentActive || splitTurns(now).at(-1)?.fromId !== turn.fromId || this.records(now).has(turn.fromId);
		if (stale) return;
		if (!res.output) {
			this.interimFailures++;
			return;
		}
		const step = this.makeStep(turn, before, res.output, { ok: true, model: res.model, ms: res.ms, partial: true }, input.forcedContinue);
		step.status = "in_progress";
		this.interim.set(step.fromId, step);
		this.refresh();
	}

	/** New final records: replace interim ones, queue their Jev scores, write when idle. */
	private accept(steps: TimelineStep[]): void {
		const kept: TimelineStep[] = [];
		const old = this.redoIds.size ? this.records(this.branch()) : undefined;
		for (const s of steps) {
			const redo = this.redoIds.delete(s.fromId);
			// A failed redo must not replace a good old record.
			if (redo && !s.gen.ok && old?.get(s.fromId)?.gen.ok) continue;
			this.pendingSteps.set(s.fromId, s);
			this.interim.delete(s.fromId);
			kept.push(s);
		}
		if (!this.redoIds.size) this.redoDone();
		this.scheduleScores(kept);
		this.flush();
		this.refresh();
	}

	// ---------- Jev scores ----------
	private scheduleScores(steps: readonly TimelineStep[]): void {
		if (!this.cfg.jev.enabled) return;
		const branch = this.branch();
		const turns = splitTurns(branch);
		const records = this.records(branch);
		const latest = turns.at(-1)?.fromId;
		for (const step of steps) {
			if (!step.gen.ok || step.gen.partial) continue;
			const turn = turns.find((t) => t.fromId === step.fromId);
			if (!turn) continue;
			const wantTurn = this.cfg.modules.score && !step.score;
			const wantNext = shouldGenerateNext(this.cfg.modules.next && step.fromId === latest) && !!step.next?.steps.length && !step.next.steps.some((s) => typeof s.score === "number");
			if (!wantTurn && !wantNext) continue;
			const before = recordsBefore(turns, records, step.fromId);
			const text = turnText(turn);
			if (wantTurn) void this.scoreJob(step, "turn", () => this.scoreTurnOf(step, turn, before, text));
			if (wantNext) {
				this.scoringNext.add(step.fromId);
				void this.scoreJob(step, "next", () => this.scoreNextOf(step, turns, before, text.assistant));
			}
		}
	}

	private async scoreTurnOf(step: TimelineStep, turn: Turn, before: TimelineStep[], text: { user: string; assistant: string }): Promise<void> {
		try {
			const turns = splitTurns(this.branch());
			const idx = turns.findIndex((t) => t.fromId === turn.fromId);
			const score = await scoreTurn(
				{
					previous: idx > 0 ? previousContext(turns, idx) : "",
					decisions: turnDecisions(turn),
					userRequest: text.user,
					intent: step.intent,
					goal: step.goal,
					phases: phaseList(before),
					reply: text.assistant,
					actions: actionList(turn),
				},
				this.cfg.jev.timeoutMs,
			);
			this.patch(step, (s) => {
				s.score = score;
				delete s.scoreError;
			});
		} catch (error) {
			const message = errorText(error);
			this.patch(step, (s) => {
				s.scoreError = message;
			});
			this.warnJev(message);
		}
	}

	private async scoreNextOf(step: TimelineStep, turns: readonly Turn[], before: TimelineStep[], reply: string): Promise<void> {
		const candidates = step.next?.steps.map((s) => s.text) ?? [];
		const upTo = turns.findIndex((t) => t.fromId === step.fromId);
		const userMessages = turns
			.slice(Math.max(0, upTo - 2), upTo + 1)
			.map((t) => head(redact(textOf(t.entries[0]?.message?.content)), 800));
		try {
			const ranked = await scoreNext({ goal: step.goal, phases: phaseList([...before, step]), userMessages, reply, candidates }, this.cfg.jev.timeoutMs);
			this.patch(step, (s) => {
				if (s.next) s.next = { steps: ranked, directions: s.next.directions };
			});
		} catch (error) {
			const message = errorText(error);
			this.patch(step, (s) => {
				if (s.next) s.next = { ...s.next, scoreError: message };
			});
			this.warnJev(message);
		}
	}

	private async scoreJob(step: TimelineStep, what: "turn" | "next", fn: () => Promise<void>): Promise<void> {
		const id = step.fromId;
		this.scoring.set(id, (this.scoring.get(id) ?? 0) + 1);
		this.host.requestRender();
		try {
			await this.jev.run(async () => {
				if (!this.disposed && this.pendingSteps.get(id) === step) await fn();
			});
		} catch (error) {
			this.notify(`时间线打分出错：${errorText(error)}`, "warning");
		} finally {
			const left = (this.scoring.get(id) ?? 1) - 1;
			if (left > 0) this.scoring.set(id, left);
			else this.scoring.delete(id);
			if (what === "next") this.scoringNext.delete(id);
			this.flush();
			this.refresh(); // refresh also broadcasts the rebuilt prediction view.
		}
	}

	/** Apply a Jev result only to the step it was computed for (not to a newer record of the same turn). */
	private patch(step: TimelineStep, fn: (s: TimelineStep) => void): void {
		if (this.disposed || this.pendingSteps.get(step.fromId) !== step) return;
		fn(step);
	}

	// ---------- compaction check ----------
	onCompact(ctx: ExtensionContext, compactionId: string): void {
		this.use(ctx);
		if (this.agentActive) {
			// Mid-turn compaction: summarize what the running turn has done so far (memory only).
			const turns = splitTurns(this.branch());
			const last = turns.at(-1);
			if (last?.entries.some((e) => e.id === compactionId)) {
				this.interimToken++;
				this.interimJob = { fromId: last.fromId, compactionId, token: this.interimToken };
				this.kick();
			}
		}
		this.refresh();
		void this.runCheck(compactionId);
	}

	/** After the queue drains: check older compactions that have timeline records before them but no check yet. */
	private autoChecks(): void {
		if (!this.cfg.jev.enabled || !this.cfg.modules.compaction) return;
		let seenStep = false;
		for (const item of this.cached.items) {
			if (item.kind === "phase") {
				seenStep = true;
				continue;
			}
			if (!seenStep || item.check || this.checking.has(item.entryId) || this.checkTried.has(item.entryId)) continue;
			void this.runCheck(item.entryId);
		}
	}

	async runCheck(compactionId: string): Promise<void> {
		if (this.disposed || !this.cfg.jev.enabled || this.checking.has(compactionId)) return;
		this.checking.add(compactionId);
		this.checkTried.add(compactionId);
		this.host.requestRender();
		try {
			await this.jev.run(async () => {
				const branch = this.branch();
				const entry = branch.find((e) => e.id === compactionId);
				if (!entry || entry.type !== "compaction") throw new Error("当前分支上找不到这次压缩");
				const view = buildView(branch, [...this.pendingSteps.values()]);
				const before = phasesBefore(view, compactionId);
				const phases = before.map((p) => ({ id: p.id, title: p.title, status: p.status, lastStep: (p.steps.at(-1) && stepLine(p.steps.at(-1)!)) || "" }));
				const preGoal = before.at(-1)?.steps.at(-1)?.goal ?? "";
				// Redact before store and before Jev: compaction summaries can contain keys the user pasted earlier.
				const postGoal = redact(extractGoalSection(entry.summary ?? ""));
				const kept = keptMessages(branch, compactionId, KEPT_MESSAGES, 1200);
				const check: CompactionCheckV1 = {
					v: 1,
					kind: "compaction",
					compactionId,
					at: entryTime(entry),
					tokensBefore: entry.tokensBefore ?? 0,
					preGoal,
					postGoal,
					keptMessages: kept.length,
				};
				const old = this.checkOf(compactionId);
				if (old?.postBrief && old.postGoal === postGoal) check.postBrief = old.postBrief;
				else this.briefTried.delete(compactionId);
				try {
					check.jev = await checkCompaction(
						{
							preGoal,
							phases,
							userMessages: userMessagesBefore(branch, compactionId, 5, 800),
							postGoal,
							summary: redact(entry.summary ?? ""),
							kept,
						},
						this.cfg.jev.timeoutMs,
					);
				} catch (error) {
					check.error = errorText(error);
					this.warnJev(check.error); // once per session, shared with turn scores

				}
				this.pendingChecks.set(compactionId, check);
			});
		} catch (error) {
			this.notify(`压缩检查没跑成：${errorText(error)}`, "warning");
		} finally {
			this.checking.delete(compactionId);
			this.flush();
			this.refresh();
			this.kick(); // the Chinese gist of the new check's goal
		}
	}

	/** Latest check of a compaction (not yet written wins over stored). */
	private checkOf(compactionId: string): CompactionCheckV1 | undefined {
		return this.pendingChecks.get(compactionId) ?? collectRecords(this.branch()).checks.get(compactionId);
	}

	/** Pi's compaction summaries are usually English: ask Gemini for one Chinese sentence and store it as a newer record. */
	private async briefJob(check: CompactionCheckV1): Promise<void> {
		const id = check.compactionId;
		this.briefTried.add(id);
		const res = await briefGoal(this.ctx, this.cfg, check.postGoal);
		if (!res.ok || !res.text) return;
		const latest = this.checkOf(id);
		if (!latest || latest.postGoal !== check.postGoal || latest.postBrief) return;
		this.pendingChecks.set(id, { ...latest, postBrief: res.text });
	}

	latestCompactionId(): string | undefined {
		return this.branch()
			.filter((e) => e.type === "compaction")
			.at(-1)?.id;
	}

	// ---------- commands ----------
	/** Fill prediction `n` (1-based) into an empty editor. Never sends. */
	fill(ctx: ExtensionContext, n: number): void {
		this.use(ctx);
		if (!this.cfg.enabled) {
			this.notify("时间线关着，预测也隐藏了（alt+s 打开）", "info");
			return;
		}
		const p = this.predictions();
		const text = pickNextFill(p, n);
		if (!p?.steps.length) {
			this.notify(this.agentActive ? "AI 还在回答，这一轮结束后再出预测" : "现在没有下一步预测", "info");
			return;
		}
		if (!text) {
			this.notify(`没有第 ${n} 条预测`, "info");
			return;
		}
		if (ctx.ui.getEditorText().trim()) {
			this.notify(`输入框里已经有字，没覆盖。第 ${n} 条是：${text}`, "info");
			return;
		}
		ctx.ui.setEditorText(text);
	}

	/** Turns on this branch with no record, and how many of them lie before the auto-backfill window. */
	backfillPlan(): { missing: number; older: number } {
		const branch = this.branch();
		const turns = splitTurns(branch);
		const steps = this.records(branch);
		const from = this.cfg.backfill.auto ? Math.max(0, turns.length - this.cfg.backfill.maxTurns) : turns.length;
		let missing = 0;
		let older = 0;
		turns.forEach((t, i) => {
			if ((this.agentActive && i === turns.length - 1) || steps.has(t.fromId) || isEmptyTurn(t)) return;
			missing++;
			if (i < from) older++;
		});
		return { missing, older };
	}

	backfillEverything(): void {
		this.backfillAll = true;
		this.backfillAllRequested = true;
		this.kick();
	}

	/** Answered turns on this branch (what `/timeline redo` would redo) and how many have older-prompt records. */
	redoPlan(): { turns: number; old: number } {
		const branch = this.branch();
		const turns = splitTurns(branch);
		const steps = this.records(branch);
		let n = 0;
		let old = 0;
		turns.forEach((t, i) => {
			if ((this.agentActive && i === turns.length - 1) || isEmptyTurn(t)) return;
			n++;
			if (steps.get(t.fromId)?.gen.prompt !== 2) old++;
		});
		return { turns: n, old };
	}

	/** A redo widened the backfill window to the whole branch; put it back unless /timeline backfill asked for that. */
	private redoDone(): void {
		this.backfillAll = this.backfillAllRequested;
	}

	/** Summarize and score every answered turn on this branch again with the current prompts (batched, oldest first). */
	redoAll(): void {
		const turns = splitTurns(this.branch());
		turns.forEach((t, i) => {
			if ((this.agentActive && i === turns.length - 1) || isEmptyTurn(t)) return;
			this.redoIds.add(t.fromId);
		});
		this.backfillAll = true;
		this.kick();
	}

	retry(): string {
		const branch = this.branch();
		const turns = splitTurns(branch);
		const steps = this.records(branch);
		const latest = turns.at(-1)?.fromId;
		let gemini = 0;
		const rescore: TimelineStep[] = [];
		for (const t of turns) {
			const s = steps.get(t.fromId);
			if (!s || this.scoring.has(t.fromId)) continue;
			if (!s.gen.ok) {
				this.retryIds.add(t.fromId);
				gemini++;
				continue;
			}
			const nextFailed = !!s.next?.scoreError && t.fromId === latest;
			if (!s.scoreError && !nextFailed) continue;
			// Jev only: a new record with the same summary, without the failed parts.
			const copy: TimelineStep = structuredClone(s);
			if (copy.scoreError) {
				delete copy.scoreError;
				delete copy.score;
			}
			if (nextFailed && copy.next) copy.next = { steps: copy.next.steps.map(({ text }) => ({ text })), directions: copy.next.directions };
			rescore.push(copy);
		}
		if (rescore.length) this.accept(rescore);
		const failedChecks = this.cached.items.flatMap((i) => (i.kind === "compaction" && i.check?.error ? [i.entryId] : []));
		for (const id of failedChecks) void this.runCheck(id);
		this.kick();
		return `重跑：摘要失败的 ${gemini} 轮，只重打分的 ${rescore.length} 轮，失败的压缩检查 ${failedChecks.length} 个`;
	}

	toggle(on?: boolean): void {
		this.cfg.enabled = on ?? !this.cfg.enabled;
		this.host.sync();
		this.host.requestRender();
		this.persist();
	}

	status(): string {
		const split = this.host.broken
			? `坏了（${this.host.broken}）`
			: !this.host.canSplit()
				? "不可用（非全屏模式）"
				: this.host.isShowing()
					? "显示中"
					: this.cfg.enabled
						? "隐藏（终端太窄）"
						: "已关";
		const plan = this.backfillPlan();
		const b = this.cfg.backfill;
		const backfill = this.bf
			? `回填中 ${this.bf.done}/${this.bf.total} 包`
			: plan.missing
				? `待补 ${plan.missing} 轮（${plan.older} 轮在自动范围外，/timeline backfill）`
				: "没有待补";
		const redo = this.redoPlan();
		return [
			`时间线 ${this.cfg.enabled ? "开" : "关"} · 宽 ${this.cfg.width} · 侧栏 ${split}`,
			...(this.redoIds.size ? [`重跑中：还剩 ${this.redoIds.size} 轮`] : redo.old ? [`旧版提示词生成的记录 ${redo.old} 轮（没有拍板和"现在"，/timeline redo 可重跑）`] : []),
			`已总结 ${this.cached.steps} 轮（失败 ${this.cached.failed}）· 待写入 ${this.pendingSteps.size + this.pendingChecks.size} · 不认识的记录 ${this.cached.unknownVersions}`,
			`回填：${backfill} · 自动 ${b.auto ? `开，最近 ${b.maxTurns} 轮` : "关"} · 每包 ${b.batchSize} 轮`,
			`摘要模型 ${this.cfg.summary.provider}/${this.cfg.summary.model}:${this.cfg.summary.thinking} · 上次耗时 ${(this.lastMs / 1000).toFixed(1)}s${this.running ? " · 正在总结" : ""}`,
			`Jev ${this.cfg.jev.enabled ? "开" : "关"} · 打分中 ${this.scoring.size} 轮 · 压缩检查中 ${this.checking.size} 个${this.interim.size ? ` · 进行中摘要 ${this.interim.size}` : ""}${this.interimFailures ? ` · 进行中摘要失败 ${this.interimFailures}` : ""}`,
			`开启的模块：${MODULE_NAMES.filter((m) => this.cfg.modules[m]).join(" ") || "（无）"}`,
		].join("\n");
	}
}

export default function sessionTimeline(pi: ExtensionAPI): void {
	if (process.env.PI_SUBAGENT_CHILD || process.env.PI_SUBAGENT_PARENT_SESSION) return;
	const loaded = loadConfig();
	const cfg = loaded.config;
	let timeline: Timeline | undefined;

	pi.events.on(TASK_ASSISTANT_CHANNEL, (data) => timeline?.onAssistantEvent(data));
	pi.events.emit(TASK_ASSISTANT_CHANNEL, { type: "hello", version: 1, role: "sidebar" });
	pi.on("session_start", (_event, ctx) => {
		timeline?.dispose();
		timeline = undefined;
		if (ctx.mode !== "tui") return;
		if (loaded.error) ctx.ui.notify(loaded.error, "warning");
		timeline = new Timeline(pi, ctx, cfg);
		timeline.start();
		pi.events.emit(TASK_ASSISTANT_CHANNEL, { type: "hello", version: 1, role: "sidebar" });
	});
	pi.on("session_shutdown", () => {
		timeline?.dispose();
		timeline = undefined;
	});
	pi.on("agent_start", (_event, ctx) => timeline?.onAgentStart(ctx));
	pi.on("agent_settled", (_event, ctx) => timeline?.onSettled(ctx));
	pi.on("session_compact", (event, ctx) => timeline?.onCompact(ctx, event.compactionEntry.id));
	pi.on("session_tree", (_event, ctx) => timeline?.onTree(ctx));

	const widthBy = (delta: number) => timeline?.setWidth(cfg.width + delta, true);
	pi.registerShortcut("alt+s", { description: "时间线侧栏开关", handler: () => timeline?.toggle() });
	pi.registerShortcut("alt+,", { description: "时间线侧栏变窄", handler: () => widthBy(-WIDTH_STEP) });
	pi.registerShortcut("alt+.", { description: "时间线侧栏变宽", handler: () => widthBy(WIDTH_STEP) });
	const fillKeys = ["alt+1", "alt+2", "alt+3"] as const;
	fillKeys.forEach((key, i) => {
		pi.registerShortcut(key, { description: `把第 ${i + 1} 条预测填进空输入框（不发送）`, handler: (ctx) => timeline?.fill(ctx, i + 1) });
	});

	const SUB = ["on", "off", "width", "wider", "narrower", "show", "hide", "modules", "backfill", "redo", "retry", "check", "status"];
	pi.registerCommand("timeline", {
		description: "对话时间线侧栏：开关 / 宽度 / 模块 / 回填 / 重跑 / 状态",
		getArgumentCompletions: (prefix: string) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) return SUB.filter((s) => s.startsWith(parts[0] ?? "")).map((s) => ({ value: s, label: s }));
			if (parts[0] === "show" || parts[0] === "hide") {
				return MODULE_NAMES.filter((m) => m.startsWith(parts[1] ?? "")).map((m) => ({ value: `${parts[0]} ${m}`, label: m, description: MODULE_LABELS[m] }));
			}
			return null;
		},
		handler: async (args, ctx) => {
			if (!timeline) {
				ctx.ui.notify("时间线只在交互（TUI）模式下工作", "warning");
				return;
			}
			timeline.use(ctx);
			const [sub, arg] = args.trim().split(/\s+/);
			switch (sub || "") {
				case "":
					timeline.toggle();
					ctx.ui.notify(`时间线侧栏已${cfg.enabled ? "打开" : "关闭"}`, "info");
					return;
				case "on":
				case "off":
					timeline.toggle(sub === "on");
					return;
				case "width": {
					const n = Number(arg);
					if (!Number.isFinite(n)) {
						ctx.ui.notify(`用法：/timeline width 24~80（现在 ${cfg.width}）`, "warning");
						return;
					}
					timeline.setWidth(n, true);
					ctx.ui.notify(`时间线宽度 ${cfg.width}`, "info");
					return;
				}
				case "wider":
				case "narrower":
					widthBy(sub === "wider" ? WIDTH_STEP : -WIDTH_STEP);
					return;
				case "show":
				case "hide": {
					if (!MODULE_NAMES.includes(arg as ModuleName)) {
						ctx.ui.notify(`模块名：${MODULE_NAMES.join(" ")}`, "warning");
						return;
					}
					cfg.modules[arg as ModuleName] = sub === "show";
					const error = saveConfig(cfg);
					if (error) ctx.ui.notify(`设置没存上：${error}`, "warning");
					timeline.refresh();
					return;
				}
				case "modules":
					ctx.ui.notify(MODULE_NAMES.map((m) => `${cfg.modules[m] ? "✓" : "·"} ${m} — ${MODULE_LABELS[m]}`).join("\n"), "info");
					return;
				case "backfill": {
					const plan = timeline.backfillPlan();
					if (!plan.missing) {
						ctx.ui.notify("这个分支上没有待补的轮次", "info");
						return;
					}
					const calls = Math.ceil(plan.missing / cfg.backfill.batchSize);
					const cost = `$${(plan.missing * COST_PER_TURN.low).toFixed(2)}～$${(plan.missing * COST_PER_TURN.high).toFixed(2)}`;
					const ok = await ctx.ui.confirm(
						"补时间线",
						`要补 ${plan.missing} 轮（其中 ${plan.older} 轮在自动回填范围外），约 ${calls} 次 Gemini + ${plan.missing} 次 Jev，预计 ${cost}。开始吗？`,
					);
					if (!ok) return;
					timeline.backfillEverything();
					ctx.ui.notify(`开始回填 ${plan.missing} 轮，侧栏标题会显示进度`, "info");
					return;
				}
				case "redo": {
					const plan = timeline.redoPlan();
					if (!plan.turns) {
						ctx.ui.notify("这个分支上还没有可重跑的轮次", "info");
						return;
					}
					const calls = Math.ceil(plan.turns / cfg.backfill.batchSize);
					const cost = `$${(plan.turns * COST_PER_TURN.low).toFixed(2)}～$${(plan.turns * COST_PER_TURN.high).toFixed(2)}`;
					const ok = await ctx.ui.confirm(
						"用新提示词重跑时间线",
						`重跑这个分支上的 ${plan.turns} 轮（其中 ${plan.old} 轮是旧版记录），约 ${calls} 次 Gemini + ${plan.turns} 次 Jev，预计 ${cost}。重跑失败的轮次保留原记录。开始吗？`,
					);
					if (!ok) return;
					timeline.redoAll();
					ctx.ui.notify(`开始重跑 ${plan.turns} 轮，侧栏标题会显示进度`, "info");
					return;
				}
				case "retry":
					ctx.ui.notify(timeline.retry(), "info");
					return;
				case "check": {
					const id = timeline.latestCompactionId();
					if (!id) {
						ctx.ui.notify("当前分支上还没有压缩过", "info");
						return;
					}
					await timeline.runCheck(id);
					return;
				}
				case "status":
					ctx.ui.notify(timeline.status(), "info");
					return;
				default:
					ctx.ui.notify(`不认识 ${sub}。可用：${SUB.join(" ")}`, "warning");
			}
		},
	});
}

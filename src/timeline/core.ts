/**
 * Pure logic for session-timeline: turns from session entries, code-computed stats and action lists, the text
 * budget sent to the models, the view model the sidebar draws, and validation of the summary model's JSON.
 * No Pi runtime imports, so `node --test` covers it.
 */
import { clip, redact as redactBase } from "../shared/context.ts";
import {
	type BatchTurnOutput,
	COMPACTION_ENTRY,
	type CompactionCheckV1,
	type ModuleName,
	type NextV1,
	STEP_ENTRY,
	STEP_STATUSES,
	type StepScoreV1,
	type StepStatus,
	type SummaryOutput,
	type TimelineStep,
	type TimelineStepV1,
	type TimelineStepV2,
	type ToolCounts,
	type TurnStats,
} from "./contracts.ts";

// ---------- session entry shapes (only the fields read here) ----------

export interface Block {
	type?: string;
	text?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}
export interface Msg {
	role?: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	usage?: { totalTokens?: number; cost?: { total?: number } };
}
export interface Entry {
	type?: string;
	id?: string;
	timestamp?: string;
	message?: Msg;
	customType?: string;
	data?: unknown;
	summary?: string;
	tokensBefore?: number;
	/** On compaction entries: first entry Pi keeps verbatim after the summary. */
	firstKeptEntryId?: string;
}

export function entryTime(e: Entry): number {
	const t = e.timestamp ? Date.parse(e.timestamp) : Number.NaN;
	return Number.isFinite(t) ? t : 0;
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.flatMap((b) => (b && b.type === "text" && typeof b.text === "string" && b.text.trim() ? [b.text.trim()] : []))
		.join("\n");
}

function isUserText(e: Entry): boolean {
	return e.type === "message" && e.message?.role === "user" && textOf(e.message.content) !== "";
}

// Key shapes used on this machine that the shared patterns do not know, plus KEY=value style assignments.
const EXTRA_SECRETS: [RegExp, string][] = [
	[/\bjgw_[A-Za-z0-9_-]{12,}/g, "jgw_[redacted]"],
	[/\bapikey_[A-Za-z0-9_-]{12,}/g, "apikey_[redacted]"],
	// The value ends at whitespace, a quote, a bracket or CJK punctuation, so "KEY=...`（官方 key" keeps its "（官方".
	[/\b([A-Z][A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD)\s*=\s*["'`]?)[^\s"'`()（）\[\]{}<>，。、；：！？]{6,}/g, "$1[redacted]"],
	[/([?&](?:key|token|access_token|api_key)=)[^&\s]{6,}/gi, "$1[redacted]"],
];

/** Mask key-like strings (shared memory-rerank patterns + local key shapes). */
export function redact(text: string): string {
	let t = redactBase(text);
	for (const [re, rep] of EXTRA_SECRETS) t = t.replace(re, rep);
	return t;
}

/** Last-line-of-defence: walk a JSON-shaped value and redact every string leaf (Jev / Gemini payloads). */
export function redactDeep<T>(value: T): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
		return out as T;
	}
	return value;
}

// ---------- turns ----------

export interface Turn {
	fromId: string;
	/** Last message entry of the turn (user / assistant / toolResult). */
	toId: string;
	startedAt: number;
	endedAt: number;
	/** All entries of the turn in branch order, including compaction entries that happened mid-turn. */
	entries: Entry[];
}

/** Split a branch into turns: each starts at a user message with text and runs until the next one. */
export function splitTurns(branch: readonly Entry[]): Turn[] {
	const turns: Turn[] = [];
	let cur: Turn | undefined;
	for (const e of branch) {
		if (isUserText(e) && e.id) {
			cur = { fromId: e.id, toId: e.id, startedAt: entryTime(e), endedAt: entryTime(e), entries: [e] };
			turns.push(cur);
			continue;
		}
		if (!cur) continue;
		cur.entries.push(e);
		if (e.type === "message" && e.id && e.message?.role !== "system") {
			cur.toId = e.id;
			cur.endedAt = entryTime(e);
		}
	}
	return turns;
}

/** A finished turn in which the assistant said and did nothing (interrupted right away, or errored before output). */
export function isEmptyTurn(turn: Pick<Turn, "entries">): boolean {
	for (const e of turn.entries.slice(1)) {
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		if (textOf(e.message.content)) return false;
		if (Array.isArray(e.message.content) && (e.message.content as Block[]).some((b) => b?.type === "toolCall")) return false;
	}
	return true;
}

/**
 * What the user's message in turn `index` may be answering: the end of the assistant's last reply before it.
 * Turns in between that got no answer (interrupted) are included as the user's earlier words. Redacted, ≤ `chars`.
 */
export function previousContext(turns: readonly Turn[], index: number, chars = PREVIOUS_CHARS): string {
	const unanswered: string[] = [];
	for (let j = index - 1; j >= 0; j--) {
		const t = turns[j];
		if (isEmptyTurn(t)) {
			const said = redact(textOf(t.entries[0]?.message?.content));
			if (said) unanswered.unshift(said);
			continue;
		}
		const reply = redact(assistantPieces(t.entries.slice(1)).map((p) => p.text).join("\n")).trim();
		const tail = reply.length > chars ? `…${reply.slice(reply.length - chars)}` : reply;
		const parts = [tail ? `助手上一轮回复的结尾：\n${tail}` : ""];
		if (unanswered.length) parts.push(`之后你发过、但助手没回答就中断了的消息：\n${clip(unanswered.join("\n"), Math.floor(chars / 2))}`);
		return parts.filter(Boolean).join("\n\n");
	}
	return unanswered.length ? `你之前发过、但助手没回答就中断了的消息：\n${clip(unanswered.join("\n"), chars)}` : "";
}

export const PREVIOUS_CHARS = 1200;
const DECISION_LIMITS = { count: 8, question: 80, answer: 120 };

/**
 * The user's answers to questions the assistant asked in the middle of the turn (ask_user_question results):
 * "问：… → 用户选：…". Structured `details.answers` first, else the `"question"="answer"` pairs of the result text.
 */
export function turnDecisions(turn: Pick<Turn, "entries">): string[] {
	const asked = new Set<string>();
	for (const e of turn.entries) {
		if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
		for (const b of e.message.content as Block[]) if (b?.type === "toolCall" && b.name === "ask_user_question" && b.id) asked.add(b.id);
	}
	const out: string[] = [];
	const add = (q: string, a: string) => {
		if (!a.trim() || out.length >= DECISION_LIMITS.count) return;
		out.push(redact(`问：${oneLine(q, DECISION_LIMITS.question)} → 用户选：${oneLine(a, DECISION_LIMITS.answer)}`));
	};
	for (const e of turn.entries) {
		const m = e.message;
		if (e.type !== "message" || m?.role !== "toolResult" || m.isError) continue;
		if (!(m.toolCallId && asked.has(m.toolCallId)) && m.toolName !== "ask_user_question") continue;
		const d = m.details as { answers?: { question?: unknown; answer?: unknown }[]; cancelled?: unknown } | undefined;
		if (d?.cancelled === true) continue;
		if (Array.isArray(d?.answers) && d.answers.length) {
			for (const a of d.answers) add(typeof a?.question === "string" ? a.question : "", typeof a?.answer === "string" ? a.answer : "");
			continue;
		}
		for (const [, q, a] of textOf(m.content).matchAll(/"([^"]{1,300})"="([^"]{0,300})"/g)) add(q, a);
	}
	return out;
}

/** The part of a turn up to (not including) entry `untilId` — used for the interim summary at a mid-turn compaction. */
export function turnUntil(turn: Turn, untilId: string): Turn {
	const cut = turn.entries.findIndex((e) => e.id === untilId);
	const entries = cut > 0 ? turn.entries.slice(0, cut) : turn.entries;
	let toId = turn.fromId;
	let endedAt = turn.startedAt;
	for (const e of entries) {
		if (e.type === "message" && e.id && e.message?.role !== "system") {
			toId = e.id;
			endedAt = entryTime(e);
		}
	}
	return { ...turn, entries, toId, endedAt };
}

// ---------- stats ----------

const CATEGORY: Record<string, keyof ToolCounts> = {
	read: "read",
	read_symbol: "read",
	read_enclosing: "read",
	module_report: "read",
	symbol_search: "read",
	project_report: "read",
	codegraph_explore: "read",
	grep: "read",
	find: "read",
	ls: "read",
	lsp_navigation: "read",
	ast_grep_search: "read",
	ast_grep_outline: "read",
	edit: "edit",
	write: "edit",
	ast_grep_replace: "edit",
	bash: "run",
	web_search: "search",
	fetch_content: "search",
	get_search_content: "search",
	source_check: "search",
	subagent: "agent",
	ask_user_question: "ask",
};

export function emptyStats(): TurnStats {
	return {
		tools: { read: 0, edit: 0, run: 0, search: 0, agent: 0, ask: 0, other: 0 },
		errors: 0,
		files: [],
		added: 0,
		removed: 0,
		agents: [],
		commits: 0,
		durationMs: 0,
		cost: 0,
		tokens: 0,
	};
}

/** +/- line counts of a unified diff (headers excluded). */
export function countPatch(patch: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

/** Lines in a file body: a trailing newline does not start another line; "" has none. */
export function lineCount(text: string): number {
	if (!text) return 0;
	const n = text.split("\n").length;
	return text.endsWith("\n") ? n - 1 : n;
}

const GIT_COMMIT = /\bgit\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*commit\b/;

function pushUnique(list: string[], value: string, max: number): void {
	if (!value || list.includes(value) || list.length >= max) return;
	list.push(value);
}

function argsOf(b: Block): Record<string, unknown> {
	return (b.arguments && typeof b.arguments === "object" ? b.arguments : {}) as Record<string, unknown>;
}

export function computeStats(turn: Pick<Turn, "entries" | "startedAt" | "endedAt">): TurnStats {
	const s = emptyStats();
	const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
	for (const e of turn.entries) {
		if (e.type !== "message" || !e.message) continue;
		const m = e.message;
		if (m.role === "assistant") {
			s.cost += m.usage?.cost?.total ?? 0;
			s.tokens += m.usage?.totalTokens ?? 0;
			if (!Array.isArray(m.content)) continue;
			for (const b of m.content as Block[]) {
				if (!b || b.type !== "toolCall" || !b.name) continue;
				const args = argsOf(b);
				if (b.id) calls.set(b.id, { name: b.name, args });
				s.tools[CATEGORY[b.name] ?? "other"]++;
				if (b.name === "subagent") {
					const agent = typeof args.agent === "string" ? args.agent : args.workflowScript || args.workflow ? "workflow" : "";
					if (!args.action) pushUnique(s.agents, agent, 5);
				}
			}
		} else if (m.role === "toolResult") {
			if (m.isError) s.errors++;
			const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
			const name = m.toolName ?? call?.name ?? "";
			const args = call?.args ?? {};
			if (m.isError) continue;
			if (name === "edit" || name === "ast_grep_replace") {
				const patch = (m.details as { patch?: unknown } | undefined)?.patch;
				if (typeof patch === "string") {
					const c = countPatch(patch);
					s.added += c.added;
					s.removed += c.removed;
				}
				if (typeof args.path === "string") pushUnique(s.files, args.path, 20);
			} else if (name === "write") {
				if (typeof args.content === "string") s.added += lineCount(args.content);
				if (typeof args.path === "string") pushUnique(s.files, args.path, 20);
			} else if (name === "bash" && typeof args.command === "string" && GIT_COMMIT.test(args.command)) {
				s.commits++;
			}
		}
	}
	s.durationMs = Math.max(0, turn.endedAt - turn.startedAt);
	return s;
}

export function addStats(a: TurnStats, b: TurnStats): TurnStats {
	const out = emptyStats();
	for (const k of Object.keys(out.tools) as (keyof ToolCounts)[]) out.tools[k] = a.tools[k] + b.tools[k];
	out.errors = a.errors + b.errors;
	for (const f of [...a.files, ...b.files]) pushUnique(out.files, f, 50);
	out.added = a.added + b.added;
	out.removed = a.removed + b.removed;
	for (const x of [...a.agents, ...b.agents]) pushUnique(out.agents, x, 8);
	out.commits = a.commits + b.commits;
	out.durationMs = a.durationMs + b.durationMs;
	out.cost = a.cost + b.cost;
	out.tokens = a.tokens + b.tokens;
	return out;
}

// ---------- action list (tool names and targets only, never tool output) ----------

function oneLine(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const t = value.replace(/\s+/g, " ").trim();
	return [...t].length > max ? `${[...t].slice(0, max - 1).join("")}…` : t;
}

/** Last two path segments: enough to recognise a file without the long absolute prefix. */
export function shortPath(p: string): string {
	const parts = p.split("/").filter(Boolean);
	return parts.length <= 2 ? p : parts.slice(-2).join("/");
}

function readTarget(args: Record<string, unknown>): string {
	for (const k of ["path", "file", "symbol", "query", "pattern"]) {
		const v = args[k];
		if (typeof v === "string" && v.trim()) return k === "path" || k === "file" ? shortPath(v) : oneLine(v, 30);
	}
	return "";
}

function searchLine(name: string, args: Record<string, unknown>): string {
	if (name === "web_search") {
		const qs = Array.isArray(args.queries) ? args.queries.filter((q): q is string => typeof q === "string") : [];
		const q = typeof args.query === "string" ? args.query : qs.join(" / ");
		return q ? `搜 ${oneLine(q, 60)}` : "";
	}
	if (name === "fetch_content") {
		const url = typeof args.url === "string" ? args.url : Array.isArray(args.urls) ? String(args.urls[0] ?? "") : "";
		return url ? `看网页 ${oneLine(url.replace(/^https?:\/\//, ""), 50)}` : "";
	}
	if (name === "source_check" && typeof args.claim === "string") return `核实 ${oneLine(args.claim, 50)}`;
	return "";
}

function askLine(args: Record<string, unknown>): string {
	const qs = Array.isArray(args.questions) ? (args.questions as { question?: unknown }[]) : [];
	const q = qs.map((x) => (typeof x?.question === "string" ? x.question : "")).filter(Boolean);
	return q.length ? `问你 ${oneLine(q.join(" / "), 60)}` : "问你";
}

const MAX_RUN_LINES = 12;

// Flags whose next token is usually a value (path, message, user:password...), so that token is skipped too.
const VALUE_FLAGS = /^-[A-Za-z]$|^--(?:message|user|password|token|header|data|output|config|project|file|cwd|dir|prefix)$/;
const SAFE_WORD = /^[A-Za-z][A-Za-z0-9._:-]{0,39}$/;
/** Segments that say nothing about what was done: moving around, shell syntax, printing. */
const NOISE_PROGRAMS = new Set(["cd", "pushd", "popd", "source", "export", "set", "unset", "umask", "echo", "printf", "sleep", "for", "do", "done", "while", "if", "then", "else", "fi", "in", "wait"]);
/** Commands that check the work (tests, type checks, linters, smoke runs): kept when a long list is cut. */
const VERIFY = /\b(?:test|tests|pytest|vitest|jest|tsc|pyright|mypy|ruff|eslint|lint|check|typecheck|smoke|verify|validate)\b/i;

/** Long command lists keep the start, the end, and verification commands from the middle (in order, gaps marked). */
export function pickRuns(runs: readonly string[], max = MAX_RUN_LINES): string[] {
	if (runs.length <= max) return [...runs];
	const head = 3;
	const tail = Math.max(1, max - head - 3);
	const keep = new Set<number>();
	for (let i = 0; i < head; i++) keep.add(i);
	for (let i = runs.length - tail; i < runs.length; i++) keep.add(i);
	for (let i = head; i < runs.length - tail && keep.size < max; i++) if (VERIFY.test(runs[i])) keep.add(i);
	const out: string[] = [];
	let last = -1;
	for (const i of [...keep].sort((a, b) => a - b)) {
		if (i - last > 1) out.push(`…中间另 ${i - last - 1} 条命令`);
		out.push(`跑 ${runs[i]}`);
		last = i;
	}
	return out;
}

/**
 * The shape of a shell command without its arguments' contents: per `&&` / `||` / `;` / `|` segment, the program
 * name plus up to two plain words (subcommand / script name). Flags, flag values, paths, quoted strings, URLs and
 * env assignments are dropped, so passwords or tokens in arguments never leave the machine.
 */
export function commandShape(command: string): string {
	const noQuotes = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, " ");
	const segments = noQuotes.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean);
	const shapes: string[] = [];
	for (const seg of segments) {
		const tokens = seg.split(/\s+/).filter((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)); // drop FOO=bar
		const first = tokens.shift();
		if (!first) continue;
		const program = first.split("/").pop() ?? first;
		if (!SAFE_WORD.test(program) || NOISE_PROGRAMS.has(program)) continue;
		const words: string[] = [];
		let skipNext = false;
		for (const t of tokens) {
			if (skipNext) {
				skipNext = false;
				continue;
			}
			if (t.startsWith("-")) {
				skipNext = VALUE_FLAGS.test(t);
				continue;
			}
			if (SAFE_WORD.test(t) && !t.includes("://")) words.push(t);
			if (words.length >= 2) break;
		}
		const shape = [program, ...words].join(" ");
		if (!shapes.includes(shape)) shapes.push(shape);
		if (shapes.length >= 3) break;
	}
	return shapes.join(" && ");
}

/**
 * What the assistant did in a turn, from its tool calls: files changed, how much it read, commands run (✗ = failed),
 * subagents, searches and questions. Names and targets only; tool output is never included. Redacted and clipped.
 */
export function actionList(turn: Pick<Turn, "entries">, max = TEXT_BUDGET.actions): string {
	const failed = new Set<string>();
	for (const e of turn.entries) {
		if (e.type === "message" && e.message?.role === "toolResult" && e.message.isError && e.message.toolCallId) failed.add(e.message.toolCallId);
	}
	const edits: string[] = [];
	const reads: string[] = [];
	let readCount = 0;
	const runs: string[] = [];
	const agents: string[] = [];
	const searches: string[] = [];
	const asks: string[] = [];
	const others = new Map<string, number>();
	for (const e of turn.entries) {
		if (e.type !== "message" || e.message?.role !== "assistant" || !Array.isArray(e.message.content)) continue;
		for (const b of e.message.content as Block[]) {
			if (!b || b.type !== "toolCall" || !b.name) continue;
			const args = argsOf(b);
			const bad = b.id && failed.has(b.id) ? " ✗" : "";
			const cat = CATEGORY[b.name] ?? "other";
			if (cat === "edit") {
				if (typeof args.path === "string") pushUnique(edits, `${shortPath(args.path)}${bad}`, 30);
			} else if (cat === "read") {
				readCount++;
				pushUnique(reads, readTarget(args), 5);
			} else if (cat === "run") {
				const cmd = typeof args.command === "string" ? commandShape(args.command) : "";
				if (cmd && runs.at(-1) !== `${cmd}${bad}`) runs.push(`${cmd}${bad}`);
			} else if (cat === "agent") {
				if (args.action) continue; // status / control calls are not delegations
				const who = typeof args.agent === "string" ? args.agent : args.workflowScript || args.workflow ? "workflow" : "subagent";
				const task = typeof args.task === "string" ? `：${oneLine(args.task, 40)}` : "";
				agents.push(`${who}${task}${bad}`);
			} else if (cat === "search") {
				const line = searchLine(b.name, args);
				if (line) pushUnique(searches, `${line}${bad}`, 10);
			} else if (cat === "ask") {
				asks.push(askLine(args));
			} else {
				others.set(b.name, (others.get(b.name) ?? 0) + 1);
			}
		}
	}
	const lines: string[] = [];
	if (edits.length) lines.push(`改 ${edits.join(", ")}`);
	if (readCount) lines.push(`读 ${readCount} 次${reads.length ? `（${reads.join(", ")}${readCount > reads.length ? " …" : ""}）` : ""}`);
	lines.push(...(runs.length <= MAX_RUN_LINES ? runs.map((r) => `跑 ${r}`) : pickRuns(runs)));
	for (const a of agents) lines.push(`派 ${a}`);
	lines.push(...searches, ...asks);
	if (others.size) lines.push(`其他 ${[...others].map(([n, c]) => (c > 1 ? `${n}×${c}` : n)).join(", ")}`);
	return clip(redact(lines.join("\n")), max);
}

// ---------- text sent to the models ----------

export const TEXT_BUDGET = { user: 4000, assistant: 20000, actions: 2000 };
const OMITTED = "\n…（中间省略）…\n";

interface Piece {
	text: string;
	/** Right before or right after a compaction inside the turn: kept even when the middle is cut. */
	nearCompaction: boolean;
}

function assistantPieces(entries: readonly Entry[]): Piece[] {
	const pieces: Piece[] = [];
	let afterCompaction = false;
	for (const e of entries) {
		if (e.type === "compaction") {
			const prev = pieces.at(-1);
			if (prev) prev.nearCompaction = true;
			afterCompaction = true;
			continue;
		}
		if (e.type !== "message" || e.message?.role !== "assistant") continue;
		const t = textOf(e.message.content); // text blocks only: thinking and tool calls are other block types
		if (!t) continue;
		pieces.push({ text: t, nearCompaction: afterCompaction });
		afterCompaction = false;
	}
	return pieces;
}

/**
 * Join reply pieces within `budget` characters. Over budget: keep the start (25%), the end (55%) and the replies
 * around each mid-turn compaction (20%, split evenly); with no compaction the end gets that share too.
 */
export function budgetPieces(pieces: readonly Piece[], budget: number): string {
	const full = pieces.map((p) => p.text).join("\n");
	if (full.length <= budget) return full;
	const spans: { s: number; e: number; near: boolean }[] = [];
	let off = 0;
	for (const p of pieces) {
		spans.push({ s: off, e: off + p.text.length, near: p.nearCompaction });
		off += p.text.length + 1;
	}
	const head = Math.floor(budget * 0.25);
	let tail = Math.floor(budget * 0.55);
	const midBudget = budget - head - tail;
	const tailStartGuess = full.length - tail;
	const mids = spans.filter((x) => x.near && x.e > head && x.s < tailStartGuess);
	if (!mids.length) tail += midBudget;
	const tailStart = full.length - tail;
	const out = [full.slice(0, head)];
	const per = mids.length ? Math.floor(midBudget / mids.length) : 0;
	for (const m of mids) {
		const s = Math.max(m.s, head);
		const e = Math.min(m.e, tailStart);
		if (e > s) out.push(clip(full.slice(s, e), per));
	}
	out.push(full.slice(tailStart));
	return out.join(OMITTED);
}

/** The user's message and the assistant's visible reply text in one turn (redacted, budgeted). */
export function turnText(turn: Pick<Turn, "entries">, budget = TEXT_BUDGET): { user: string; assistant: string } {
	const user = clip(redact(textOf(turn.entries[0]?.message?.content)), budget.user);
	const pieces = assistantPieces(turn.entries.slice(1)).map((p) => ({ ...p, text: redact(p.text) }));
	return { user, assistant: budgetPieces(pieces, budget.assistant) };
}

const CONTINUE_WORDS =
	/^(继续|接着|接着做|继续做|好|好的|好滴|可以|行|嗯|对|是的|没问题|开始|开工|go|ok|okay|yes|y|continue|next|下一步|往下|同意)[\s。.!！,，~～]*$/i;

/** Short messages that carry no new intent and should stay in the current phase. */
export function isContinueMessage(text: string): boolean {
	const t = text.trim();
	return t.length <= 8 && CONTINUE_WORDS.test(t);
}

// ---------- compaction summary ----------

/** The goal section of a compaction summary (Pi default "## Goal", custom "### 1. Goal & Progress", split-turn "## Original Request"). */
export function extractGoalSection(summary: string, max = 1200): string {
	const text = summary.replace(/<(read-files|modified-files)>[\s\S]*?<\/\1>/g, "");
	const lines = text.split("\n");
	const sections: { head: string; body: string[] }[] = [];
	let cur: { head: string; body: string[] } = { head: "", body: [] };
	for (const line of lines) {
		const h = line.match(/^#{1,4}\s+(.*)$/);
		if (h) {
			sections.push(cur);
			cur = { head: h[1].trim(), body: [] };
		} else cur.body.push(line);
	}
	sections.push(cur);
	const pick = (re: RegExp) => sections.find((s) => re.test(s.head) && s.body.join("\n").trim());
	const found = pick(/\bgoal\b|目标/i) ?? pick(/original request|原始需求/i);
	const body = found ? found.body.join("\n").trim() : text.trim().slice(0, 600);
	return clip(body, max);
}

// ---------- records ----------

function isStepV2(d: unknown): d is TimelineStepV2 {
	const x = d as TimelineStepV2 | undefined;
	return !!x && x.v === 2 && x.kind === "step" && typeof x.fromId === "string" && !!x.phase && !!x.stats && !!x.gen;
}
function isStepV1(d: unknown): d is TimelineStepV1 {
	const x = d as TimelineStepV1 | undefined;
	return !!x && x.v === 1 && x.kind === "step" && typeof x.fromId === "string" && !!x.phase && !!x.stats && !!x.gen;
}
function isCheck(d: unknown): d is CompactionCheckV1 {
	const x = d as CompactionCheckV1 | undefined;
	return !!x && x.v === 1 && x.kind === "compaction" && typeof x.compactionId === "string";
}

/** v1 records have no intent / score / next: the old one-liner becomes the intent line. */
export function upcastStep(d: TimelineStepV1): TimelineStep {
	return { ...d, v: 2, intent: d.summary, summary: "" };
}

/**
 * Latest stored records per anchor, from the branch plus not-yet-flushed in-memory ones (`extraSteps` override),
 * plus interim summaries of running turns (`fallbackSteps`, used only where nothing else exists).
 */
export function collectRecords(
	branch: readonly Entry[],
	extraSteps: readonly TimelineStep[] = [],
	extraChecks: readonly CompactionCheckV1[] = [],
	fallbackSteps: readonly TimelineStep[] = [],
): { steps: Map<string, TimelineStep>; checks: Map<string, CompactionCheckV1>; unknownVersions: number } {
	const steps = new Map<string, TimelineStep>();
	const checks = new Map<string, CompactionCheckV1>();
	let unknownVersions = 0;
	for (const e of branch) {
		if (e.type !== "custom") continue;
		if (e.customType === STEP_ENTRY) {
			if (isStepV2(e.data)) steps.set(e.data.fromId, e.data);
			else if (isStepV1(e.data)) steps.set(e.data.fromId, upcastStep(e.data));
			else unknownVersions++;
		} else if (e.customType === COMPACTION_ENTRY) {
			if (isCheck(e.data)) checks.set(e.data.compactionId, e.data);
			else unknownVersions++;
		}
	}
	for (const s of extraSteps) steps.set(s.fromId, s);
	for (const c of extraChecks) checks.set(c.compactionId, c);
	for (const s of fallbackSteps) if (!steps.has(s.fromId)) steps.set(s.fromId, s);
	return { steps, checks, unknownVersions };
}

/** Turns on the branch with no (final) record yet, oldest first. `skipLast` leaves out a turn still running. */
export function unsummarizedTurns(turns: readonly Turn[], steps: ReadonlyMap<string, TimelineStep>, skipLast: boolean): Turn[] {
	const out: Turn[] = [];
	turns.forEach((t, i) => {
		if (skipLast && i === turns.length - 1) return;
		const s = steps.get(t.fromId);
		if (!s || s.gen.partial) out.push(t);
	});
	return out;
}

/** Split into consecutive batches of `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
	return out;
}

export interface PhaseLine {
	id: string;
	title: string;
	status: StepStatus;
	lastStep: string;
}

/** One line per phase (consecutive steps of the same phase merged; a continuing step joins the one before), oldest first. */
export function phaseList(steps: readonly TimelineStep[]): PhaseLine[] {
	const out: PhaseLine[] = [];
	for (const s of steps) {
		const line = stepLine(s);
		const last = out.at(-1);
		if (last && (last.id === s.phase.id || !s.phase.isNew)) {
			last.title = s.phase.title;
			last.status = s.status;
			last.lastStep = line;
		} else out.push({ id: s.phase.id, title: s.phase.title, status: s.status, lastStep: line });
	}
	return out;
}

/** "intent → result" in one string (for prompts). */
export function stepLine(s: Pick<TimelineStep, "intent" | "summary">): string {
	return s.summary ? `${s.intent} → ${s.summary}` : s.intent;
}

// ---------- view model ----------

export interface ViewPhase {
	kind: "phase";
	id: string;
	title: string;
	/** True when the phase started before the previous compaction marker. */
	continued: boolean;
	startedAt: number;
	endedAt: number;
	steps: TimelineStep[];
	stats: TurnStats;
	status: StepStatus;
	failed: number;
	/** Completion score of the phase's latest scored step. */
	score?: StepScoreV1;
}
export interface ViewCompaction {
	kind: "compaction";
	entryId: string;
	at: number;
	tokensBefore: number;
	check?: CompactionCheckV1;
}
export type ViewItem = ViewPhase | ViewCompaction;
export interface TimelineView {
	items: ViewItem[];
	goal: string;
	lastStep?: TimelineStep;
	/** Id of the branch's latest user message (the turn predictions must belong to). */
	latestTurnId?: string;
	/** Predictions of the latest turn; absent once you send a new message or the latest turn has none. */
	next?: NextV1;
	steps: number;
	failed: number;
	unknownVersions: number;
}

/**
 * Timeline in branch order. A step sits where its user message is (not where its record was appended);
 * a compaction marker sits where Pi's compaction entry is and splits a phase that runs across it.
 */
export function buildView(
	branch: readonly Entry[],
	extraSteps: readonly TimelineStep[] = [],
	extraChecks: readonly CompactionCheckV1[] = [],
	fallbackSteps: readonly TimelineStep[] = [],
): TimelineView {
	const { steps, checks, unknownVersions } = collectRecords(branch, extraSteps, extraChecks, fallbackSteps);
	// Turns the assistant never answered (interrupted at once) are not shown; their words reach the next turn's summary.
	const turns = splitTurns(branch);
	const hidden = new Set(turns.filter((t, i) => i < turns.length - 1 && isEmptyTurn(t)).map((t) => t.fromId));
	const items: ViewItem[] = [];
	const seenPhase = new Set<string>();
	let current: ViewPhase | undefined;
	let lastStep: TimelineStep | undefined;
	let latestTurnId: string | undefined;
	/** Effective phase of the previous step: a continuing step (isNew=false) joins it, whatever id it recorded (a re-summarized gap turn may have moved it). */
	let phaseId: string | undefined;
	let count = 0;
	let failed = 0;
	for (const e of branch) {
		if (e.type === "compaction" && e.id) {
			items.push({ kind: "compaction", entryId: e.id, at: entryTime(e), tokensBefore: e.tokensBefore ?? 0, check: checks.get(e.id) });
			current = undefined;
			continue;
		}
		if (e.type !== "message" || !e.id) continue;
		if (isUserText(e)) latestTurnId = e.id;
		const step = steps.get(e.id);
		if (!step || hidden.has(e.id)) continue;
		count++;
		if (!step.gen.ok) failed++;
		lastStep = step;
		const pid = !step.phase.isNew && phaseId ? phaseId : step.phase.id;
		phaseId = pid;
		if (!current || current.id !== pid) {
			current = {
				kind: "phase",
				id: pid,
				title: step.phase.title,
				continued: seenPhase.has(pid),
				startedAt: step.startedAt,
				endedAt: step.endedAt,
				steps: [],
				stats: emptyStats(),
				status: step.status,
				failed: 0,
			};
			seenPhase.add(pid);
			items.push(current);
		}
		current.steps.push(step);
		current.endedAt = step.endedAt;
		current.stats = addStats(current.stats, step.stats);
		current.status = step.status;
		if (step.score) current.score = step.score;
		if (!step.gen.ok) current.failed++;
	}
	// A phase's title is the one its latest step (in branch order) gave it, also for the part before a compaction.
	const titles = new Map<string, string>();
	for (const item of items) if (item.kind === "phase") titles.set(item.id, item.steps.at(-1)?.phase.title ?? item.title);
	for (const item of items) if (item.kind === "phase") item.title = titles.get(item.id) ?? item.title;
	const next = lastStep && lastStep.fromId === latestTurnId && !lastStep.gen.partial ? lastStep.next : undefined;
	return {
		items,
		goal: lastStep?.goal ?? "",
		lastStep,
		latestTurnId,
		next: next && (next.steps.length || next.directions.length) ? next : undefined,
		steps: count,
		failed,
		unknownVersions,
	};
}

/** Phases before a compaction entry, newest last (for the Jev coverage questions). */
export function phasesBefore(view: TimelineView, compactionId: string): ViewPhase[] {
	const out: ViewPhase[] = [];
	for (const item of view.items) {
		if (item.kind === "compaction" && item.entryId === compactionId) break;
		if (item.kind === "phase") {
			const prev = out.findIndex((p) => p.id === item.id);
			if (prev >= 0) out.splice(prev, 1);
			out.push(item);
		}
	}
	return out;
}

/** Up to `n` of the user's latest messages before `entryId` (raw text for Jev, redacted and clipped). */
export function userMessagesBefore(branch: readonly Entry[], entryId: string, n: number, chars: number): string[] {
	const out: string[] = [];
	for (const e of branch) {
		if (e.id === entryId) break;
		if (isUserText(e)) out.push(clip(redact(textOf(e.message?.content)), chars));
	}
	return out.slice(-n);
}

export interface KeptMessage {
	role: "user" | "assistant";
	text: string;
}

/**
 * Messages Pi keeps verbatim after a compaction (from its `firstKeptEntryId` up to the compaction entry):
 * the user's text and the assistant's text replies only (no thinking, tool calls or tool output), newest `n`.
 */
export function keptMessages(branch: readonly Entry[], compactionId: string, n: number, chars: number): KeptMessage[] {
	const end = branch.findIndex((e) => e.id === compactionId);
	if (end < 0) return [];
	const firstKept = branch[end].firstKeptEntryId;
	const start = firstKept ? branch.findIndex((e) => e.id === firstKept) : -1;
	if (start < 0 || start >= end) return [];
	const out: KeptMessage[] = [];
	for (const e of branch.slice(start, end)) {
		if (e.type !== "message") continue;
		const role = e.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textOf(e.message?.content);
		if (text) out.push({ role, text: clip(redact(text), chars) });
	}
	return out.slice(-n);
}

// ---------- summary model output ----------

/** Index of the `}` that closes the `{` at `open`, ignoring braces inside JSON strings. */
function matchBrace(text: string, open: number): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = open; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			continue;
		}
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

/** Prefer a timeline summary over a stray `{...}` the model mentioned while thinking. */
function summaryShape(raw: Record<string, unknown>): number {
	let score = 1;
	if (typeof raw.intent === "string" || Array.isArray(raw.turns)) score += 8;
	if (typeof raw.phase_title === "string" || typeof raw.continue_phase === "boolean") score += 4;
	if (typeof raw.status === "string" || typeof raw.goal === "string") score += 2;
	return score;
}

/**
 * Every complete `{...}` in the reply. A leading broken brace used to swallow the real object
 * (first `{` through last `}`). Ties keep the later object: drafts come first, the answer last.
 */
function scanJsonObject(text: string): Record<string, unknown> | undefined {
	let best: Record<string, unknown> | undefined;
	let bestScore = 0;
	let bestAt = -1;
	for (let i = 0; i < text.length; i++) {
		if (text[i] !== "{") continue;
		const end = matchBrace(text, i);
		if (end < 0) continue;
		try {
			const raw = JSON.parse(text.slice(i, end + 1)) as unknown;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const obj = raw as Record<string, unknown>;
			const score = summaryShape(obj);
			if (!best || score > bestScore || (score === bestScore && i >= bestAt)) {
				best = obj;
				bestScore = score;
				bestAt = i;
			}
		} catch {
			// A later object may still parse.
		}
	}
	return best;
}

/**
 * Pull the JSON object out of a model reply (code fences and chatter tolerated).
 * The span from the first `{` to the last `}` wins when it parses, so a batch wrapper is not
 * replaced by a turn object nested inside it. Scanning is only the fallback for a broken span.
 */
export function parseJsonObject(text: string): Record<string, unknown> | string {
	const t = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
	const start = t.indexOf("{");
	const end = t.lastIndexOf("}");
	if (start < 0 || end <= start) return "回复里没有 JSON 对象";
	try {
		const raw = JSON.parse(t.slice(start, end + 1)) as unknown;
		if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
	} catch {
		const found = scanJsonObject(t);
		if (found) return found;
		return "JSON 解析失败: 没有可解析的对象";
	}
	const found = scanJsonObject(t);
	if (found) return found;
	return "不是 JSON 对象";
}

/** True when the reply had no usable JSON object, as opposed to a JSON object that failed field checks. */
export function isJsonExtractError(error: string): boolean {
	return error === "回复里没有 JSON 对象" || error === "不是 JSON 对象" || error.startsWith("JSON 解析失败");
}

export const LIMITS = { intent: 40, result: 56, title: 24, goal: 40, next: 32, direction: 40, brief: 50, decision: 32, decisions: 3, now: 44 };
/** Display/prompt length targets above must never clip the text used for copying or filling. */
export const PREDICTION_TEXT_MAX = 4096;

function sameText(a: string, b: string): boolean {
	const norm = (s: string) => s.replace(/[\s，。,.、；;：:！!？?]/g, "");
	return norm(a) === norm(b);
}

function stringList(value: unknown, max: number, each: number): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const v of value) {
		const s = oneLine(v, each);
		if (s && !out.some((o) => sameText(o, s))) out.push(s);
		if (out.length >= max) break;
	}
	return out;
}

function predictionList(value: unknown, max: number): string[] | string {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const v of value) {
		const text = oneLine(v, Infinity);
		if (text.length > PREDICTION_TEXT_MAX) return `预测文本超过 ${PREDICTION_TEXT_MAX} 字符，未截断保存`;
		if (text && !out.some((other) => sameText(other, text))) out.push(text);
		if (out.length >= max) break;
	}
	return out;
}

/** Next-message candidates that are empty placeholders, not something the user would type. */
export function isVagueNext(text: string): boolean {
	const t = text.replace(/\s+/g, "").toLowerCase();
	return /^(继续|好的|下一步|继续吧|继续做|ok|okay|next)$/.test(t);
}

export function scrubNextSteps(steps: readonly string[]): string[] {
	return steps.filter((s) => s.trim() && !isVagueNext(s));
}

type TurnFields = Omit<BatchTurnOutput, "id">;

function validateTurnFields(r: Record<string, unknown>): TurnFields | string {
	const intent = oneLine(r.intent, LIMITS.intent) || oneLine(r.step, LIMITS.intent); // `step` = v1 field name
	let result = oneLine(r.result, LIMITS.result);
	const phase_title = oneLine(r.phase_title, LIMITS.title);
	const goal = oneLine(r.goal, LIMITS.goal);
	const status = r.status;
	if (!intent) return "缺少 intent";
	if (!phase_title) return "缺少 phase_title";
	if (typeof r.continue_phase !== "boolean") return "continue_phase 不是布尔值";
	if (typeof status !== "string" || !STEP_STATUSES.includes(status as StepStatus)) return `status 非法: ${String(status)}`;
	if (sameText(result, intent)) result = "";
	const decisions = stringList(r.decisions, LIMITS.decisions, LIMITS.decision);
	return { continue_phase: r.continue_phase, phase_title, intent, result, decisions, status: status as StepStatus, goal };
}

/** Validate Gemini's JSON for one turn; returns an error string instead of throwing so the caller can record it. */
export function validateSummary(raw: Record<string, unknown> | null | undefined): SummaryOutput | string {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "不是 JSON 对象";
	const fields = validateTurnFields(raw);
	if (typeof fields === "string") return fields;
	const next = predictionList(raw.next, 5);
	const directions = fields.status === "done" ? predictionList(raw.directions, 2) : [];
	if (typeof next === "string") return next;
	if (typeof directions === "string") return directions;
	return {
		...fields,
		now: oneLine(raw.now, LIMITS.now),
		next,
		directions,
	};
}

export function parseSummary(text: string): SummaryOutput | string {
	const raw = parseJsonObject(text);
	return typeof raw === "string" ? raw : validateSummary(raw);
}

export interface ParsedBatch {
	/** Per requested id: the validated turn, or why it is missing / invalid. */
	turns: Map<string, TurnFields | string>;
	/** Where the session stands after the batch's last turn ("" when not given). */
	now: string;
	next: string[];
	directions: string[];
}

/** Validate a batched reply. One bad turn does not sink the others; a reply that is not JSON at all fails whole. */
export function parseBatch(text: string, ids: readonly string[]): ParsedBatch | string {
	const raw = parseJsonObject(text);
	if (typeof raw === "string") return raw;
	if (!Array.isArray(raw.turns)) return "缺少 turns 数组";
	const byId = new Map<string, Record<string, unknown>>();
	for (const t of raw.turns as unknown[]) {
		if (t && typeof t === "object" && !Array.isArray(t) && typeof (t as { id?: unknown }).id === "string") {
			byId.set((t as { id: string }).id, t as Record<string, unknown>);
		}
	}
	const turns = new Map<string, TurnFields | string>();
	for (const id of ids) {
		const t = byId.get(id);
		turns.set(id, t ? validateTurnFields(t) : `回复里没有 ${id}`);
	}
	const lastId = ids.at(-1);
	const last = lastId ? turns.get(lastId) : undefined;
	const done = !!last && typeof last !== "string" && last.status === "done";
	const next = predictionList(raw.next, 5);
	const directions = done ? predictionList(raw.directions, 2) : [];
	if (typeof next === "string") return next;
	if (typeof directions === "string") return directions;
	return {
		turns,
		now: oneLine(raw.now, LIMITS.now),
		next,
		directions,
	};
}

// ---------- line wrapping (sidebar) ----------

/** Closing punctuation that must not start a line (Chinese line-breaking rule). */
const NO_LINE_START = /^[\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f\uff09\u300b\u300d\u300f\u3011\u201d\u2019,.;:!?)\]}%\u2026\u00b7]/u;

/**
 * Greedy wrap of plain text into lines of at most `room` columns: ASCII words stay whole (split only when longer
 * than a line), CJK breaks between characters, and a line never starts with closing punctuation (the character
 * before it moves down with it). `width` is the display-width function (pi-tui's visibleWidth in the sidebar).
 */
export function wrapText(text: string, room: number, width: (s: string) => number): string[] {
	const max = Math.max(2, room);
	const units = text.replace(/\s+/g, " ").trim().match(/[A-Za-z0-9_\-./:@#+=~&$<>'"]+| |[^ ]/gu) ?? [];
	const lines: string[] = [];
	let cur = "";
	let curW = 0;
	const push = () => {
		lines.push(cur.trimEnd());
		cur = "";
		curW = 0;
	};
	for (const u of units) {
		const w = width(u);
		if (u === " ") {
			if (cur && curW + 1 <= max) {
				cur += u;
				curW += 1;
			}
			continue;
		}
		if (w > max) {
			for (const ch of u) {
				const cw = width(ch);
				if (curW + cw > max) push();
				cur += ch;
				curW += cw;
			}
			continue;
		}
		if (curW + w > max) {
			const chars = [...cur.trimEnd()];
			// Closing punctuation may not open a line: pull the whole trailing punct cluster plus the body
			// character before it, but only when that fit still leaves something on the previous line.
			if (NO_LINE_START.test(u) && chars.length > 1) {
				let take = 0;
				while (take < chars.length && NO_LINE_START.test(chars[chars.length - 1 - take] ?? "")) take++;
				if (take < chars.length) take++; // one non-punctuation body character
				const pulled = chars.slice(-take).join("");
				if (chars.length > take && width(pulled) + w <= max) {
					cur = chars.slice(0, -take).join("");
					push();
					cur = pulled;
					curW = width(pulled);
				} else push();
			} else push();
		}
		cur += u;
		curW += w;
	}
	if (cur.trim()) push();
	avoidWidow(lines, max, width);
	return lines;
}

const HAN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** A last line of one lone CJK character reads badly: pull the character before it down ("需手动登\n录" → "需手动\n登录"). */
function avoidWidow(lines: string[], max: number, width: (s: string) => number): void {
	if (lines.length < 2) return;
	const last = lines[lines.length - 1];
	const lastChars = [...last];
	const body = lastChars.filter((c) => !NO_LINE_START.test(c));
	if (body.length !== 1 || !HAN.test(body[0])) return;
	const prev = [...lines[lines.length - 2]];
	// Take one character, or two when the one at the end is punctuation that may not open a line.
	let take = 1;
	if (NO_LINE_START.test(prev[prev.length - 1] ?? "")) take = 2;
	const moved = prev.slice(-take);
	if (prev.length - take < 2 || !HAN.test(moved[0]) || (take === 2 && !NO_LINE_START.test(moved[1]))) return;
	const next = `${moved.join("")}${last}`;
	if (width(next) > max) return;
	lines[lines.length - 2] = prev.slice(0, -take).join("");
	lines[lines.length - 1] = next;
}

/**
 * Gemini's one-line gist of a compaction summary's goal section. Must contain Chinese (the point is to not show
 * English); quotes, a leading label and markdown are dropped.
 */
export function parseBrief(text: string): string | undefined {
	const line = text
		.replace(/```[a-z]*\n?|```/gi, "")
		.split("\n")
		.map((l) => l.trim())
		.find(Boolean);
	if (!line) return undefined;
	const out = line
		.replace(/\*\*/g, "")
		.replace(/^[-*#>\s]+/, "")
		.replace(/^(压缩后的?)?目标[:：]\s*/, "")
		.replace(/^["'“”「『]+|["'“”」』]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!out || !HAN.test(out)) return undefined;
	return [...out].length > LIMITS.brief ? `${[...out].slice(0, LIMITS.brief - 1).join("")}…` : out;
}

// ---------- small-print formatting ----------

export function formatDuration(ms: number): string {
	const min = Math.round(ms / 60000);
	if (min < 1) return `${Math.max(1, Math.round(ms / 1000))}秒`;
	if (min < 60) return `${min}分`;
	return `${Math.floor(min / 60)}时${min % 60 ? `${min % 60}分` : ""}`;
}

export function formatClock(ms: number): string {
	if (!ms) return "--:--";
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export type Tone = "muted" | "warn" | "ok" | "add" | "bad";

/** Plain-text small-print parts for a stats block, in display order; each module can be switched off. */
export function statsParts(s: TurnStats, modules: Record<ModuleName, boolean>): { text: string; tone: Tone }[] {
	const parts: { text: string; tone: Tone }[] = [];
	if (modules.tools) {
		const t = s.tools;
		const bits = [
			t.read && `读${t.read}`,
			t.edit && `改${t.edit}`,
			t.run && `跑${t.run}`,
			t.search && `搜${t.search}`,
			t.ask && `问${t.ask}`,
			t.other && `其他${t.other}`,
		].filter(Boolean);
		if (bits.length) parts.push({ text: bits.join(" "), tone: "muted" });
	}
	if (modules.diff && (s.added || s.removed || s.files.length)) {
		parts.push({ text: `+${s.added}−${s.removed}${s.files.length ? ` ${s.files.length}文件` : ""}`, tone: "add" });
	}
	if (modules.agents && s.agents.length) parts.push({ text: `代理 ${s.agents.join(",")}`, tone: "muted" });
	if (modules.errors && s.errors) parts.push({ text: `⚠${s.errors}`, tone: "warn" });
	if (modules.commits && s.commits) parts.push({ text: `✓commit${s.commits > 1 ? `×${s.commits}` : ""}`, tone: "ok" });
	if (modules.cost && s.cost > 0) parts.push({ text: `$${s.cost.toFixed(s.cost < 1 ? 3 : 2)}`, tone: "muted" });
	if (modules.duration && s.durationMs > 0) parts.push({ text: formatDuration(s.durationMs), tone: "muted" });
	return parts;
}

/** Score confidence below this is shown as "unsure" instead of a verdict (TypeSafe docs' suggested floor). */
export const JEV_UNSURE = 0.5;

/** "85%" for a Jev completion score (tone by level; grey + "?" when Jev is unsure). */
/** Off-intent Noul at or above this is flagged. Above 0.5 on purpose: a false "偏题" costs more trust than a missed one. */
export const OFF_INTENT_SHOW = 0.6;

/**
 * What the sidebar flags about a turn's score (the numbers themselves are not shown). Only rubric-2 scores count:
 * older ones were made without the previous reply / mid-turn decisions and were often wrong.
 * notDone = Jev is sure most of it did not get done and it is not just waiting on the user or an outside factor.
 */
export function scoreFlags(score: StepScoreV1 | undefined): { offIntent: boolean; notDone: boolean } {
	if (!score || score.rubric !== 2) return { offIntent: false, notDone: false };
	return {
		offIntent: score.offIntent >= OFF_INTENT_SHOW,
		notDone: score.completion < 0.5 && score.confidence >= JEV_UNSURE && (score.waiting ?? 0) < 0.5,
	};
}

/**
 * What is wrong with a compaction, per its Jev check (empty = nothing found, the sidebar shows one line).
 * Direction counts only when Jev is sure (Score confidence); the others are Nouls (no confidence).
 */
export function compactionProblems(check: CompactionCheckV1 | undefined): string[] {
	const j = check?.jev;
	if (!j) return [];
	const out: string[] = [];
	if (j.confidence >= JEV_UNSURE && j.consistency < 0.5) out.push("压缩后的目标和之前不是一个方向");
	if (j.invented >= 0.5) out.push("摘要里有你没提过的目标");
	if (j.currentCovered >= 0 && j.currentCovered < 0.5) out.push("压缩后看不出当前在做的事");
	const missed = j.phases.filter((p) => p.covered < 0.5).map((p) => p.title);
	if (missed.length) out.push(`漏了 ${missed.join("、")}`);
	return out;
}

export function scorePart(score: StepScoreV1 | undefined): { text: string; tone: Tone } | undefined {
	if (!score) return undefined;
	const pct = Math.round(score.completion * 100);
	if (score.confidence < JEV_UNSURE) return { text: `${pct}%?`, tone: "muted" };
	return { text: `${pct}%`, tone: pct >= 70 ? "ok" : pct >= 40 ? "warn" : "bad" };
}

/** A one-line reading of a compaction goal section: first bullet lines joined, markdown and status marks stripped. */
export function goalLine(section: string, maxChars = 120): string {
	const lines = section
		.split("\n")
		.map((l) =>
			l
				.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
				.replace(/^\[[ xX]\]\s*/, "")
				.replace(/\*\*|__|`/g, "")
				.trim(),
		)
		.filter(Boolean);
	const joined = lines.slice(0, 2).join("；");
	return [...joined].length > maxChars ? `${[...joined].slice(0, maxChars - 1).join("")}…` : joined;
}

export function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

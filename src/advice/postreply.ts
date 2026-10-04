/** Gemini generates DIRECTION+ACTION; Jev only judges worth. Failed is not empty. */

import type { SessionLine } from "./contracts.ts";
import type { SuggestionItem, TaskAssistantAdviceContext } from "./events.ts";
import { LIMITS } from "./limits.ts";
import { capState, jsonValue, sanitizeDeep, sanitizeText } from "./redact.ts";
import { recentLines } from "./session-context.ts";
import { actionList, splitTurns, turnDecisions, type Entry } from "../timeline/core.ts";

/** The anchor the lower pane judges against, pushed by the timeline owner. */
export type AdviceAnchor = Omit<TaskAssistantAdviceContext, "type" | "version">;

export interface PostReplyTarget {
	sessionId: string;
	replyEntryId: string;
	user: string;
	reply: string;
	waiting: boolean;
	waitingExcerpt: string;
	compactionId?: string;
	compactionExcerpt?: string;
	recent: SessionLine[];
	branchIds: string[];
	/** Direct facts from this turn, available even before the timeline summary finishes. */
	currentDecisions: string[];
	toolActions: string;
	/** Goal + settled decisions + the user's own words. Absent when the timeline is off or has not pushed yet. */
	anchor?: AdviceAnchor;
	/** Next-message texts the upper pane already shows; never repeat them. */
	covered?: string[];
}

export interface RawSuggestion {
	label: string;
	prompt: string;
	/** "What this rests on": the user's words or a settled decision. */
	evidence?: string;
}

export interface GeneratedSuggestions {
	directions: RawSuggestion[];
	actions: RawSuggestion[];
}

export type GenerateResult =
	| { kind: "ok"; value: GeneratedSuggestions }
	| { kind: "failed"; error: string }
	| { kind: "empty"; dropped?: number };

export type JudgeResult =
	| { kind: "ready"; directions: SuggestionItem[]; actions: SuggestionItem[] }
	| { kind: "empty" }
	| { kind: "failed"; error: string };

type EntryLike = {
	id?: string;
	type?: string;
	message?: { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };
	summary?: string;
};

function asEntry(value: unknown): EntryLike | undefined {
	if (!value || typeof value !== "object") return undefined;
	return value as EntryLike;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("\n");
}

const sentenceSegmenter = new Intl.Segmenter("zh", { granularity: "sentence" });

function sentenceCount(text: string): number {
	// Code and URL punctuation is not prose. Keep trailing sentence marks outside URLs.
	const prose = text
		.replace(/`[^`\n]+`/gu, "代码")
		.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`，。；！？、（）【】]+/giu, (url) => `网址${url.match(/[.!?]+$/u)?.[0] ?? ""}`);
	return [...sentenceSegmenter.segment(prose)].filter((part) => /[\p{L}\p{N}]/u.test(part.segment)).length;
}

function looksGenericContinue(text: string): boolean {
	return /^(继续|下一步|按你说的做|go on|continue)\s*$/iu.test(text.trim());
}

/**
 * Equality for cross-pane de-duplication: punctuation, spacing and case do not make two items different.
 * Matches the timeline's own comparison (`sameText` in core.ts) so both panes agree on what "the same" means.
 */
export function normalizeForCompare(text: string): string {
	return text
		.replace(/[\s，。,.、；;：:！!？?“”"'（）()【】\[\]`·—\-]/gu, "")
		.toLowerCase();
}

/** Character bigrams, for a cheap near-duplicate check on top of exact equality. */
function bigrams(text: string): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + 1 < text.length; i++) out.add(text.slice(i, i + 2));
	return out;
}

/** Two items are the same when normalization matches, one contains the other, or bigrams mostly overlap. */
export function sameSuggestion(a: string, b: string): boolean {
	const x = normalizeForCompare(a);
	const y = normalizeForCompare(b);
	if (!x || !y) return false;
	if (x === y) return true;
	if (x.length >= 6 && y.includes(x)) return true;
	if (y.length >= 6 && x.includes(y)) return true;
	const bx = bigrams(x);
	const by = bigrams(y);
	if (bx.size < 4 || by.size < 4) return false;
	let shared = 0;
	for (const g of bx) if (by.has(g)) shared++;
	return shared / Math.min(bx.size, by.size) >= 0.72;
}

/** Does this item restate something the upper pane already shows? */
export function coveredByUpperPane(label: string, prompt: string, covered: readonly string[]): boolean {
	return covered.some((c) => sameSuggestion(label, c) || sameSuggestion(prompt, c));
}

/**
 * The upper pane owns conversation prediction, so the lower pane yields: a candidate that repeats a shown
 * prediction is dropped, not down-scored. Returns the kept items and the dropped labels.
 */
export function dropCovered(
	generated: GeneratedSuggestions,
	covered: readonly string[],
): { kept: GeneratedSuggestions; dropped: string[] } {
	if (!covered.length) return { kept: generated, dropped: [] };
	const dropped: string[] = [];
	const keep = (rows: readonly RawSuggestion[]) =>
		rows.filter((row) => {
			if (!coveredByUpperPane(row.label, row.prompt, covered)) return true;
			dropped.push(row.label);
			return false;
		});
	return { kept: { directions: keep(generated.directions), actions: keep(generated.actions) }, dropped };
}

function looksLikeQuestion(text: string): boolean {
	const tail = text.trim().slice(-240);
	return /[？?]\s*$/.test(tail) || /(?:要不要|还是|哪一个|等你(?:决定|确认|回复)|请(?:确认|问))[^。\n]{0,48}$/.test(tail);
}

function questionStrings(value: unknown, into: string[], depth = 0): void {
	if (depth > 4 || into.length >= 6 || value == null) return;
	if (typeof value === "string") {
		const t = value.trim();
		if (t) into.push(t);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) questionStrings(item, into, depth + 1);
		return;
	}
	if (typeof value !== "object") return;
	const rec = value as Record<string, unknown>;
	for (const key of ["question", "prompt", "header", "text"]) {
		if (typeof rec[key] === "string") questionStrings(rec[key], into, depth + 1);
	}
	if (rec.questions) questionStrings(rec.questions, into, depth + 1);
}

export function unansweredAskQuestions(entries: readonly unknown[]): string[] {
	const asked = new Set<string>();
	const answered = new Set<string>();
	const questions: string[] = [];
	for (const raw of entries) {
		const e = asEntry(raw);
		if (!e) continue;
		const content = e.message?.content;
		if (e.message?.role === "assistant" && Array.isArray(content)) {
			for (const b of content as { type?: string; name?: string; id?: string; arguments?: unknown }[]) {
				if (b?.type === "toolCall" && b.name === "ask_user_question" && b.id) {
					asked.add(b.id);
					questionStrings(b.arguments, questions);
				}
			}
		}
		if (e.message?.toolCallId && (e.message.toolName === "ask_user_question" || asked.has(e.message.toolCallId))) {
			if (!e.message.isError) answered.add(e.message.toolCallId);
		}
	}
	if ([...asked].some((id) => !answered.has(id))) return questions.slice(-3);
	return [];
}

export function branchIds(entries: readonly unknown[]): string[] {
	const out: string[] = [];
	for (const raw of entries) {
		const e = asEntry(raw);
		if (e?.id) out.push(e.id);
	}
	return out;
}

export function onCurrentBranch(entries: readonly unknown[], replyEntryId: string): boolean {
	return branchIds(entries).includes(replyEntryId);
}

/** Latest user+assistant turn that still sits on this branch. */
export function latestSettledReply(entries: readonly unknown[]): { replyEntryId: string; user: string; reply: string } | undefined {
	let user = "";
	let reply = "";
	let replyEntryId = "";
	for (const raw of entries) {
		const e = asEntry(raw);
		if (!e?.message) continue;
		const text = textOf(e.message.content).trim();
		if (!text) continue;
		if (e.message.role === "user") {
			user = text;
			reply = "";
			replyEntryId = "";
		} else if (e.message.role === "assistant" && e.id) {
			reply = text;
			replyEntryId = e.id;
		}
	}
	if (!replyEntryId || !reply) return undefined;
	return { replyEntryId, user, reply };
}

function compactionExcerpt(entries: readonly unknown[]): { id: string; text: string } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = asEntry(entries[i]);
		if (e?.type === "compaction" && e.id) {
			const text = sanitizeText(typeof e.summary === "string" ? e.summary : "", LIMITS.replyTailChars);
			return { id: e.id, text };
		}
	}
	return undefined;
}

export interface TargetExtras {
	/** Timeline-pushed goal anchor, when the timeline owner is present. */
	anchor?: AdviceAnchor;
	/** Texts the upper prediction pane is currently showing. */
	covered?: readonly string[];
}

export function buildPostReplyTarget(sessionId: string, entries: readonly unknown[], extras: TargetExtras = {}): PostReplyTarget | undefined {
	if (!sessionId) return undefined;
	const settled = latestSettledReply(entries);
	if (!settled) return undefined;
	const turn = splitTurns(entries as Entry[]).at(-1);
	const open = unansweredAskQuestions(turn?.entries ?? []);
	const waiting = open.length > 0 || looksLikeQuestion(settled.reply);
	const compaction = compactionExcerpt(entries);
	const anchor = extras.anchor && extras.anchor.sessionId === sessionId && extras.anchor.replyEntryId === settled.replyEntryId ? extras.anchor : undefined;
	const covered = extras.covered?.filter((t) => t.trim());
	return {
		sessionId,
		replyEntryId: settled.replyEntryId,
		user: sanitizeText(settled.user, LIMITS.maxMessageChars),
		reply: sanitizeText(settled.reply, LIMITS.replyHeadChars + LIMITS.replyTailChars),
		waiting,
		waitingExcerpt: sanitizeText(open[0] ?? (waiting ? settled.reply.slice(-240) : ""), LIMITS.maxMessageChars),
		compactionId: compaction?.id,
		compactionExcerpt: compaction?.text,
		recent: recentLines(entries).map((l) => ({ role: l.role, text: sanitizeText(l.text, LIMITS.maxMessageChars) })),
		branchIds: branchIds(entries),
		currentDecisions: turn ? turnDecisions(turn).map((d) => sanitizeText(d, LIMITS.maxMessageChars)) : [],
		toolActions: turn ? sanitizeText(actionList(turn), LIMITS.maxMessageChars * 2) : "",
		...(anchor ? { anchor } : {}),
		...(covered?.length ? { covered: [...covered] } : {}),
	};
}

export function stillFresh(target: PostReplyTarget, sessionId: string, entries: readonly unknown[]): boolean {
	if (target.sessionId !== sessionId) return false;
	if (!onCurrentBranch(entries, target.replyEntryId)) return false;
	const latest = latestSettledReply(entries);
	return latest?.replyEntryId === target.replyEntryId;
}

export function geminiSystemPrompt(waiting: boolean): string {
	const wait = waiting
		? "助手在等用户在几个具体选项里做选择。actions 必须有 1～2 条可点选的回答方案（每个选项一条可执行 prompt），禁止空数组，禁止只写「继续」「下一步」「停下来等你选」，也禁止替用户做决定。"
		: "助手没有在等一个必须先答的问题。确实没有还差的事时，把 directions 和 actions 都填 []。";
	return `你在为一个编程助手会话做**目标闭环检查**：从第三方视角看，用户最初要的东西离做成还差哪几块。你不是在预测用户下一句会打什么字（那是另一个面板的事），也不是在续写这段对话。
${wait}
先看「会话目标」和「用户自己说过的话」「已经定下来的事」，再考虑助手刚说的是什么。助手刚说的话只是线索，不是候选来源：它说「修好了」不等于用户已经验收。
要回答的是三件事：哪些离做成还差、哪些在等用户拍板、哪里和用户原话不一致。
候选优先来自：①用户原话里点明过但还没看到结果的；②已定下来但还没执行的；③已经交到用户手上但还没获用户确认接受的。
严禁：重复助手刚说完的内容、重复已经跑过的验证、写「继续」「下一步」这类空话、把助手自己的建议当成用户已认可的事。
已确认的事不要重复报。大多数轮次只需要 1～2 条，真的没有就填 []，不要凑数量。
每条都要带 evidence：一句话说明这条依据什么（引用用户原话或已定下来的事），最多 ${LIMITS.evidenceChars} 字。注不出依据就不要写这条。
directions：0～2 条离做成还差的大块。actions：0～3 条当下可推进的事。
directions 和 actions 的每条 prompt 都必须是 1～2 句完整祈使句，点选后原样进入输入框。需要多项要求时用逗号或分号连接，不要写成三句以上。
每条 label 最多 ${LIMITS.postReplyLabelChars} 字；directions 的 prompt 最多 ${LIMITS.directionPromptChars} 字，actions 的 prompt 最多 ${LIMITS.actionPromptChars} 字。
不要推荐已经做完或用户否决过的事。不要自动注入技能或 OpenSpec。不要输出 markdown 围栏或解释。
只输出一个 JSON 对象：
{"directions":[{"label":"…","prompt":"…","evidence":"…"}],"actions":[{"label":"…","prompt":"…","evidence":"…"}]}`;
}

/** The goal anchor, rendered above the conversation. The lower pane is anchored here, not on the last reply. */
function anchorBlock(anchor: AdviceAnchor | undefined): string {
	if (!anchor) return "（时间线未推送目标，只能用下面的对话推断；不要把助手自己的建议当成用户已认可的事）";
	const decisions = anchor.decisions.length ? anchor.decisions.map((d) => `- ${d}`).join("\n") : "（还没有）";
	const words = anchor.userMessages.length ? anchor.userMessages.map((m) => `- ${m}`).join("\n") : "（没有）";
	return [`会话目标：${anchor.goal || "（时间线还没总结出来）"}`, "已经定下来的事（用户拍板或答过的，可信，不要重复报它）：", decisions, "用户自己说过的话（最近几条，原话）：", words].join("\n");
}

/**
 * The upper pane owns next-message prediction, so the lower pane is told what is already shown.
 * Without this the two panes converge on the same sentence and the user reads it twice.
 */
function coveredBlock(covered: readonly string[] | undefined): string {
	if (!covered?.length) return "（上面还没有预测）";
	return `上面「预测下一步」已经显示这几句，你的候选不得与它们重复（意思一样也算）：\n${covered.map((t) => `- ${t}`).join("\n")}`;
}

/**
 * Order matters: goal anchor first (the lower pane's topic), the assistant's reply last and marked as a clue only.
 * Putting the reply first is what made the two panes duplicate each other.
 */
export function geminiUserPrompt(target: PostReplyTarget): string {
	return [
		`===== 目标锚（主依据）=====\n${anchorBlock(target.anchor)}`,
		`===== 本轮直接事实 =====\n用户本轮已拍板（工具结果，优先于旧摘要，不要重新询问）：\n${target.currentDecisions.join("\n") || "（无）"}\n本轮工具动作（仅说明调用过，不等于成功；✗ 表示失败）：\n${target.toolActions || "（无）"}`,
		`===== 上面已经显示（不要去重前先看这里）=====\n${coveredBlock(target.covered)}`,
		`===== 对话现状（线索，不是候选来源）=====\n用户最近消息：${target.user || "（无）"}\n助手刚说完：${target.reply || "（无）"}`,
		target.waiting ? `等待用户：${target.waitingExcerpt}` : "等待用户：否",
		target.compactionExcerpt ? `最近压缩摘要：${target.compactionExcerpt}` : "最近压缩：无",
		`更早几轮：\n${target.recent.map((l) => `${l.role}: ${l.text}`).join("\n") || "（无）"}`,
	].join("\n\n");
}

export const POSTREPLY_BUILD = "pr-goal-closure-9";

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

function suggestionScore(raw: Record<string, unknown>): number {
	return (Array.isArray(raw.directions) ? 2 : 0) + (Array.isArray(raw.actions) ? 2 : 0);
}

function syntaxError(err: unknown): string {
	const msg = err instanceof Error ? err.message : String(err);
	if (/end of JSON|Unexpected end/i.test(msg)) return "不完整 JSON";
	return `JSON 语法错误：${msg.slice(0, 80)}`;
}

/** Complete schema objects only. An unclosed intended object is not replaced by a nested non-schema `{...}`. */
function extractJsonObject(text: string): Record<string, unknown> | string {
	const trimmed = text.trim();
	if (!trimmed) return "不是 JSON 对象";
	const fenced = /^```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
	const body = (fenced?.[1] ?? trimmed).trim();
	const complete: { start: number; end: number; obj: Record<string, unknown>; score: number }[] = [];
	let unclosed = false;
	let syntax: string | undefined;
	for (let i = 0; i < body.length; i++) {
		if (body[i] !== "{") continue;
		const end = matchBrace(body, i);
		if (end < 0) {
			unclosed = true;
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(body.slice(i, end + 1));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				const obj = parsed as Record<string, unknown>;
				complete.push({ start: i, end, obj, score: suggestionScore(obj) });
			}
		} catch (err) {
			syntax ??= syntaxError(err);
		}
	}
	const schema = complete.filter((c) => c.score >= 4);
	if (schema.length === 1) return schema[0].obj;
	if (schema.length > 1) {
		schema.sort((a, b) => a.start - b.start || b.end - a.end);
		const outer = schema[0];
		if (schema.some((c) => c.end < outer.start || c.start > outer.end)) return "多个完整 JSON 对象";
		return outer.obj;
	}
	if (unclosed) return "不完整 JSON";
	if (syntax) return syntax;
	if (complete.length) return "缺少 directions/actions";
	if (!body.includes("{")) return "不是 JSON 对象";
	try {
		JSON.parse(body);
	} catch (err) {
		return syntaxError(err);
	}
	return "不是 JSON 对象";
}

function parseRawList(value: unknown, max: number): RawSuggestion[] | string {
	if (!Array.isArray(value)) return "缺少数组";
	const out: RawSuggestion[] = [];
	for (const row of value) {
		if (!row || typeof row !== "object" || Array.isArray(row)) return "条目不是对象";
		const rec = row as { label?: unknown; prompt?: unknown; evidence?: unknown };
		if (typeof rec.label !== "string" || typeof rec.prompt !== "string") return "缺少 label/prompt";
		const normalized = [rec.label, rec.prompt, typeof rec.evidence === "string" ? rec.evidence : ""].map((text) => text.replace(/\s+/g, " ").trim());
		if (normalized.some((text) => text.length > LIMITS.postReplyTextMax)) return `条目文本超过 ${LIMITS.postReplyTextMax} 字符，未截断保存`;
		// Sanitize secrets, but never run these complete UI/copy strings through the short-text clip.
		const [label, prompt, evidence] = normalized.map((text) => sanitizeText(text, LIMITS.postReplyTextMax));
		if (!label || !prompt) return "空的 label/prompt";
		if (sentenceCount(prompt) > 2) return "prompt 超过两句";
		if (!evidence) return "缺少有效 evidence";
		out.push({ label, prompt, evidence });
		if (out.length >= max) break;
	}
	return out;
}

/** Strict schema: malformed JSON is failed, not empty. */
export function parseGenerated(text: string, waiting: boolean): GenerateResult {
	const raw = extractJsonObject(text);
	if (typeof raw === "string") return { kind: "failed", error: raw };
	const directions = parseRawList(raw.directions, LIMITS.maxDirections);
	const actions = parseRawList(raw.actions, LIMITS.maxActions);
	if (typeof directions === "string") return { kind: "failed", error: `directions ${directions}` };
	if (typeof actions === "string") return { kind: "failed", error: `actions ${actions}` };
	if (waiting && actions.length > 0 && actions.every((a) => looksGenericContinue(a.prompt) || looksGenericContinue(a.label))) {
		return { kind: "failed", error: "等待回答时只有空泛继续" };
	}
	if (waiting) {
		const kept = actions.filter((a) => !looksGenericContinue(a.prompt) && !looksGenericContinue(a.label));
		if (kept.length === 0) return { kind: "failed", error: "等待回答时缺少可选方案" };
		return { kind: "ok", value: { directions, actions: kept } };
	}
	if (directions.length === 0 && actions.length === 0) return { kind: "empty" };
	return { kind: "ok", value: { directions, actions } };
}

export function isJsonShapeError(error: string): boolean {
	return (
		error === "不是 JSON 对象" ||
		error === "不完整 JSON" ||
		error === "输出被截断" ||
		error === "多个完整 JSON 对象" ||
		error === "缺少 directions/actions" ||
		error.startsWith("JSON 语法错误") ||
		error.startsWith("directions ") ||
		error.startsWith("actions ") ||
		error === "等待回答时只有空泛继续" ||
		error === "等待回答时缺少可选方案"
	);
}

/** Visible text first. Thinking is used only when visible text has no `{`. Corrupted visible JSON is not replaced from thinking. */
export function selectParsedGeneration(text: string | undefined, thinking: string | undefined, waiting: boolean): GenerateResult {
	const visible = text?.trim() ?? "";
	const thought = thinking?.trim() ?? "";
	if (!visible && !thought) return { kind: "failed", error: "模型没有返回正文" };
	if (visible) {
		const parsed = parseGenerated(visible, waiting);
		if (parsed.kind !== "failed") return parsed;
		if (visible.includes("{") || !thought) return parsed;
	}
	if (thought) {
		const parsed = parseGenerated(thought, waiting);
		if (parsed.kind !== "failed") return parsed;
		if (!visible) return { kind: "failed", error: parsed.error === "不是 JSON 对象" || parsed.error === "不完整 JSON" ? "模型只返回了思考，没有 JSON" : parsed.error };
		return parsed;
	}
	return { kind: "failed", error: "模型没有返回正文" };
}

export interface GenerateCallResult {
	text?: string;
	thinking?: string;
	error?: string;
	stopReason?: string;
}

export async function generateWithRetry(
	target: PostReplyTarget,
	call: (system: string, user: string, thinking: "low" | "off", timeoutMs: number) => Promise<GenerateCallResult>,
	signal: AbortSignal,
	now = () => Date.now(),
): Promise<GenerateResult> {
	const deadline = now() + LIMITS.postReplyBudgetMs;
	let last = "未知错误";
	const attempts = 1 + LIMITS.postReplyRetries;
	for (let i = 0; i < attempts; i++) {
		if (signal.aborted) return { kind: "failed", error: "aborted" };
		const remain = deadline - now();
		if (remain <= 0) return { kind: "failed", error: `超时：${last}` };
		const system = geminiSystemPrompt(target.waiting);
		const user = i === 0 ? geminiUserPrompt(target) : `${geminiUserPrompt(target)}\n\n上次失败：${sanitizeText(last, 180)}。只输出一个合法 JSON 对象，不要 markdown，不要解释。`;
		const r = await call(system, user, i === 0 ? "low" : "off", Math.min(LIMITS.postReplyTimeoutMs, remain));
		if (signal.aborted || r.error === "aborted") return { kind: "failed", error: "aborted" };
		const parsed = selectParsedGeneration(r.text, r.thinking, target.waiting);
		if (parsed.kind !== "failed") return parsed;
		last = parsed.error;
		if (r.stopReason === "length" || (parsed.error === "不完整 JSON" && r.stopReason === "length")) last = "输出被截断";
		else if (!isJsonShapeError(parsed.error) && r.error) last = r.error;
		if (!isJsonShapeError(last) && parsed.error !== "模型没有返回正文" && parsed.error !== "模型只返回了思考，没有 JSON") return parsed;
	}
	return { kind: "failed", error: sanitizeText(last, 180) };
}

export function assignIds(generated: GeneratedSuggestions, revision: number): SuggestionItem[] {
	const out: SuggestionItem[] = [];
	generated.directions.forEach((row, i) => {
		out.push({ id: `d${revision}-${i + 1}`, kind: "direction", label: row.label, prompt: row.prompt, ...(row.evidence ? { evidence: row.evidence } : {}) });
	});
	generated.actions.forEach((row, i) => {
		out.push({ id: `a${revision}-${i + 1}`, kind: "action", label: row.label, prompt: row.prompt, ...(row.evidence ? { evidence: row.evidence } : {}) });
	});
	return out;
}

export function buildJudgeState(target: PostReplyTarget, items: readonly SuggestionItem[]): Record<string, unknown> {
	return capState(
		sanitizeDeep(
			jsonValue({
				goal_anchor: target.anchor
					? { session_goal: target.anchor.goal, settled_decisions: target.anchor.decisions, user_messages: target.anchor.userMessages }
					: { note: "timeline did not push a goal; judge against the user messages below" },
				current_turn_facts: { settled_decisions: target.currentDecisions, tool_actions: target.toolActions },
				already_shown_upstairs: target.covered ?? [],
				conversation: {
					user: target.user,
					assistant_reply_as_clue: target.reply,
					waiting: target.waiting,
					waiting_excerpt: target.waitingExcerpt,
					compaction: target.compactionExcerpt ?? "",
					recent: target.recent,
				},
				candidates: items.map((c) => ({ id: c.id, kind: c.kind, label: c.label, prompt: c.prompt, evidence: c.evidence ?? "" })),
			}),
		) as Record<string, unknown>,
	);
}

export const WAITING_ACTION_LEVELS = [
	"Not a sendable answer to the waiting question: generic continue, already done, or unrelated",
	"Related later, but not an answer the user could send now",
	"A usable answer or clarification the user could send now",
	"The best concrete choice among the options the assistant just asked",
] as const;

export function buildJudgeQuestions(items: readonly SuggestionItem[], waiting = false): Record<string, unknown> {
	const questions: Record<string, unknown> = {};
	for (const item of items) {
		const waitingAction = waiting && item.kind === "action";
		const instructions = waitingAction
			? `The assistant is waiting for a choice. How good is candidate ${item.id} (${item.label}: ${item.prompt}) as a message the user can send now to answer that question? A concrete option is high; generic continue is low.`
			: goalClosureQuestion(item);
		questions[item.id] = {
			type: "score",
			instructions,
			criteria: [...(waitingAction ? WAITING_ACTION_LEVELS : LIMITS.postReplyScoreLevels)],
		};
	}
	return questions;
}

/**
 * The lower pane's rubric: does this push the user's original request toward acceptance?
 * Deliberately different from the upper pane's "would the user type this next" question.
 */
function goalClosureQuestion(item: SuggestionItem): string {
	const kind = item.kind === "direction" ? "a broad remaining chunk" : "a concrete next action";
	return `Judged from the user's original goal (goal_anchor), how much does candidate ${item.id} (${item.label}: ${item.prompt}) move that goal toward being done and accepted? This is a goal-closure check, not a prediction of the user's next typed message. It is ${kind}. Prefer current_turn_facts.settled_decisions over older summaries; do not ask the user to decide an already answered question. tool_actions records calls, not proof of success (✗ marks failure). Already-finished work, rejected ideas, and generic continues do not move the goal.`;
}

function scoreOf(answers: unknown, id: string): { score: number; confidence: number } | undefined {
	if (!answers || typeof answers !== "object") return undefined;
	const row = (answers as Record<string, unknown>)[id];
	if (!row || typeof row !== "object") return undefined;
	const score = (row as { score?: unknown }).score;
	const confidence = (row as { confidence?: unknown }).confidence;
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 3) return undefined;
	// Confidence must be present and in range. It is a certainty signal, not accuracy; missing it is malformed, not 0.
	if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
	return { score, confidence };
}

/** Malformed or missing score/confidence is failed, never empty. Empty is only well-formed scores all below the code threshold. Confidence is not treated as accuracy. Kept items are sorted by score descending; ties keep original order. */
export function judgeItems(items: readonly SuggestionItem[], answers: unknown, minScore: number = LIMITS.postReplyScoreMin): JudgeResult {
	if (!items.length) return { kind: "empty" };
	const scored: { item: SuggestionItem; score: number; ord: number }[] = [];
	for (let ord = 0; ord < items.length; ord++) {
		const item = items[ord];
		const s = scoreOf(answers, item.id);
		if (!s) return { kind: "failed", error: `未判定：${item.id}` };
		if (s.score >= minScore) scored.push({ item, score: s.score, ord });
	}
	if (!scored.length) return { kind: "empty" };
	scored.sort((a, b) => b.score - a.score || a.ord - b.ord);
	return {
		kind: "ready",
		directions: scored.filter((row) => row.item.kind === "direction").map((row) => row.item),
		actions: scored.filter((row) => row.item.kind === "action").map((row) => row.item),
	};
}

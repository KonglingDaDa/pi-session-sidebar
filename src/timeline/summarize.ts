/**
 * Summary model calls (Gemini): one live turn, or a batch of old turns (backfill).
 * Prompt building is pure (tested); calls go through ctx.modelRegistry with request-time auth.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { StepStatus, SummaryOutput, TimelineConfig, TurnStats } from "./contracts.ts";
import { LIMITS, type ParsedBatch, type PhaseLine, isJsonExtractError, parseBatch, parseBrief, parseSummary, redact, statsParts } from "./core.ts";

const FIELD_RULES = `- continue_phase：这一轮是否还在做"当前阶段"那件事。追问、修 bug、补充、验证、按反馈调整同一件事都算 true；换了一个新任务、新话题或另一个模块才算 false。没有当前阶段时填 false。
- phase_title：阶段标题，不超过 ${LIMITS.title - 8} 个汉字，写"在做什么事"的名词短语（例如"时间线侧栏 v2 开发"）。continue_phase 为 true 时可以微调当前标题，让它概括整个阶段，但不能换成别的事。
- intent：用户这一轮要什么，不超过 ${LIMITS.intent - 12} 个汉字，从用户的角度写成动宾短语（例如"搜索北京天气""给时间线加老会话回填"）。依据用户消息，结合会话目标和此前阶段理解。用户消息常常是在回应"助手上一轮回复的结尾"（回答它的问题、同意它的方案、给出它要的东西，或只说"继续 / 好的 / 开始"）：这时写用户借此要推进的那件事（例如"给出中转 key，按计划真机筛题和 A/A"），不要只复述字面（不要写成"提供 key""回复开始"）。不要写成助手做了什么。
- result：这一轮最后做成了什么、得出了什么结论，不超过 ${LIMITS.result - 16} 个汉字，写结果不写过程（例如"回填跑通，60 轮约 1 分钟""定位到压缩后丢失上下文的原因"）。一轮里走了弯路或换了做法时，写最终结果并点出关键转折（例如"筛了三次才得 21 题，A/A 一致"）；只做成一部分时写明还差什么；卡住或在等用户时写清在等什么（例如"工具做完，等你给官方 key"）。依据助手回复和动作清单，不要编造没出现的事实。只有结果不带任何新信息、和 intent 说的是一回事时（例如"搜索北京天气"）才填 ""；助手回答了问题、给了结论或清单，就写那个结论（例如问"需要准备什么"，写"需要真 key，并给出启动命令"）。
- decisions：这一轮**用户**拍板定下、以后会影响做法的决定，0～${LIMITS.decisions} 条，每条不超过 ${LIMITS.decision - 8} 个汉字，写成"定了什么"（例如"弱设置改用 Sonnet 5 low""不二开 ModelTrace，自研"）。只认三种来源：① 这一轮中途用户对助手提问的回答（"中途用户的拍板"里列出的；有就必须写，最多挑最影响后续的几条）；② 用户这一轮消息里明确做的选择、要求或否决（例如"不用 Opus，换 Sonnet""预算别超 30"）；③ 用户这一轮消息明确同意了助手上一轮提出的方案（写同意的是什么）。助手这一轮自己提出的建议、推荐、结论，用户还没表态，都不算（写进 result）；普通执行步骤、助手的中间尝试也不算。大多数轮次没有这样的决定，给 []，宁缺毋滥。
- status：这一轮结束时这件事的状态。done：做完了、有结论；in_progress：还在做，下一轮继续；blocked：卡住了或报错没解决；waiting_user：在等用户拍板或回答问题。
- goal：整个会话此刻的总目标，不超过 ${LIMITS.goal - 12} 个汉字。沿用之前的目标，除非用户明显换了方向；顺带插问一句、问完不接着做的小问题不改总目标。
- 用中文；代码名、文件名、命令可以保留原文。`;

const NOW_RULE = `- now：整个会话此刻站在哪，不超过 ${LIMITS.now - 12} 个汉字：总目标做到哪一步了、卡在哪、在等谁做什么（例如"工具就绪，等你给 Bedrock 凭据开始对比""侧栏 v2 已交付，等你试用反馈"）。这一轮这件事做完不等于总目标做完：总目标还有没做的部分时要写出来。`;

const NEXT_RULES = `- next：5 条用户**下一句可能发给助手的原话**（对话预测，不是任务督导）。每条不超过 ${LIMITS.next - 8} 个汉字，短、具体、能直接放进输入框发出去。依据这一轮用户最后一句、助手回复结尾、以及是否在等用户。status 为 waiting_user 时，第一条必须是对助手所提问题的一个具体回答（不要写"继续"）。不要重复已做完的事、不要空话（禁止"继续""好的""下一步"）、不要把总目标复述成下一句。你认为用户最可能打的那句放前面。
- directions：只在 status 为 done 时填 1～2 条**更大一档的执行方向**（不是下一句原文），每条不超过 ${LIMITS.direction - 10} 个汉字；否则填 []。不要把 directions 写成可发送的下一句，也不要写成目标驱动的任务清单。`;

const INPUTS = `助手上一轮回复的结尾（用户这一轮常常是在回应它）、这一轮的工具统计和动作清单（代码从工具调用里提取的，可信，只有名字没有输出）、这一轮中途用户对助手提问的拍板（可信，是用户本人的决定），以及这一轮用户的消息和助手的正式回复（不含工具输出和思考过程；太长时中间有省略）`;

export function buildSummarySystem(includeNext = true): string {
	const next = includeNext ? NEXT_RULES : `- next：填 []。\n- directions：填 []。回复后建议由其它扩展负责，不要预测用户下一句。`;
	return `你在为一个编程助手会话维护"时间线"，目的是让用户以后回来一眼看清来龙去脉：起因、中间怎么走过来的（转折和拍板）、现在卡在哪、下一步。每次给你：此前的阶段列表、会话目标、${INPUTS}。

只输出一个 JSON 对象，不要输出任何其他文字：
{"continue_phase": true, "phase_title": "…", "intent": "…", "result": "…", "decisions": ["…"], "status": "done", "goal": "…", "now": "…", "next": ["…", "…", "…", "…", "…"], "directions": ["…"]}

字段要求：
${FIELD_RULES}
${NOW_RULE}
${next}`;
}

export const SYSTEM_PROMPT = buildSummarySystem(true);

export const BATCH_SYSTEM_PROMPT = `你在为一个编程助手会话补写"时间线"，目的是让用户以后回来一眼看清来龙去脉：起因、中间怎么走过来的（转折和拍板）、现在卡在哪、下一步。这次一次给你连续的若干轮（T1、T2……，从旧到新），每轮有工具统计、动作清单（代码从工具调用里提取的，可信，只有名字没有输出）、这一轮中途用户对助手提问的拍板（可信，是用户本人的决定）、用户的消息和助手的正式回复（不含工具输出和思考过程；太长时有省略）。T1 还附有它之前那一轮助手回复的结尾；T2 起，"上一轮"就是包里的前一轮。另外给你此前的阶段列表和会话目标。

只输出一个 JSON 对象，不要输出任何其他文字：
{"turns": [{"id": "T1", "continue_phase": false, "phase_title": "…", "intent": "…", "result": "…", "decisions": [], "status": "done", "goal": "…"}], "now": "…", "next": [], "directions": []}

要求：
- turns 里每一轮都要有一条，id 和给你的编号一致，顺序从旧到新。
- T1 的 continue_phase 相对于"此前阶段"的最后一个判断；T2 起相对于它前一轮所在的阶段判断。
- now：针对包里最后一轮结束时，规则见下。
- next / directions：只有提示里写了"这一包含有会话最新一轮"时才按下面的规则填，而且针对最后一轮；否则都给 []。

每轮的字段要求：
${FIELD_RULES}
${NOW_RULE}
${NEXT_RULES}`;

const STATUS_LABEL: Record<StepStatus, string> = {
	done: "完成",
	in_progress: "进行中",
	blocked: "卡住",
	waiting_user: "等用户",
};

const ALL_MODULES = {
	time: true,
	duration: true,
	tools: true,
	diff: true,
	agents: true,
	errors: true,
	commits: true,
	cost: false,
	goal: true,
	compaction: true,
	score: false,
	next: false,
	hints: false,
};

export interface TurnInput {
	forcedContinue: boolean;
	/** End of the assistant's reply before this turn (and unanswered messages since), redacted. "" for the first turn. */
	previous: string;
	/** The user's answers to the assistant's mid-turn questions ("问：… → 用户选：…"). */
	decisions: string[];
	stats: TurnStats;
	actions: string;
	user: string;
	assistant: string;
}

export interface PromptInput extends TurnInput {
	goal: string;
	phases: PhaseLine[];
	/** When false, do not ask Gemini for next/directions (another extension owns that slot). */
	includeNext?: boolean;
}

function phaseBlock(phases: readonly PhaseLine[]): string {
	if (!phases.length) return "（无，这是第一轮）";
	return phases
		.map((p, i) => {
			const current = i === phases.length - 1 ? "  ← 当前阶段" : "";
			return `${i + 1}. [${STATUS_LABEL[p.status]}] ${p.title}（最近一步：${p.lastStep}）${current}`;
		})
		.join("\n");
}

function turnBlock(t: TurnInput, withPrevious = true): string {
	const stats = statsParts(t.stats, ALL_MODULES)
		.map((p) => p.text)
		.join(" · ");
	const forced = t.forcedContinue ? "\n注意：这一轮用户只说了一句'继续'之类的短话，continue_phase 必须为 true。\n" : "";
	const previous = withPrevious ? `上一轮（用户这一轮可能在回应它）：\n<<<\n${t.previous || "（没有，这是第一轮）"}\n>>>\n\n` : "";
	return `${previous}工具统计：${stats || "没有调用工具"}
动作清单：
${t.actions || "（没有）"}
${forced}
这一轮中途用户的拍板（用户对助手提问的回答）：
${t.decisions.length ? t.decisions.join("\n") : "（没有）"}

用户消息：
<<<
${t.user || "（空）"}
>>>

助手正式回复：
<<<
${t.assistant || "（没有文字回复）"}
>>>`;
}

export function buildPrompt(input: PromptInput): string {
	return `会话目标：${input.goal || "（还没有）"}

此前阶段（旧→新）：
${phaseBlock(input.phases.slice(-8))}

===== 本轮 =====
${turnBlock(input)}`;
}

export interface BatchInput {
	goal: string;
	phases: PhaseLine[];
	/** Oldest first; labels are T1, T2, ... in this order. */
	turns: TurnInput[];
	/** The batch holds the branch's latest turn: ask for next / directions. */
	includeNext: boolean;
}

export function batchLabels(n: number): string[] {
	return Array.from({ length: n }, (_, i) => `T${i + 1}`);
}

export function buildBatchPrompt(input: BatchInput): string {
	const labels = batchLabels(input.turns.length);
	const body = input.turns.map((t, i) => `===== ${labels[i]} =====\n${turnBlock(t, i === 0)}`).join("\n\n");
	const tail = input.includeNext ? "这一包含有会话最新一轮（最后一轮），请填 next / directions。" : "这一包不含会话最新一轮，next 和 directions 给 []。";
	return `会话目标：${input.goal || "（还没有）"}

此前阶段（旧→新）：
${phaseBlock(input.phases.slice(-8))}

${body}

${tail}`;
}

export const BRIEF_SYSTEM_PROMPT = `给你编程助手"上下文压缩摘要"里写目标的那一段（通常是英文）。用一句简体中文概括：压缩之后，助手认为自己要做成什么。不超过 ${LIMITS.brief - 10} 个汉字，写目标本身，不写进度、不加评价；产品名、代码名、文件名保留原文。只输出这一句话，不要引号、不要前缀。`;

export function buildBriefPrompt(goalSection: string): string {
	return `目标段落：\n${redact(goalSection)}`;
}

interface CallResult {
	text?: string;
	/** Thought channel. Gemini high thinking sometimes puts the JSON here and leaves text empty. */
	thinking?: string;
	error?: string;
	ms: number;
	model: string;
}

/** Second attempt uses less thinking: high thinking is what returned the empty bodies. */
export function summaryThinkingAttempts(level: TimelineConfig["summary"]["thinking"]): Array<TimelineConfig["summary"]["thinking"]> {
	if (level === "high" || level === "medium") return [level, "low"];
	if (level === "low" || level === "minimal") return [level, "off"];
	return [level];
}

function summaryRetryable(error: string): boolean {
	return error === "模型没有返回正文" || error === "模型只返回了思考，没有 JSON" || isJsonExtractError(error);
}

/**
 * Visible text first. If that has no JSON object, use the thinking channel (the model often drafts the
 * object there and then emits nothing). Field errors in a real JSON object are not papered over.
 */
export function pickModelJson<T>(text: string, thinking: string, parse: (text: string) => T | string): T | string {
	if (!text.trim() && !thinking.trim()) return "模型没有返回正文";
	if (text.trim()) {
		const parsed = parse(text);
		if (typeof parsed !== "string") return parsed;
		if (!summaryRetryable(parsed) || !thinking.trim()) return parsed;
	}
	if (thinking.trim()) {
		const parsed = parse(thinking);
		if (typeof parsed !== "string") return parsed;
		if (!text.trim()) return "模型只返回了思考，没有 JSON";
		return parsed;
	}
	return "模型没有返回正文";
}

async function callModel(
	ctx: ExtensionContext,
	cfg: TimelineConfig,
	system: string,
	prompt: string,
	timeoutMs: number,
	thinking: TimelineConfig["summary"]["thinking"] = cfg.summary.thinking,
): Promise<CallResult> {
	const started = Date.now();
	const label = `${cfg.summary.provider}/${cfg.summary.model}`;
	const model = ctx.modelRegistry.find(cfg.summary.provider, cfg.summary.model);
	if (!model) return { error: `找不到模型 ${label}`, ms: 0, model: label };
	try {
		// Prompt pieces are already redacted upstream; mask again here so a missed path cannot leak keys.
		const safePrompt = redact(prompt);
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: safePrompt }], timestamp: Date.now() }] },
			{
				reasoning: thinking === "off" ? undefined : thinking,
				maxTokens: 16384,
				cacheRetention: "none",
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		const reply = await stream.result();
		const ms = Date.now() - started;
		if (reply.stopReason === "error" || reply.stopReason === "aborted") {
			return { error: reply.errorMessage || `模型返回 ${reply.stopReason}`, ms, model: label };
		}
		const text = reply.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
		const thought = reply.content.flatMap((b) => (b.type === "thinking" ? [b.thinking] : [])).join("\n");
		return { text, thinking: thought, ms, model: label };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), ms: Date.now() - started, model: label };
	}
}

export interface SummaryResult {
	ok: boolean;
	output?: SummaryOutput;
	error?: string;
	ms: number;
	model: string;
}

async function callJson<T>(
	ctx: ExtensionContext,
	cfg: TimelineConfig,
	system: string,
	prompt: string,
	timeoutMs: number,
	parse: (text: string) => T | string,
): Promise<{ ok: true; value: T; ms: number; model: string } | { ok: false; error: string; ms: number; model: string }> {
	const levels = summaryThinkingAttempts(cfg.summary.thinking);
	let ms = 0;
	let model = `${cfg.summary.provider}/${cfg.summary.model}`;
	let error = "未知错误";
	for (let i = 0; i < levels.length; i++) {
		const r = await callModel(ctx, cfg, system, prompt, timeoutMs, levels[i]);
		ms += r.ms;
		model = r.model;
		if (r.text === undefined) {
			error = r.error ?? error;
			break;
		}
		const picked = pickModelJson(r.text, r.thinking ?? "", parse);
		if (typeof picked !== "string") return { ok: true, value: picked, ms, model };
		error = picked;
		if (i === 0 && summaryRetryable(picked) && levels.length > 1) continue;
		break;
	}
	return { ok: false, error, ms, model };
}

export async function summarizeTurn(ctx: ExtensionContext, cfg: TimelineConfig, input: PromptInput): Promise<SummaryResult> {
	const r = await callJson(ctx, cfg, buildSummarySystem(input.includeNext !== false), buildPrompt(input), cfg.summary.timeoutMs, parseSummary);
	if (!r.ok) return { ok: false, error: r.error, ms: r.ms, model: r.model };
	return { ok: true, output: r.value, ms: r.ms, model: r.model };
}

export interface BatchResult {
	ok: boolean;
	parsed?: ParsedBatch;
	error?: string;
	ms: number;
	model: string;
}

export async function summarizeBatch(ctx: ExtensionContext, cfg: TimelineConfig, input: BatchInput): Promise<BatchResult> {
	const ids = batchLabels(input.turns.length);
	const r = await callJson(ctx, cfg, BATCH_SYSTEM_PROMPT, buildBatchPrompt(input), cfg.summary.timeoutMs * 2, (text) => parseBatch(text, ids));
	if (!r.ok) return { ok: false, error: r.error, ms: r.ms, model: r.model };
	return { ok: true, parsed: r.value, ms: r.ms, model: r.model };
}

export interface BriefResult {
	ok: boolean;
	text?: string;
	error?: string;
	ms: number;
	model: string;
}

/** One Chinese sentence for a compaction summary's goal section (low thinking: it is a translation, not a judgment). */
export async function briefGoal(ctx: ExtensionContext, cfg: TimelineConfig, goalSection: string): Promise<BriefResult> {
	const r = await callModel(ctx, cfg, BRIEF_SYSTEM_PROMPT, buildBriefPrompt(goalSection), cfg.summary.timeoutMs, "low");
	if (r.text === undefined) return { ok: false, error: r.error, ms: r.ms, model: r.model };
	const text = parseBrief(r.text) ?? parseBrief(r.thinking ?? "");
	if (!text) return { ok: false, error: `模型没给出中文一句话：${(r.text || r.thinking || "").slice(0, 60)}`, ms: r.ms, model: r.model };
	return { ok: true, text, ms: r.ms, model: r.model };
}

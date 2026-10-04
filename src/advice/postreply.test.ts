import assert from "node:assert/strict";
import { test } from "node:test";
import {
	assignIds,
	buildJudgeQuestions,
	buildJudgeState,
	buildPostReplyTarget,
	coveredByUpperPane,
	dropCovered,
	geminiSystemPrompt,
	geminiUserPrompt,
	WAITING_ACTION_LEVELS,
	generateWithRetry,
	judgeItems,
	onCurrentBranch,
	parseGenerated,
	sameSuggestion,
	selectParsedGeneration,
	stillFresh,
	unansweredAskQuestions,
} from "./postreply.ts";
import { LIMITS } from "./limits.ts";

const user = (id: string, text: string) => ({ id, type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistant = (id: string, text: string, extra: unknown[] = []) => ({
	id,
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }, ...extra] },
});

test("target binds to reply id on the current branch and waiting questions are not generic continue", () => {
	const branch = [user("u1", "做天气应用"), assistant("a1", "先定 API 还是先写页面？")];
	const t = buildPostReplyTarget("sess", branch);
	assert.equal(t?.replyEntryId, "a1");
	assert.equal(t?.waiting, true);
	assert.equal(onCurrentBranch(branch, "a1"), true);
	assert.equal(onCurrentBranch([user("u2", "换分支")], "a1"), false);
	assert.equal(stillFresh(t!, "sess", branch), true);
	assert.equal(stillFresh(t!, "other", branch), false);
	assert.equal(stillFresh(t!, "sess", [user("u1", "做天气应用"), assistant("a2", "新回复")]), false);
	assert.match(geminiSystemPrompt(true), /禁止只写/);
});

test("waiting actions use a sendable-answer rubric", () => {
	const items = assignIds({ directions: [{ label: "天气应用", prompt: "按目标做线上天气应用。" }], actions: [{ label: "回答 API", prompt: "用 OpenWeather，先写只读查询。" }] }, 1);
	const waiting = buildJudgeQuestions(items, true);
	const idle = buildJudgeQuestions(items, false);
	assert.deepEqual((waiting["a1-1"] as { criteria: string[] }).criteria, [...WAITING_ACTION_LEVELS]);
	assert.match(String((waiting["a1-1"] as { instructions: string }).instructions), /waiting for a choice/);
	assert.notEqual((idle["a1-1"] as { criteria: string[] }).criteria[3], WAITING_ACTION_LEVELS[3]);
});

test("unanswered ask_user_question counts as waiting evidence", () => {
	const q = { type: "toolCall", name: "ask_user_question", id: "q1", arguments: { questions: [{ question: "用哪家天气 API？" }] } };
	const open = unansweredAskQuestions([user("u1", "做天气"), assistant("a1", "选一个", [q])]);
	assert.deepEqual(open, ["用哪家天气 API？"]);
	const closed = unansweredAskQuestions([
		user("u1", "做天气"),
		assistant("a1", "选一个", [q]),
		{ type: "message", message: { role: "toolResult", toolCallId: "q1", toolName: "ask_user_question", content: "OpenWeather" } },
	]);
	assert.deepEqual(closed, []);
	const done = buildPostReplyTarget("sess", [user("u1", "检查更新"), assistant("a1", "有两个可更新，已列在下面。")]);
	assert.equal(done?.waiting, false);
});

test("malformed generation is failed, empty arrays are empty, waiting generic-continue is failed", () => {
	assert.equal(parseGenerated("not json", false).kind, "failed");
	assert.equal(parseGenerated('{"directions":[],"actions":[]}', false).kind, "empty");
	assert.equal(parseGenerated('{"directions":[],"actions":[]}', true).kind, "failed");
	assert.equal(parseGenerated('{"directions":[{"label":"x","prompt":"继续","evidence":"用户要求天气。"}],"actions":[{"label":"继续","prompt":"继续","evidence":"用户要求天气。"}]}', true).kind, "failed");
	const ok = parseGenerated(
		'{"directions":[{"label":"天气应用","prompt":"按确认的目标做线上天气应用，先定数据源。","evidence":"用户要求天气应用。"}],"actions":[{"label":"回答 API","prompt":"用 OpenWeather，先写只读查询。","evidence":"助手正在询问数据源。"}]}',
		true,
	);
	assert.equal(ok.kind, "ok");
	assert.equal(parseGenerated('{"directions":[{"label":"x","prompt":"一句。两句。三句。四句。"}],"actions":[]}', false).kind, "failed");
});

test("advice preserves full label/prompt/evidence rather than storing omissions", () => {
	const row = {
		label: "检查侧栏预测方向及回复建议的全部文字并确认复制出来的内容没有被省略",
		prompt: `检查${"侧栏宽度变化与滚动查看、".repeat(28)}确保复制出来的内容包含最后一段完整结尾。`,
		evidence: `用户明确要求${"拖动宽度后应显示完整内容、".repeat(8)}复制不能带人工省略号`,
	};
	assert.ok(row.label.length > LIMITS.postReplyLabelChars);
	assert.ok(row.prompt.length > LIMITS.actionPromptChars);
	assert.ok(row.evidence.length > LIMITS.evidenceChars);
	for (const kind of ["actions", "directions"] as const) {
		const result = parseGenerated(JSON.stringify({ actions: [], directions: [], [kind]: [row] }), false);
		assert.equal(result.kind, "ok");
		if (result.kind === "ok") assert.deepEqual(result.value[kind][0], row);
		for (const key of ["label", "prompt", "evidence"]) {
			const oversized = { ...row, [key]: "字".repeat(LIMITS.postReplyTextMax + 1) };
			const failed = parseGenerated(JSON.stringify({ actions: [], directions: [], [kind]: [oversized] }), false);
			assert.equal(failed.kind, "failed");
			if (failed.kind === "failed") assert.match(failed.error, /超过.*未截断保存/);
		}
	}
});

test("technical punctuation is not a sentence boundary, while real third sentences still fail", () => {
	const prompts = [
		"检查 core.ts 的解析逻辑，再验证 v2.3.1。",
		"检查 https://example.com/a.b?x=1&next=/v2.3，修复后重试。",
		"检查 http://127.0.0.1:18650/v1/systemone?debug=1。再验证 core.ts。",
		"检查 `config.json` 和 `node --version`。再运行测试。",
		"Inspect core.ts. Then verify v2.3.1.",
	];
	for (const prompt of prompts) {
		for (const kind of ["directions", "actions"] as const) {
			const raw = { directions: [], actions: [], [kind]: [{ label: "验证修复", prompt, evidence: "用户要求验证修复。" }] };
			const parsed = parseGenerated(JSON.stringify(raw), false);
			assert.equal(parsed.kind, "ok", `${kind}: ${prompt}`);
			if (parsed.kind === "ok") assert.equal(parsed.value[kind][0].prompt, prompt);
		}
	}
	for (const prompt of ["先检查。再修复。最后重试。", "Inspect core.ts. Fix it. Retry.", "检查 https://example.com/x. 再修复。最后重试。"] ) {
		const parsed = parseGenerated(JSON.stringify({ directions: [{ label: "验证", prompt }], actions: [] }), false);
		assert.deepEqual(parsed, { kind: "failed", error: "directions prompt 超过两句" });
	}
});

test("Jev missing scores are failed not empty; below-threshold is empty", () => {
	const items = assignIds({ directions: [{ label: "方向", prompt: "沿天气应用做下去。" }], actions: [{ label: "动作", prompt: "先写查询接口。" }] }, 1);
	assert.equal(judgeItems(items, {}).kind, "failed");
	assert.equal(judgeItems(items, { "d1-1": { score: 3 }, "a1-1": { score: 3, confidence: 0.9 } }).kind, "failed");
	assert.equal(judgeItems(items, { "d1-1": { score: 3, confidence: 0.2 }, "a1-1": { score: 1, confidence: 0.9 } }).kind, "ready");
	assert.equal(judgeItems(items, { "d1-1": { score: 1, confidence: 0.9 }, "a1-1": { score: 0, confidence: 0.9 } }).kind, "empty");
	assert.equal(judgeItems(items, { "d1-1": { score: 9, confidence: 0.9 }, "a1-1": { score: 3, confidence: 0.9 } }).kind, "failed");
	const dirs = assignIds({ directions: [{ label: "低", prompt: "先做低分方向。" }, { label: "高", prompt: "先做高分方向。" }], actions: [] }, 2);
	const reordered = judgeItems(dirs, { "d2-1": { score: 2, confidence: 0.8 }, "d2-2": { score: 3, confidence: 0.7 } });
	assert.equal(reordered.kind, "ready");
	if (reordered.kind === "ready") assert.deepEqual(reordered.directions.map((i) => i.id), ["d2-2", "d2-1"]);
});

test("fractional scores below the threshold are filtered without rounding up", () => {
	const items = assignIds({ directions: [], actions: [{ label: "查看差异", prompt: "请展示修改差异。" }] }, 1);
	assert.deepEqual(judgeItems(items, { "a1-1": { score: 1.69, confidence: 0.53 } }), { kind: "empty" });
	assert.equal(judgeItems(items, { "a1-1": { score: 1.7, confidence: 0.5 } }).kind, "ready");
	assert.equal(LIMITS.postReplyScoreMin, 1.7);
	assert.equal(LIMITS.recommendScoreMin, 2);
	assert.equal(judgeItems(items, { "a1-1": { score: 2, confidence: 0.5 } }, LIMITS.recommendScoreMin).kind, "ready");
	assert.equal(judgeItems(items, { "a1-1": { score: 2, confidence: 0.5 } }, 3).kind, "empty");
});

const goodJson = '{"directions":[{"label":"当前天气","prompt":"先做当前天气，验证出门查询。","evidence":"用户要做天气应用。"}],"actions":[{"label":"选当前","prompt":"选定只展示当前天气，先做最小页面。","evidence":"助手正在询问当前还是七天。"}]}';

test("generation requires usable evidence; missing or blank evidence is a retryable failure", () => {
	const withEvidence = parseGenerated(
		'{"directions":[{"label":"验收侧栏","prompt":"开 pi -e 看侧栏宽度。","evidence":"你说过要先能调宽。"}],"actions":[]}',
		false,
	);
	assert.equal(withEvidence.kind, "ok");
	if (withEvidence.kind === "ok") assert.equal(withEvidence.value.directions[0].evidence, "你说过要先能调宽。");
	const without = parseGenerated('{"directions":[{"label":"验收侧栏","prompt":"开 pi -e 看侧栏宽度。"}],"actions":[]}', false);
	assert.deepEqual(without, { kind: "failed", error: "directions 缺少有效 evidence" });
	const bad = parseGenerated('{"directions":[{"label":"验收侧栏","prompt":"开 pi -e 看侧栏宽度。","evidence":""}],"actions":[]}', false);
	assert.deepEqual(bad, { kind: "failed", error: "directions 缺少有效 evidence" });
	const items = assignIds({ directions: [{ label: "验收", prompt: "开 pi -e 看侧栏。", evidence: "你说过要看宽度。" }], actions: [] }, 3);
	assert.equal(items[0].evidence, "你说过要看宽度。");
});

test("the anchor comes before the reply in the user prompt; the reply is marked as a clue only", () => {
	const target = buildPostReplyTarget("s", [user("u1", "做天气应用"), assistant("a1", "先定 API 还是先写页面？")], {
		anchor: { sessionId: "s", replyEntryId: "a1", goal: "做一个能看的天气应用", decisions: ["定了用 OpenWeather"], userMessages: ["做天气应用", "先要能看北京的天气"] },
		covered: ["回答 API：用 OpenWeather"],
	});
	assert.ok(target);
	const prompt = geminiUserPrompt(target!);
	assert.ok(prompt.indexOf("目标锚") < prompt.indexOf("助手刚说完"));
	assert.match(prompt, /做一个能看的天气应用/);
	assert.match(prompt, /定了用 OpenWeather/);
	assert.match(prompt, /线索，不是候选来源/);
	assert.match(prompt, /回答 API：用 OpenWeather/);
	assert.match(geminiSystemPrompt(false), /目标闭环检查/);
	assert.match(geminiSystemPrompt(false), /evidence/);
});

test("an anchor from another session is ignored; covered texts survive into the target", () => {
	const other = buildPostReplyTarget("s", [user("u1", "a"), assistant("a1", "b")], { anchor: { sessionId: "other", goal: "x", decisions: [], userMessages: [] } });
	assert.equal(other?.anchor, undefined);
	const same = buildPostReplyTarget("s", [user("u1", "a"), assistant("a1", "b")], { covered: ["  ", "输入1试试"] });
	assert.deepEqual(same?.covered, ["输入1试试"]);
});

test("lower pane yields on exact, containment and near-identical rewrites; paraphrase is the prompt's job", () => {
	const generated = {
		directions: [{ label: "输入1试试", prompt: "输入 1 试试看侧栏。" }],
		actions: [
			{ label: "看看时间线状态", prompt: "跑一下 /timeline status。" },
			{ label: "重跑失败的那两轮摘要", prompt: "把摘要失败的两轮重跑一次。" },
		],
	};
	const covered = ["输入 1 试试", "跑 /timeline status", "重跑失败的两轮摘要"];
	const { kept, dropped } = dropCovered(generated, covered);
	assert.equal(kept.directions.length, 0);
	assert.deepEqual([...dropped].sort(), ["看看时间线状态", "输入1试试", "重跑失败的那两轮摘要"]);
	assert.equal(kept.actions.length, 0);
	assert.equal(sameSuggestion("跑一下 /timeline status", "跑 /timeline status"), true);
	assert.equal(sameSuggestion("输入1试试", "输入 1 试试"), true);
	// 0.875 bigram overlap: the same task with a word dropped is the same task.
	assert.equal(sameSuggestion("重跑失败的那两轮摘要", "重跑失败的两轮摘要"), true);
	// Code cannot see that "跑一遍全量测试" and "把整个测试套件跑一遍" are the same idea; measured at 0.50.
	// That case is the system prompt's job ("意思一样也算"), not the filter's. Keep the cut high so a rewrite
	// that only shares a topic is not silently deleted.
	assert.equal(sameSuggestion("跑一遍全量测试", "把整个测试套件跑一遍"), false);
	assert.equal(sameSuggestion("验收侧栏宽度", "检查一下老会话回填"), false);
	assert.equal(sameSuggestion("查看 Jev 分数分布", "看看建议的分数落在哪"), false);
	assert.equal(coveredByUpperPane("x", "输入1试试", []), false);
	const untouched = dropCovered(generated, []);
	assert.equal(untouched.kept.actions.length, 2);
});

test("goal-closure rubric replaced the worth-doing rubric and is not the prediction rubric", () => {
	const items = assignIds({ directions: [{ label: "方向", prompt: "沿天气应用做下去。" }], actions: [{ label: "动作", prompt: "先写查询接口。" }] }, 1);
	const idle = buildJudgeQuestions(items, false);
	const criteria = (idle["a1-1"] as { criteria: string[] }).criteria;
	assert.deepEqual(criteria, [...LIMITS.postReplyScoreLevels]);
	assert.match(criteria[3], /acceptance/);
	assert.match(String((idle["a1-1"] as { instructions: string }).instructions), /goal-closure check, not a prediction/);
	assert.match(String((idle["a1-1"] as { instructions: string }).instructions), /goal_anchor/);
});

test("thought channel is used only when visible text is not JSON; corrupted JSON is not repaired", () => {
	const unclosed = selectParsedGeneration('{"directions"', "", false);
	assert.equal(unclosed.kind, "failed");
	if (unclosed.kind === "failed") assert.equal(unclosed.error, "不完整 JSON");
	assert.equal(selectParsedGeneration("not json {oops", goodJson, false).kind, "failed");
	const fromThought = selectParsedGeneration("", goodJson, true);
	assert.equal(fromThought.kind, "ok");
	const thoughtFallback = selectParsedGeneration("not json", goodJson, true);
	assert.equal(thoughtFallback.kind, "ok");
	const visibleWins = selectParsedGeneration(goodJson, "{" , true);
	assert.equal(visibleWins.kind, "ok");
	const chatter = parseGenerated('example { "temp": 1 } then ' + goodJson, false);
	assert.equal(chatter.kind, "ok");
	const nestedOnly = parseGenerated('{"directions":"{\"temp\":1}"', false);
	assert.equal(nestedOnly.kind, "failed");
	const two = parseGenerated(goodJson + goodJson, true);
	assert.equal(two.kind, "failed");
	if (two.kind === "failed") assert.equal(two.error, "多个完整 JSON 对象");
	assert.match(geminiSystemPrompt(true), /停下来/);
});

test("overlong prompts retry with the sentence constraint; repeated violations remain failed", async () => {
	const target = buildPostReplyTarget("s", [user("u1", "修复摘要"), assistant("a1", "已修复解析，待验证。")]);
	assert.ok(target);
	assert.match(geminiSystemPrompt(false), /directions 和 actions 的每条 prompt 都必须是 1～2 句/);
	const overlong = JSON.stringify({ directions: [{ label: "验证", prompt: "先检查。再修复。最后重试。" }], actions: [] });
	const attempts: string[] = [];
	const repaired = await generateWithRetry(target, async (_system, prompt) => {
		attempts.push(prompt);
		return { text: attempts.length === 1 ? overlong : goodJson };
	}, new AbortController().signal);
	assert.equal(repaired.kind, "ok");
	assert.equal(attempts.length, 2);
	assert.match(attempts[1], /上次失败：directions prompt 超过两句/);
	const failed = await generateWithRetry(target, async () => ({ text: overlong }), new AbortController().signal);
	assert.deepEqual(failed, { kind: "failed", error: "directions prompt 超过两句" });
});

test("generateWithRetry retries a parse failure then succeeds; abort stops", async () => {
	const target = buildPostReplyTarget("s", [
		{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "做天气" }] } },
		{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "选当前还是七天？" }] } },
	]);
	assert.ok(target);
	let n = 0;
	const ok = await generateWithRetry(target, async (_s, user) => {
		n++;
		if (n === 1) {
			assert.match(user, /用户最近消息/);
			return { text: '{"directions"', stopReason: "stop" };
		}
		assert.match(user, /不完整 JSON/);
		return { text: goodJson, stopReason: "stop" };
	}, new AbortController().signal);
	assert.equal(ok.kind, "ok");
	assert.equal(n, 2);
	const truncated = await generateWithRetry(target, async () => ({ text: '{"directions"', stopReason: "length" }), new AbortController().signal);
	assert.equal(truncated.kind, "failed");
	if (truncated.kind === "failed") assert.equal(truncated.error, "输出被截断");
	const aborted = await generateWithRetry(target, async () => ({ text: goodJson }), AbortSignal.abort());
	assert.equal(aborted.kind, "failed");
	if (aborted.kind === "failed") assert.equal(aborted.error, "aborted");
});

test("current user choices and tool calls reach generator and judge without a timeline summary", () => {
	const entries = [
		user("u1", "做天气应用"),
		assistant("ask", "请选数据源", [{ type: "toolCall", name: "ask_user_question", id: "q1", arguments: { questions: [{ question: "用哪家 API？" }] } }]),
		{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "q1", toolName: "ask_user_question", content: "选好了", details: { answers: [{ question: "用哪家 API？", answer: "OpenWeather" }] } } },
		assistant("run", "", [{ type: "toolCall", name: "bash", id: "b1", arguments: { command: "node --test" } }]),
		{ id: "r2", type: "message", message: { role: "toolResult", toolCallId: "b1", toolName: "bash", isError: true, content: "PRIVATE_TOOL_OUTPUT" } },
		assistant("a1", "选择已记录，验证仍需处理。"),
	];
	const target = buildPostReplyTarget("s", entries)!;
	assert.equal(target.waiting, false);
	assert.match(target.currentDecisions.join("\n"), /用户选：OpenWeather/);
	assert.match(target.toolActions, /node.*✗/);
	assert.match(geminiUserPrompt(target), /用户选：OpenWeather/);
	assert.match(JSON.stringify(buildJudgeState(target, [])), /OpenWeather/);
	assert.doesNotMatch(JSON.stringify(target), /PRIVATE_TOOL_OUTPUT/);
	const cancelled = entries.map((e) => e.id === "r1" ? { ...e, message: { ...e.message, details: { cancelled: true, answers: [{ question: "用哪家 API？", answer: "OpenWeather" }] } } } : e);
	assert.deepEqual(buildPostReplyTarget("s", cancelled)?.currentDecisions, []);
});

test("an unanswered old question and stale anchor cannot contaminate a new turn", () => {
	const entries = [
		user("u-old", "旧需求"),
		assistant("a-old", "请选择", [{ type: "toolCall", name: "ask_user_question", id: "old-q", arguments: { questions: [{ question: "旧选项？" }] } }]),
		user("u1", "取消旧问题，改做新需求"), assistant("a1", "新需求已完成。"),
	];
	const target = buildPostReplyTarget("s", entries, { anchor: { sessionId: "s", replyEntryId: "a-old", goal: "旧目标", decisions: [], userMessages: [] } })!;
	assert.equal(target.waiting, false);
	assert.equal(target.anchor, undefined);
});

test("missing evidence retries rather than publishing an unsupported recommendation", async () => {
	const target = buildPostReplyTarget("s", [user("u1", "验收侧栏"), assistant("a1", "已交付，待验收。")])!;
	let attempts = 0;
	const result = await generateWithRetry(target, async (_system, prompt) => {
		attempts++;
		if (attempts === 1) return { text: '{"directions":[],"actions":[{"label":"验收","prompt":"检查侧栏。"}]}' };
		assert.match(prompt, /缺少有效 evidence/);
		return { text: '{"directions":[],"actions":[{"label":"验收","prompt":"检查侧栏。","evidence":"用户要求验收侧栏。"}]}' };
	}, new AbortController().signal);
	assert.equal(attempts, 2);
	assert.equal(result.kind, "ok");
	if (result.kind === "ok") assert.equal(result.value.actions[0].evidence, "用户要求验收侧栏。");
});

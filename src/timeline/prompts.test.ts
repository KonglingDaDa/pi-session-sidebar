import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNextQuestions, buildState, buildTurnQuestions, buildTurnState, COMPLETION_LEVELS, NEXT_LEVELS } from "./jev.ts";
import { BATCH_SYSTEM_PROMPT, BRIEF_SYSTEM_PROMPT, SYSTEM_PROMPT, batchLabels, buildBatchPrompt, buildBriefPrompt, buildPrompt, pickModelJson, summaryThinkingAttempts } from "./summarize.ts";
import { emptyStats, parseSummary, redactDeep } from "./core.ts";

const turn = (user: string) => ({ forcedContinue: false, previous: "", decisions: [] as string[], stats: emptyStats(), actions: "改 a.ts", user, assistant: `reply to ${user}` });

test("single-turn prompt carries goal, phases, action list, user text and reply", () => {
	const p = buildPrompt({ goal: "做侧栏", phases: [{ id: "u1", title: "A", status: "done", lastStep: "x → y" }], ...turn("加回填") });
	assert.match(p, /会话目标：做侧栏/);
	assert.match(p, /\[完成\] A（最近一步：x → y）  ← 当前阶段/);
	assert.match(p, /动作清单：\n改 a\.ts/);
	assert.match(p, /加回填/);
	assert.match(p, /reply to 加回填/);
});

test("batch prompt labels turns T1..Tn and asks for next only when it holds the latest turn", () => {
	assert.deepEqual(batchLabels(3), ["T1", "T2", "T3"]);
	const p = buildBatchPrompt({ goal: "", phases: [], turns: [turn("一"), turn("二")], includeNext: false });
	assert.match(p, /===== T1 =====[\s\S]*一[\s\S]*===== T2 =====[\s\S]*二/);
	assert.match(p, /next 和 directions 给 \[\]/);
	assert.match(buildBatchPrompt({ goal: "", phases: [], turns: [turn("一")], includeNext: true }), /请填 next/);
	assert.match(p, /（无，这是第一轮）/);
});

test("Jev questions: completion Score + off-intent Noul; one Score per next-step candidate", () => {
	const q = buildTurnQuestions();
	assert.deepEqual(Object.keys(q), ["completion", "off_intent", "waiting"]);
	assert.equal(COMPLETION_LEVELS.length, 4);
	assert.doesNotMatch(COMPLETION_LEVELS.join(" "), /test|check/i); // one dimension: how much got done
	const state = buildTurnState({ previous: "", decisions: [], userRequest: "u", intent: "i", goal: "", phases: [], reply: "r", actions: "" });
	const turn = state.turn as Record<string, unknown>;
	assert.equal(turn.actions, "(no tools used)");
	assert.equal(turn.previous_assistant_ending, "(none: first turn)");
	assert.equal(turn.user_decisions_during_turn, "(none)");
	const s2 = buildTurnState({ previous: "要不要用 Opus？", decisions: ["问：用哪个 → 用户选：Opus"], userRequest: "好", intent: "i", goal: "", phases: [], reply: "r", actions: "" });
	assert.deepEqual((s2.turn as Record<string, unknown>).user_decisions_during_turn, ["问：用哪个 → 用户选：Opus"]);
	assert.equal((s2.turn as Record<string, unknown>).previous_assistant_ending, "要不要用 Opus？");
	const n = buildNextQuestions(["a", "b", "c"]);
	assert.deepEqual(Object.keys(n), ["next_0", "next_1", "next_2"]);
	assert.equal(NEXT_LEVELS.length, 4);
	assert.match(String((n.next_0 as { instructions?: { question?: string } }).instructions?.question), /next message/);
	assert.match(NEXT_LEVELS.join(" "), /Unlikely next message/);
	assert.match(SYSTEM_PROMPT, /下一句可能发给助手的原话/);
	assert.match(SYSTEM_PROMPT, /禁止"继续"/);
});

test("brief prompt carries the (redacted) goal section and asks for one Chinese sentence", () => {
	const p = buildBriefPrompt("Primary Goal: build a tool. key sk-abcdefghijklmnopqrstuvwxyz123456");
	assert.match(p, /Primary Goal: build a tool/);
	assert.doesNotMatch(p, /sk-abcdefghijklmnopqrstuvwxyz123456/);
	assert.match(BRIEF_SYSTEM_PROMPT, /一句简体中文/);
});

test("buildState + redactDeep drops secrets from compaction payloads before Jev", () => {
	const key = `sk-${"xyZ9".repeat(8)}`; // 32 chars after sk-
	const state = buildState({
		preGoal: "做侧栏",
		phases: [{ id: "p1", title: "A", status: "done", lastStep: "x" }],
		userMessages: [`key ${key}`],
		postGoal: `Primary Goal with ${key}`,
		summary: `## Goal\n- keep going with ${key}\n## Notes\nok`,
		kept: [{ role: "user", text: `paste ${key}` }],
	});
	// Caller may forget to redact leaves; ask() applies redactDeep as the last line of defence.
	const safe = redactDeep(state);
	const blob = JSON.stringify(safe);
	assert.equal(blob.includes(key), false);
	assert.match(blob, /sk-\[redacted\]/);
	assert.match(blob, /做侧栏/);
});

test("summary JSON is taken from thinking when the visible reply has none, and a second attempt lowers thinking", () => {
	const json = '{"continue_phase":true,"phase_title":"查更新","intent":"检查更新","result":"有 2 个可更新","status":"done","goal":"整理工具","now":"等你决定","next":[],"directions":[]}';
	const fromThought = pickModelJson("", `先想想\n${json}`, parseSummary);
	assert.equal(typeof fromThought, "object");
	if (typeof fromThought === "object") assert.equal(fromThought.intent, "检查更新");
	assert.match(String(pickModelJson("", "", parseSummary)), /没有返回正文/);
	assert.match(String(pickModelJson("", "只有思考没有对象", parseSummary)), /只返回了思考/);
	const badStatus = '{"continue_phase":true,"phase_title":"a","intent":"b","status":"maybe","goal":""}';
	assert.match(String(pickModelJson(badStatus, json, parseSummary)), /status/);
	assert.deepEqual(summaryThinkingAttempts("high"), ["high", "low"]);
	assert.deepEqual(summaryThinkingAttempts("off"), ["off"]);
});

test("prompts carry the previous reply's ending and mid-turn decisions, and ask for decisions + now", () => {
	const t = { ...turn("好，开始"), previous: "要不要先用 Mock 跑通？", decisions: ["问：预算上限？ → 用户选：$20-30"] };
	const p = buildPrompt({ goal: "", phases: [], ...t });
	assert.match(p, /上一轮（用户这一轮可能在回应它）：\n<<<\n要不要先用 Mock 跑通？\n>>>/);
	assert.match(p, /中途用户的拍板[^\n]*\n问：预算上限？ → 用户选：\$20-30/);
	assert.match(buildPrompt({ goal: "", phases: [], ...turn("x") }), /（没有，这是第一轮）[\s\S]*拍板[^\n]*\n（没有）/);
	const b = buildBatchPrompt({ goal: "", phases: [], turns: [t, turn("二")], includeNext: false });
	assert.equal(b.match(/上一轮（用户这一轮可能在回应它）/g)?.length, 1); // only T1: T2's previous turn is T1 in the pack
	for (const sys of [SYSTEM_PROMPT, BATCH_SYSTEM_PROMPT]) {
		assert.match(sys, /"decisions"/);
		assert.match(sys, /"now"/);
		assert.match(sys, /这一轮这件事做完不等于总目标做完/);
	}
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	EMPTY_ADVICE_SLOT,
	TASK_ASSISTANT_CHANNEL,
	adviceAnchorFromBranch,
	adviceContextEvent,
	adviceCoveredEvent,
	adviceView,
	applyAdviceEvent,
	fillItem,
	nextPredictions,
	parseTaskAssistantEvent,
	pickAdviceItem,
	pickNextFill,
	predictionsFromUpdate,
	selectEvent,
	shouldGenerateNext,
} from "./assistant-owner.ts";
import { buildSummarySystem } from "./summarize.ts";

const next = {
	steps: [
		{ text: "用老会话实测回填", score: 0.94 },
		{ text: "把插件挪进 extensions", score: 0.66 },
		{ text: "补一条方向说明", score: 0.5 },
	],
	directions: ["下一件：常驻加载"],
};

const readyUpdate = {
	type: "update" as const,
	version: 1 as const,
	key: "s:a1:1",
	sessionId: "s",
	replyEntryId: "a1",
	revision: 1,
	status: "ready" as const,
	directions: [{ id: "d1-1", kind: "direction" as const, label: "天气应用", prompt: "按目标做线上天气应用。" }],
	actions: [{ id: "a1-1", kind: "action" as const, label: "回答 API", prompt: "用 OpenWeather，先写只读查询。" }],
};

test("provider presence does not disable next generation", () => {
	assert.equal(TASK_ASSISTANT_CHANNEL, "pi-local:task-assistant:v1");
	assert.equal(shouldGenerateNext(true), true);
	assert.equal(shouldGenerateNext(false), false);
	const afterHello = applyAdviceEvent(EMPTY_ADVICE_SLOT, { type: "hello", version: 1, role: "provider" });
	assert.equal(afterHello.provider, true);
	assert.equal(adviceView(afterHello, false)?.idle, true);
	assert.equal(adviceView(afterHello, false)?.pending, false);
	assert.equal(adviceView(afterHello, true), undefined);
	assert.equal(shouldGenerateNext(true), true);
	assert.match(buildSummarySystem(shouldGenerateNext(true)), /5 条/);
	assert.match(buildSummarySystem(shouldGenerateNext(false)), /填 \[\]/);
	assert.doesNotMatch(buildSummarySystem(false), /5 条/);
});

test("original predictions ignore advice updates", () => {
	const shown = nextPredictions({
		enabled: true,
		nextModule: true,
		agentActive: false,
		next,
		latestTurnId: "u1",
		scoringNext: new Set(),
		shown: 3,
	});
	assert.deepEqual(
		shown?.steps.map((s) => s.text),
		["用老会话实测回填", "把插件挪进 extensions", "补一条方向说明"],
	);
	assert.deepEqual(shown?.directions, ["下一件：常驻加载"]);
	assert.equal(shown?.source, undefined);
	assert.equal(pickNextFill(shown, 1), "用老会话实测回填");
	assert.equal(pickNextFill(shown, 2), "把插件挪进 extensions");
	let slot = applyAdviceEvent(EMPTY_ADVICE_SLOT, { type: "hello", version: 1, role: "provider" });
	slot = applyAdviceEvent(slot, readyUpdate);
	const still = nextPredictions({
		enabled: true,
		nextModule: true,
		agentActive: false,
		next,
		latestTurnId: "u1",
		scoringNext: new Set(),
		shown: 3,
	});
	assert.equal(pickNextFill(still, 1), "用老会话实测回填");
	assert.notEqual(pickNextFill(still, 1), fillItem(adviceView(slot, false), 1)?.prompt);
	assert.equal(adviceView(slot, false)?.source, "task-assistant");
	assert.equal(fillItem(adviceView(slot, false), 1)?.prompt, "按目标做线上天气应用。");
});

test("failed empty pending advice stays in its own slot", () => {
	let slot = applyAdviceEvent(EMPTY_ADVICE_SLOT, { type: "hello", version: 1, role: "provider" });
	slot = applyAdviceEvent(slot, {
		type: "update",
		version: 1,
		key: "s:a1:1",
		sessionId: "s",
		replyEntryId: "a1",
		revision: 1,
		status: "failed",
		directions: [],
		actions: [],
		error: "timeout",
	});
	const advice = adviceView(slot, false);
	assert.equal(advice?.error, "timeout");
	assert.equal(advice?.steps.length, 0);
	const pred = nextPredictions({
		enabled: true,
		nextModule: true,
		agentActive: false,
		next,
		latestTurnId: "u1",
		scoringNext: new Set(),
		shown: 3,
	});
	assert.equal(pred?.error, undefined);
	assert.equal(pred?.steps.length, 3);
	assert.equal(shouldGenerateNext(true), true);
	slot = applyAdviceEvent(slot, {
		type: "update",
		version: 1,
		key: "s:a1:1",
		sessionId: "s",
		replyEntryId: "a1",
		revision: 1,
		status: "empty",
		directions: [],
		actions: [],
	});
	assert.equal(adviceView(slot, false)?.empty, true);
	assert.equal(nextPredictions({
		enabled: true,
		nextModule: true,
		agentActive: false,
		next,
		latestTurnId: "u1",
		scoringNext: new Set(),
		shown: 3,
	})?.steps.length, 3);
	slot = applyAdviceEvent(slot, {
		type: "update",
		version: 1,
		key: "s:a1:1",
		sessionId: "s",
		replyEntryId: "a1",
		revision: 1,
		status: "pending",
		directions: [],
		actions: [],
	});
	assert.equal(adviceView(slot, false)?.pending, true);
	assert.equal(shouldGenerateNext(true), true);
	assert.equal(predictionsFromUpdate(undefined, true), undefined);
	const sel = selectEvent("s:a1:1", fillItem(adviceView(applyAdviceEvent(applyAdviceEvent(EMPTY_ADVICE_SLOT, { type: "hello", version: 1, role: "provider" }), readyUpdate), false)!, 2)!, "sel-1");
	assert.equal(parseTaskAssistantEvent(sel)?.type, "select");
});

test("alt+1 fill stays on next-message text; advice fill uses item id", () => {
	const pred = nextPredictions({
		enabled: true,
		nextModule: true,
		agentActive: false,
		next,
		latestTurnId: "u1",
		scoringNext: new Set(),
		shown: 3,
	});
	let slot = applyAdviceEvent(EMPTY_ADVICE_SLOT, { type: "hello", version: 1, role: "provider" });
	slot = applyAdviceEvent(slot, readyUpdate);
	const advice = adviceView(slot, false);
	assert.equal(pickNextFill(pred, 1), "用老会话实测回填");
	assert.equal(pickAdviceItem(advice, "a1-1")?.prompt, "用 OpenWeather，先写只读查询。");
	assert.notEqual(pickNextFill(pred, 1), pickAdviceItem(advice, "a1-1")?.prompt);
	assert.equal(pickAdviceItem(pred, "a1-1"), undefined);
});

test("unstarted and cleared advice is idle; only a pending update means generating", () => {
	let slot = applyAdviceEvent(EMPTY_ADVICE_SLOT, { type: "hello", version: 1, role: "provider" });
	assert.equal(adviceView(slot, false)?.idle, true);
	assert.equal(adviceView(slot, false)?.pending, false);
	slot = applyAdviceEvent(slot, { ...readyUpdate, status: "pending", directions: [], actions: [] });
	assert.equal(adviceView(slot, false)?.pending, true);
	for (const reason of ["session_start", "tree", "compact"]) {
		const cleared = applyAdviceEvent(slot, { type: "clear", version: 1, reason });
		assert.equal(adviceView(cleared, false)?.idle, true, reason);
		assert.equal(adviceView(cleared, false)?.pending, false, reason);
	}
	const off = applyAdviceEvent(slot, { type: "clear", version: 1, reason: "off" });
	assert.equal(adviceView(off, false), undefined);
	const stillOff = applyAdviceEvent(off, { type: "hello", version: 1, role: "provider", enabled: false });
	assert.equal(adviceView(stillOff, false), undefined);
	assert.equal(adviceView(applyAdviceEvent(stillOff, { type: "hello", version: 1, role: "provider", enabled: true }), false)?.idle, true);
});

test("empty upper-pane coverage is an explicit scoped clearing event", () => {
	assert.deepEqual(adviceCoveredEvent("s", [], "a1"), { type: "advice-covered", version: 1, sessionId: "s", replyEntryId: "a1", texts: [] });
	assert.equal(parseTaskAssistantEvent(adviceCoveredEvent("s", ["  ", "预测"], "a1"))?.type, "advice-covered");
});

test("timeline anchor includes current choices before a summary record exists", () => {
	const branch = [
		{ id: "u1", type: "message", message: { role: "user", content: "做天气应用" } },
		{ id: "ask", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "q1", name: "ask_user_question", arguments: {} }] } },
		{ id: "r1", type: "message", message: { role: "toolResult", toolCallId: "q1", toolName: "ask_user_question", content: "已选择", details: { answers: [
			{ question: "API", answer: "OpenWeather" }, { question: "城市", answer: "北京" },
			{ question: "单位", answer: "摄氏度" }, { question: "版本", answer: "只读" },
		] } } },
		{ id: "a1", type: "message", message: { role: "assistant", content: "已记录。" } },
	];
	const anchor = adviceAnchorFromBranch(branch, new Map(), "天气应用")!;
	assert.equal(anchor.replyEntryId, "a1");
	assert.equal(anchor.goal, "天气应用");
	assert.equal(anchor.decisions.length, 4, "all current answers survive the historical limit of three");
	assert.match(anchor.decisions[0], /OpenWeather/);
	const event = adviceContextEvent("s", anchor.goal, anchor.decisions, anchor.userMessages, anchor.replyEntryId);
	const parsed = parseTaskAssistantEvent(event);
	assert.equal(parsed?.type, "advice-context");
	if (parsed?.type === "advice-context") assert.deepEqual(parsed.decisions, anchor.decisions);
});

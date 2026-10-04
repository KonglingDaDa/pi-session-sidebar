import assert from "node:assert/strict";
import { test } from "node:test";
import {
	TASK_ASSISTANT_CHANNEL,
	parseTaskAssistantEvent,
	suggestionKey,
	type TaskAssistantEvent,
} from "./events.ts";

test("provider hello availability is optional for legacy senders and validated when present", () => {
	assert.deepEqual(parseTaskAssistantEvent({ type: "hello", version: 1, role: "provider" }), { type: "hello", version: 1, role: "provider" });
	for (const enabled of [true, false]) {
		assert.deepEqual(parseTaskAssistantEvent({ type: "hello", version: 1, role: "provider", enabled }), { type: "hello", version: 1, role: "provider", enabled });
	}
	assert.equal(parseTaskAssistantEvent({ type: "hello", version: 1, role: "provider", enabled: "false" }), undefined);
});

test("channel name is versioned and keys omit branch leaf id", () => {
	assert.equal(TASK_ASSISTANT_CHANNEL, "pi-local:task-assistant:v1");
	assert.equal(suggestionKey("sess", "reply-1", 2), "sess:reply-1:2");
});

test("parse accepts hello/update/clear/select and rejects malformed", () => {
	const hello = parseTaskAssistantEvent({ type: "hello", version: 1, role: "provider" });
	assert.equal(hello?.type, "hello");
	const update = parseTaskAssistantEvent({
		type: "update",
		version: 1,
		key: "s:r:1",
		sessionId: "s",
		replyEntryId: "r",
		revision: 1,
		status: "ready",
		directions: [{ id: "d1-1", kind: "direction", label: "方向", prompt: "按目标继续做侧栏握手。" }],
		actions: [{ id: "a1-1", kind: "action", label: "动作", prompt: "写契约测试。" }],
	});
	assert.equal(update?.type, "update");
	if (update?.type === "update") assert.equal(update.actions[0]?.prompt, "写契约测试。");
	assert.equal(parseTaskAssistantEvent({ type: "clear", version: 1, reason: "compact" })?.type, "clear");
	assert.equal(parseTaskAssistantEvent({ type: "select", version: 1, key: "s:r:1", itemId: "a1-1", selectionId: "x" })?.type, "select");
	assert.equal(parseTaskAssistantEvent({ type: "update", version: 1 }), undefined);
	assert.equal(parseTaskAssistantEvent({ type: "hello", version: 2, role: "provider" }), undefined);
	assert.equal(parseTaskAssistantEvent({ type: "select", version: 1, key: "s", itemId: "a", selectionId: 1 }), undefined);
});

test("advice-context and advice-covered parse; malformed shapes are rejected", () => {
	const ctx = parseTaskAssistantEvent({ type: "advice-context", version: 1, sessionId: "s", replyEntryId: "r1", goal: "做天气应用", decisions: ["定了用 OpenWeather"], userMessages: ["做天气应用"] });
	assert.equal(ctx?.type, "advice-context");
	if (ctx?.type === "advice-context") {
		assert.deepEqual(ctx.decisions, ["定了用 OpenWeather"]);
		assert.equal(ctx.replyEntryId, "r1");
	}
	const covered = parseTaskAssistantEvent({ type: "advice-covered", version: 1, sessionId: "s", texts: ["输入1试试"] });
	assert.equal(covered?.type, "advice-covered");
	assert.equal(parseTaskAssistantEvent({ type: "advice-context", version: 1, sessionId: "s", goal: 1, decisions: [], userMessages: [] }), undefined);
	assert.equal(parseTaskAssistantEvent({ type: "advice-context", version: 1, sessionId: "s", goal: "", decisions: [1], userMessages: [] }), undefined);
	const cleared = parseTaskAssistantEvent({ type: "advice-covered", version: 1, sessionId: "s", replyEntryId: "r1", texts: [] });
	if (cleared?.type !== "advice-covered") assert.fail("empty coverage must be legal");
	assert.equal(cleared.replyEntryId, "r1");
	assert.deepEqual(cleared.texts, []);
	for (const replyEntryId of ["", " ", 1]) {
		assert.equal(parseTaskAssistantEvent({ type: "advice-covered", version: 1, sessionId: "s", replyEntryId, texts: [] }), undefined);
		assert.equal(parseTaskAssistantEvent({ type: "advice-context", version: 1, sessionId: "s", replyEntryId, goal: "", decisions: [], userMessages: [] }), undefined);
	}
	assert.equal(parseTaskAssistantEvent({ type: "advice-covered", version: 1, sessionId: "s", texts: "x" }), undefined);
});

test("evidence is optional on a suggestion and must be non-empty when present", () => {
	const base = { type: "update", version: 1, key: "s:r:1", sessionId: "s", replyEntryId: "r", revision: 1, status: "ready", actions: [] };
	const withEvidence = parseTaskAssistantEvent({ ...base, directions: [{ id: "d1-1", kind: "direction", label: "方向", prompt: "继续做侧栏。", evidence: "你说过侧栏要先能调宽。" }] });
	if (withEvidence?.type !== "update") assert.fail("evidence must survive parsing");
	assert.equal(withEvidence.directions[0]?.evidence, "你说过侧栏要先能调宽。");
	const without = parseTaskAssistantEvent({ ...base, directions: [{ id: "d1-1", kind: "direction", label: "方向", prompt: "继续做侧栏。" }] });
	if (without?.type !== "update") assert.fail("missing evidence must stay legal");
	assert.equal(without.directions[0]?.evidence, undefined);
	assert.equal(parseTaskAssistantEvent({ ...base, directions: [{ id: "d1-1", kind: "direction", label: "方向", prompt: "继续。", evidence: "   " }] }), undefined);
});

test("event order hello then pending-shaped update then clear is a valid sequence", () => {
	const seq: TaskAssistantEvent[] = [
		{ type: "hello", version: 1, role: "provider" },
		{
			type: "update",
			version: 1,
			key: "s:r:1",
			sessionId: "s",
			replyEntryId: "r",
			revision: 1,
			status: "pending",
			directions: [],
			actions: [],
		},
		{ type: "clear", version: 1, reason: "agent_start" },
	];
	assert.deepEqual(seq.map((e) => parseTaskAssistantEvent(e)?.type), ["hello", "update", "clear"]);
});

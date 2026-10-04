import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskAssistantEvent, TaskAssistantUpdate } from "./events.ts";
import { POSTREPLY_CACHE_ENTRY, cachedPostReply, postReplyCache, type PostReplyCache } from "./postreply-cache.ts";
import { PostReplyController } from "./postreply-queue.ts";
import { parseGenerated } from "./postreply.ts";

const messages = [
	{ id: "u", type: "message", message: { role: "user", content: "修复侧栏" } },
	{ id: "a", type: "message", message: { role: "assistant", content: "代码已修复，请验收。" } },
];
const ready: TaskAssistantUpdate = { type: "update", version: 1, sessionId: "s", replyEntryId: "a", key: "s:a:7", revision: 7,
	status: "ready", error: undefined, directions: [], actions: [
		{ id: "a7-1", kind: "action", label: "验收复制隔离", prompt: "验收复制隔离。", evidence: "用户要求跨行复制不夹带侧栏" },
		{ id: "a7-2", kind: "action", label: "确认配色", prompt: "确认配色。", evidence: "用户要求调整界面" },
	],
};
function record(update = ready, turnEndId = "a") {
	return { id: "cache", type: "custom", customType: POSTREPLY_CACHE_ENTRY, data: { v: 1, turnEndId, update } };
}
function ctx(branch: unknown[], sessionId = "s"): ExtensionContext {
	return { sessionManager: { getBranch: () => branch, getSessionId: () => sessionId } } as unknown as ExtensionContext;
}
function queue(branch: unknown[]) {
	const events: TaskAssistantEvent[] = [];
	let resolve!: (value: TaskAssistantUpdate) => void;
	const terminal = new Promise<TaskAssistantUpdate>((done) => { resolve = done; });
	const c = new PostReplyController({ emit: (event) => {
		events.push(event);
		if (event.type === "update" && event.status !== "pending") resolve(event);
	}, notify: () => {}, persist: (cache) => branch.push({ id: `cache-${branch.length}`, type: "custom", customType: POSTREPLY_CACHE_ENTRY, data: cache }) });
	return { c, events, terminal };
}

test("complete long advice survives cache JSON round-trip and fills the full prompt", () => {
	const raw = {
		label: "验收侧栏预测方向和回复建议的全部显示内容并确认宽度变化后文字仍完整",
		prompt: `请检查${"预测方向建议的完整显示、".repeat(30)}确认输入框里面保留完整的结尾。`,
		evidence: "用户明确要求侧边栏宽度变化后展示完整内容以及复制全部文字而不是人工截断的省略号".repeat(3),
	};
	const generated = parseGenerated(JSON.stringify({ actions: [raw], directions: [] }), false);
	if (generated.kind !== "ok") assert.fail("long fixture must be preserved by generation validation");
	const update = { ...ready, actions: [{ ...generated.value.actions[0], id: "a7-long", kind: "action" as const }] };
	const branch = JSON.parse(JSON.stringify([...messages, record(update)]));
	const q = queue(branch);
	assert.equal(q.c.restore(ctx(branch)), true);
	assert.deepEqual(q.c.current()?.actions[0], update.actions[0]);
	let filled = "";
	assert.equal(q.c.fill(update.key, "a7-long", "pick-long", {
		isIdle: () => true, hasPendingMessages: () => false, editorText: () => filled, setEditorText: (text) => { filled = text; },
	}), "filled");
	assert.equal(filled, raw.prompt);
});

test("cache is exact session/reply/turn-end and ignores UI custom entries", () => {
	const branch = [...messages, record()];
	assert.deepEqual(cachedPostReply("s", branch), ready);
	assert.equal(cachedPostReply("other", branch), undefined);
	assert.equal(cachedPostReply("s", [...branch, { ...messages[0], id: "u2" }]), undefined);
	assert.equal(cachedPostReply("s", [...branch, { ...messages[1], id: "a2" }]), undefined);
	assert.equal(cachedPostReply("s", [...branch, { id: "tool", type: "message", message: { role: "toolResult", content: "done" } }]), undefined);
	assert.equal(cachedPostReply("s", [messages[0], { ...messages[1], id: "fork" }, record()]), undefined);
	assert.deepEqual(cachedPostReply("s", [...branch, { type: "custom", customType: "other", data: {} }]), ready);
});

test("empty and failed are reusable completed states; pending/malformed/version/evidence are rejected", () => {
	for (const status of ["empty", "failed"] as const) {
		const update = { ...ready, status, directions: [], actions: [], error: status === "failed" ? "网络失败" : undefined };
		assert.deepEqual(cachedPostReply("s", [...messages, record(update)]), update);
	}
	for (const data of [
		{ v: 2, turnEndId: "a", update: ready },
		{ v: 1, turnEndId: "a", update: { ...ready, status: "pending" } },
		{ v: 1, turnEndId: "a", update: { ...ready, revision: -1 } },
		{ v: 1, turnEndId: "a", update: { ...ready, actions: [{ ...ready.actions[0], evidence: "" }] } },
		{ v: 1, turnEndId: "a", update: { ...ready, actions: [{ ...ready.actions[0], evidence: undefined }] } },
	]) assert.equal(cachedPostReply("s", [...messages, { ...record(), data }]), undefined);
	assert.equal(postReplyCache({ ...ready, status: "pending" }, messages), undefined);
});

test("new controller restores JSON round-trip cache synchronously without generating or judging", async () => {
	const branch = JSON.parse(JSON.stringify([...messages, record()]));
	const q = queue(branch);
	const internals = q.c as unknown as { generate(): Promise<never>; judge(): Promise<never> };
	internals.generate = async () => assert.fail("restoring must not call Gemini");
	internals.judge = async () => assert.fail("restoring must not call Jev");
	assert.equal(q.c.restore(ctx(branch)), true);
	assert.deepEqual(q.c.current(), ready);
	q.c.kick(ctx(branch)); // duplicate settled notification also reuses the cache
	await new Promise<void>((done) => setImmediate(done));
	assert.equal(q.events.some((e) => e.type === "update" && e.status === "pending"), false);
	let text = "";
	assert.equal(q.c.fill(ready.key, ready.actions[0].id, "selection", {
		isIdle: () => true, hasPendingMessages: () => false, editorText: () => text, setEditorText: (s) => { text = s; },
	}), "filled");
	assert.equal(text, ready.actions[0].prompt);
});

test("cache miss on entry is idle, abort keeps persisted cache, returning to branch restores it", () => {
	const branch = [...messages, record()];
	const q = queue(branch);
	assert.equal(q.c.restore(ctx([])), false);
	assert.equal(q.c.current(), undefined);
	assert.equal(q.c.restore(ctx(branch)), true);
	q.c.abort("agent_start");
	assert.equal(q.c.current(), undefined);
	assert.equal(q.c.restore(ctx([...branch, { ...messages[0], id: "new" }])), false);
	assert.equal(q.c.restore(ctx(branch)), true);
	assert.equal(branch.length, 3);
});

test("late upper coverage persists the filtered result, including empty, for next restart", () => {
	const branch: unknown[] = [...messages, record()];
	const q = queue(branch);
	q.c.restore(ctx(branch));
	q.c.setCovered("s", [ready.actions[0].prompt], "a");
	assert.deepEqual(cachedPostReply("s", branch)?.actions, [ready.actions[1]]);
	q.c.setCovered("s", [ready.actions[1].prompt], "a");
	assert.equal(cachedPostReply("s", branch)?.status, "empty");
	const restarted = queue(branch);
	assert.equal(restarted.c.restore(ctx(branch)), true);
	assert.deepEqual(restarted.c.current()?.actions, []);
});

test("explicit retry bypasses cache, persists replacement and advances revision", { timeout: 2000 }, async () => {
	const branch: unknown[] = [...messages, record()];
	const q = queue(branch);
	q.c.restore(ctx(branch));
	let generated = 0;
	const internals = q.c as unknown as { generate(): Promise<{ kind: "empty" }>; judge(): Promise<never> };
	internals.generate = async () => { generated++; return { kind: "empty" }; };
	internals.judge = async () => assert.fail("empty generation skips Jev");
	q.c.kick(ctx(branch), true);
	await new Promise<void>((done) => setImmediate(done));
	await new Promise<void>((done) => setImmediate(done));
	assert.equal(generated, 1);
	assert.equal(q.c.current()?.revision, 8);
	assert.equal(cachedPostReply("s", branch)?.status, "empty");
	assert.equal(cachedPostReply("s", branch)?.revision, 8);
});

test("generation writes completed cache, never pending, and persistence failure is visible", { timeout: 2000 }, async () => {
	const branch: unknown[] = [...messages];
	const q = queue(branch);
	const internals = q.c as unknown as { generate(): Promise<{ kind: "empty" }> };
	internals.generate = async () => ({ kind: "empty" });
	q.c.kick(ctx(branch));
	assert.equal(branch.length, 2);
	await q.terminal;
	assert.equal(cachedPostReply("s", branch)?.status, "empty");
	const errors: string[] = [];
	const broken = new PostReplyController({ emit() {}, notify: (s) => errors.push(s), persist: (_cache: PostReplyCache) => { throw new Error("disk full"); } });
	(broken as unknown as { generate(): Promise<{ kind: "empty" }> }).generate = async () => ({ kind: "empty" });
	broken.kick(ctx(messages));
	await new Promise<void>((done) => setImmediate(done));
	await new Promise<void>((done) => setImmediate(done));
	assert.match(errors.join(" "), /缓存没存上.*disk full/);
	assert.equal(broken.current()?.status, "empty");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskAssistantEvent, TaskAssistantUpdate, SuggestionItem } from "./events.ts";
import type { GenerateResult, JudgeResult, PostReplyTarget } from "./postreply.ts";
import { parseTaskAssistantEvent } from "./events.ts";
import { PostReplyController, type FillUi } from "./postreply-queue.ts";

function ui(over: Partial<FillUi> = {}): FillUi {
	let text = "";
	const base: FillUi = {
		isIdle: () => true,
		hasPendingMessages: () => false,
		editorText: () => text,
		setEditorText: (t) => {
			text = t;
		},
		busyDialog: false,
	};
	return { ...base, ...over };
}

function fakeCtx(branch: unknown[], sessionId = "sess"): ExtensionContext {
	return {
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch,
		},
		modelRegistry: { find: () => undefined },
	} as unknown as ExtensionContext;
}

const branch = [
	{ id: "u1", type: "message", message: { role: "user", content: [{ type: "text", text: "做天气应用" }] } },
	{ id: "a1", type: "message", message: { role: "assistant", content: [{ type: "text", text: "先定 API 还是先写页面？" }] } },
];

test("kick returns immediately and emits hello/pending/failed without treating failure as empty", async () => {
	const log: TaskAssistantEvent[] = [];
	const c = new PostReplyController({
		emit: (e) => log.push(e),
		notify: () => undefined,
	});
	c.helloProvider();
	const started = Date.now();
	c.kick(fakeCtx(branch));
	assert.ok(Date.now() - started < 50);
	assert.equal(log[0]?.type, "hello");
	assert.equal(log[1]?.type, "update");
	if (log[1]?.type === "update") assert.equal(log[1].status, "pending");
	await new Promise((r) => setTimeout(r, 30));
	const last = log.at(-1);
	assert.equal(last?.type, "update");
	if (last?.type === "update") {
		assert.equal(last.status, "failed");
		assert.notEqual(last.status, "empty");
		assert.equal(last.replyEntryId, "a1");
		assert.match(last.key, /^sess:a1:\d+$/);
	}
});

test("sidebar hello after provider still handshakes; abort clears; late select is ignored", () => {
	const log: TaskAssistantEvent[] = [];
	const c = new PostReplyController({ emit: (e) => log.push(e), notify: () => undefined });
	c.onBus({ type: "hello", version: 1, role: "sidebar" });
	assert.equal(log.some((e) => e.type === "hello" && e.role === "provider"), true);
	c.abort("agent_start");
	assert.equal(log.at(-1)?.type, "clear");
	const fake = ui();
	assert.equal(c.fill("missing", "a1-1", "sel-1", fake), "blocked");
	assert.equal(fake.editorText(), "");
});

test("fill writes empty editor only, is not a sent dispatch, and is idempotent on selectionId", () => {
	const log: TaskAssistantEvent[] = [];
	const c = new PostReplyController({ emit: (e) => log.push(e), notify: () => undefined });
	c.kick(fakeCtx(branch));
	const pending = log.find((e) => e.type === "update");
	assert.equal(pending?.type, "update");
	if (pending?.type !== "update") return;
	(c as unknown as { snapshot: typeof pending }).snapshot = {
		...pending,
		status: "ready",
		directions: [{ id: "d1-1", kind: "direction", label: "方向", prompt: "按目标做天气应用。" }],
		actions: [{ id: "a1-1", kind: "action", label: "回答", prompt: "用 OpenWeather，先写只读查询。" }],
	};
	const box = ui();
	assert.equal(c.fill(pending.key, "a1-1", "sel-1", box), "filled");
	assert.equal(box.editorText(), "用 OpenWeather，先写只读查询。");
	assert.equal(c.fill(pending.key, "a1-1", "sel-1", box), "ignored");
	let occupied = "已有草稿";
	const blocked = ui({
		editorText: () => occupied,
		setEditorText: (t) => {
			occupied = t;
		},
	});
	assert.equal(c.fill(pending.key, "d1-1", "sel-2", blocked), "blocked");
	assert.equal(occupied, "已有草稿");
	const waiting = ui({ isIdle: () => false });
	assert.equal(c.fill(pending.key, "a1-1", "sel-3", waiting), "blocked");
	assert.equal(c.fillIndex(1, waiting), "blocked");
	const empty = ui();
	assert.equal(c.fillIndex(1, empty), "filled");
	assert.equal(empty.editorText(), "按目标做天气应用。");
});

test("blocked fill can retry; FIFO drops oldest accepted id only", () => {
	const log: TaskAssistantEvent[] = [];
	const c = new PostReplyController({ emit: (e) => log.push(e), notify: () => undefined });
	c.kick(fakeCtx(branch));
	const pending = log.find((e) => e.type === "update");
	if (pending?.type !== "update") return;
	(c as unknown as { snapshot: typeof pending }).snapshot = {
		...pending,
		status: "ready",
		directions: [{ id: "d1-1", kind: "direction", label: "方向", prompt: "按目标做天气应用。" }],
		actions: [],
	};
	assert.equal(c.fill(pending.key, "d1-1", "retry-me", ui({ isIdle: () => false })), "blocked");
	const again = ui();
	assert.equal(c.fill(pending.key, "d1-1", "retry-me", again), "filled");
	const fifo = c as unknown as { filledSelect: string[]; rememberFilled(id: string): void };
	for (let i = 0; i < 70; i++) fifo.rememberFilled(`id-${i}`);
	assert.equal(fifo.filledSelect.length, 64);
	assert.equal(fifo.filledSelect[0], "id-6");
	assert.equal(fifo.filledSelect.includes("id-0"), false);
});

test("status distinguishes no generation from filtered candidates and clears stale diagnostics", async () => {
	const log: TaskAssistantEvent[] = [];
	let resolveDone!: () => void;
	const done = new Promise<void>((resolve) => { resolveDone = resolve; });
	const c = new PostReplyController({
		emit: (event) => {
			log.push(event);
			if (event.type === "update" && event.status === "empty") resolveDone();
		},
		notify: () => undefined,
	});
	// Isolate generation; the empty result must skip judging entirely.
	const internals = c as unknown as {
		generate(): Promise<{ kind: "empty" }>;
		judge(): Promise<never>;
		job?: { candidateCount?: number; scores?: { label: string; score: number }[] };
	};
	internals.generate = async () => ({ kind: "empty" });
	internals.judge = async () => { assert.fail("empty generation must not call Jev"); };
	c.kick(fakeCtx(branch));
	await done;
	assert.match(c.statusLine(), /模型未生成候选或全被上半区覆盖，未调用 Jev/);
	assert.equal(c.current()?.status, "empty");
	assert.ok(internals.job);
	internals.job.candidateCount = 2;
	internals.job.scores = [{ label: "查看差异", score: 1.92 }, { label: "重复测试", score: 1.06 }];
	assert.match(c.statusLine(), /候选 2 条，最高 1\.92，门槛 1\.7/);
	assert.match(c.statusLine(), /查看差异 1\.92；重复测试 1\.06/);
	c.abort("switch");
	assert.doesNotMatch(c.statusLine(), /1\.92|候选 2 条/);
	c.kick(fakeCtx([]));
	assert.match(c.statusLine(), /回复后建议：无 ·/);
});

test("late covered push drops a live snapshot the upper pane now shows", () => {
	const log: TaskAssistantEvent[] = [];
	const c = new PostReplyController({ emit: (e) => log.push(e), notify: () => undefined });
	c.kick(fakeCtx(branch));
	const pending = log.find((e) => e.type === "update");
	if (pending?.type !== "update") return;
	(c as unknown as { snapshot: typeof pending }).snapshot = {
		...pending,
		status: "ready",
		directions: [{ id: "d1-1", kind: "direction", label: "输入1试试", prompt: "输入 1 试试看侧栏。" }],
		actions: [{ id: "a1-1", kind: "action", label: "看看时间线状态", prompt: "跑一下 /timeline status。" }],
	};
	c.setCovered("sess", ["输入1试试", "跑一下 /timeline status"], "a1");
	const last = log.at(-1);
	if (last?.type !== "update") assert.fail("covered push must re-publish");
	assert.deepEqual(last.directions, []);
	assert.deepEqual(last.actions, []);
	assert.equal(last.status, "empty");
	assert.match(c.statusLine(), /与上半区预测重复已让位/);
});

test("advice anchor is scoped to its session and expires", () => {
	const c = new PostReplyController({ emit: () => undefined, notify: () => undefined });
	const internals = c as unknown as { usableAnchor(sessionId: string, replyEntryId: string): { goal: string } | undefined; anchor?: { at: number } };
	c.setAnchor("sess-a", { sessionId: "sess-a", replyEntryId: "a1", goal: "做天气应用", decisions: ["定了用 OpenWeather"], userMessages: ["做天气应用"] });
	assert.equal(internals.usableAnchor("sess-a", "a1")?.goal, "做天气应用");
	assert.equal(internals.usableAnchor("sess-a", "a2"), undefined);
	assert.equal(internals.usableAnchor("sess-b", "a1"), undefined);
	assert.ok(internals.anchor);
	internals.anchor.at = Date.now() - 31 * 60 * 1000;
	assert.equal(internals.usableAnchor("sess-a", "a1"), undefined);
});

test("parsed bus events keep provider then sidebar then select order", () => {
	const types = [
		{ type: "hello", version: 1, role: "provider" },
		{ type: "hello", version: 1, role: "sidebar" },
		{ type: "update", version: 1, key: "s:a1:1", sessionId: "s", replyEntryId: "a1", revision: 1, status: "ready", directions: [], actions: [] },
		{ type: "select", version: 1, key: "s:a1:1", itemId: "a1-1", selectionId: "x" },
	].map((e) => parseTaskAssistantEvent(e)?.type);
	assert.deepEqual(types, ["hello", "hello", "update", "select"]);
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const duplicate: SuggestionItem = { id: "a1-1", kind: "action", label: "运行侧栏验收测试", prompt: "运行侧栏验收测试。", evidence: "用户要求验收侧栏。" };
const distinct: SuggestionItem = { id: "a1-2", kind: "action", label: "检查鼠标交互", prompt: "检查鼠标交互。", evidence: "用户要求可点选。" };

function controlledQueue(generate?: (target: PostReplyTarget) => Promise<GenerateResult>) {
	const terminal = deferred<TaskAssistantUpdate>();
	const enteredJudge = deferred<void>();
	const judgeResult = deferred<JudgeResult>();
	const events: TaskAssistantEvent[] = [];
	const controller = new PostReplyController({
		emit: (event) => {
			events.push(event);
			if (event.type === "update" && event.status !== "pending") terminal.resolve(event);
		},
		notify: () => undefined,
	});
	const internals = controller as unknown as {
		generate(ctx: ExtensionContext, job: { target: PostReplyTarget }): Promise<GenerateResult>;
		judge(items: SuggestionItem[]): Promise<JudgeResult>;
	};
	internals.generate = async (_ctx, job) => generate ? generate(job.target) : { kind: "ok", value: { directions: [], actions: [duplicate, distinct] } };
	internals.judge = async () => { enteredJudge.resolve(); return judgeResult.promise; };
	return { controller, terminal, enteredJudge, judgeResult, events };
}

test("coverage arriving during Jev judgment is filtered before the first ready publication", { timeout: 2000 }, async () => {
	const q = controlledQueue();
	q.controller.kick(fakeCtx(branch));
	await q.enteredJudge.promise;
	q.controller.setCovered("sess", [duplicate.prompt], "a1");
	q.judgeResult.resolve({ kind: "ready", directions: [], actions: [duplicate, distinct] });
	const result = await q.terminal.promise;
	assert.equal(result.status, "ready");
	assert.deepEqual(result.actions.map((i) => i.id), [distinct.id]);
	assert.equal(q.events.some((e) => e.type === "update" && e.status === "ready" && e.actions.some((i) => i.id === duplicate.id)), false);
});

test("coverage arriving during generation skips judging when all candidates are covered", { timeout: 2000 }, async () => {
	const generated = deferred<GenerateResult>();
	const entered = deferred<void>();
	const q = controlledQueue(async () => { entered.resolve(); return generated.promise; });
	q.controller.kick(fakeCtx(branch));
	await entered.promise;
	q.controller.setCovered("sess", [duplicate.prompt], "a1");
	generated.resolve({ kind: "ok", value: { directions: [], actions: [duplicate] } });
	assert.equal((await q.terminal.promise).status, "empty");
	assert.match(q.controller.statusLine(), /未调用 Jev/);
});

test("an empty coverage push clears the running target before filtering", { timeout: 2000 }, async () => {
	const q = controlledQueue();
	q.controller.setCovered("sess", [duplicate.prompt], "a1");
	q.controller.kick(fakeCtx(branch));
	q.controller.setCovered("sess", [], "a1");
	await q.enteredJudge.promise;
	q.judgeResult.resolve({ kind: "ready", directions: [], actions: [duplicate] });
	assert.equal((await q.terminal.promise).actions[0]?.id, duplicate.id);
});

test("lifecycle invalidation and exact reply binding reject old turn and branch coverage", { timeout: 2000 }, async () => {
	for (const reason of ["agent_start", "switch", "tree", "compact", "session_start"]) {
		let captured: PostReplyTarget | undefined;
		const q = controlledQueue(async (target) => { captured = target; return { kind: "ok", value: { directions: [], actions: [duplicate] } }; });
		q.controller.setAnchor("sess", { sessionId: "sess", replyEntryId: "a1", goal: "旧目标", decisions: [], userMessages: [] });
		q.controller.setCovered("sess", [duplicate.prompt], "a1");
		q.controller.abort(reason);
		// An old asynchronous push may still arrive after invalidation.
		q.controller.setCovered("sess", [duplicate.prompt], "a1");
		q.controller.setAnchor("sess", { sessionId: "sess", replyEntryId: "a1", goal: "旧目标", decisions: [], userMessages: [] });
		const fork = [branch[0], { ...branch[1], id: "a2" }];
		q.controller.kick(fakeCtx(fork));
		q.controller.setCovered("sess", [duplicate.prompt], "a1");
		await q.enteredJudge.promise;
		assert.equal(captured?.anchor, undefined, reason);
		assert.equal(captured?.covered, undefined, reason);
		q.judgeResult.resolve({ kind: "ready", directions: [], actions: [duplicate] });
		assert.equal((await q.terminal.promise).actions.length, 1, reason);
	}
});

test("provider-first event order receives the current anchor before generation", { timeout: 2000 }, async () => {
	let captured: PostReplyTarget | undefined;
	const q = controlledQueue(async (target) => { captured = target; return { kind: "empty" }; });
	q.controller.kick(fakeCtx(branch));
	// Model generation is deferred until synchronous settled handlers finish.
	q.controller.onAdviceContext({ sessionId: "sess", replyEntryId: "a1", goal: "天气应用", decisions: ["选择 OpenWeather"], userMessages: ["做天气应用"] });
	await q.terminal.promise;
	assert.equal(captured?.anchor?.goal, "天气应用");
	assert.deepEqual(captured?.anchor?.decisions, ["选择 OpenWeather"]);
});

test("an aborted judging job never resurrects advice", { timeout: 2000 }, async () => {
	const q = controlledQueue();
	q.controller.kick(fakeCtx(branch));
	await q.enteredJudge.promise;
	q.controller.abort("tree");
	q.judgeResult.resolve({ kind: "ready", directions: [], actions: [duplicate] });
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(q.controller.current(), undefined);
	assert.equal(q.events.at(-1)?.type, "clear");
});

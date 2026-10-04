import assert from "node:assert/strict";
import { test } from "node:test";
import type { TimelineStep, TimelineStepV1 } from "./contracts.ts";
import {
	PREDICTION_TEXT_MAX,
	actionList,
	budgetPieces,
	buildView,
	chunk,
	collectRecords,
	commandShape,
	computeStats,
	countPatch,
	emptyStats,
	type Entry,
	extractGoalSection,
	formatTokens,
	goalLine,
	isContinueMessage,
	keptMessages,
	lineCount,
	parseBatch,
	parseJsonObject,
	parseSummary,
	phaseList,
	phasesBefore,
	scorePart,
	splitTurns,
	statsParts,
	turnText,
	turnUntil,
	unsummarizedTurns,
	upcastStep,
	userMessagesBefore,
	wrapText,
	parseBrief,
	redact,
	redactDeep,
	compactionProblems,
	isEmptyTurn,
	pickRuns,
	previousContext,
	scoreFlags,
	turnDecisions,
	isVagueNext,
	scrubNextSteps,
} from "./core.ts";

const ts = (min: number) => new Date(Date.UTC(2026, 8, 26, 1, min)).toISOString();
const user = (id: string, text: string, min: number): Entry => ({
	type: "message",
	id,
	timestamp: ts(min),
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, min: number, blocks: unknown[], cost = 0): Entry => ({
	type: "message",
	id,
	timestamp: ts(min),
	message: { role: "assistant", content: blocks, usage: { totalTokens: 100, cost: { total: cost } } },
});
const result = (id: string, min: number, callId: string, name: string, extra: Record<string, unknown> = {}): Entry => ({
	type: "message",
	id,
	timestamp: ts(min),
	message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "ok" }], ...extra },
});

/** A user message plus a one-line reply (an answered turn: unanswered ones are hidden from the view). */
const turn = (id: string, text: string, min: number): Entry[] => [user(id, text, min), assistant(`${id}-a`, min, [{ type: "text", text: `re ${text}` }])];

const PATCH = "--- a/x.ts\n+++ b/x.ts\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n+d\n";

function sampleBranch(): Entry[] {
	return [
		{ type: "session", id: "s0", timestamp: ts(0) },
		user("u1", "帮我做时间线侧栏", 1),
		assistant("a1", 2, [
			{ type: "thinking", thinking: "secret plan" },
			{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/r.ts" } },
			{ type: "toolCall", id: "c2", name: "edit", arguments: { path: "/x.ts", edits: [] } },
			{ type: "toolCall", id: "c3", name: "bash", arguments: { command: "git -C /repo commit -m wip" } },
			{ type: "toolCall", id: "c4", name: "subagent", arguments: { agent: "scout", task: "look" } },
			{ type: "toolCall", id: "c5", name: "write", arguments: { path: "/y.md", content: "l1\nl2\nl3" } },
			{ type: "toolCall", id: "c6", name: "bash", arguments: { command: "false" } },
		], 0.01),
		result("r1", 3, "c1", "read"),
		result("r2", 3, "c2", "edit", { details: { patch: PATCH } }),
		result("r3", 3, "c3", "bash"),
		result("r4", 3, "c4", "subagent"),
		result("r5", 3, "c5", "write"),
		result("r6", 3, "c6", "bash", { isError: true }),
		assistant("a2", 5, [{ type: "text", text: "侧栏骨架写好了" }], 0.02),
		{ type: "custom", id: "x1", timestamp: ts(5), customType: "other", data: {} },
		user("u2", "继续", 6),
		assistant("a3", 8, [{ type: "text", text: "加了宽度调整" }]),
	];
}

test("splitTurns: one turn per user message, toId is the last message entry", () => {
	const turns = splitTurns(sampleBranch());
	assert.equal(turns.length, 2);
	assert.equal(turns[0].fromId, "u1");
	assert.equal(turns[0].toId, "a2");
	assert.equal(turns[1].fromId, "u2");
	assert.equal(turns[1].toId, "a3");
});

test("computeStats: tool categories, patch lines, files, commits, errors, agents, cost", () => {
	const [t1] = splitTurns(sampleBranch());
	const s = computeStats(t1);
	assert.deepEqual(s.tools, { read: 1, edit: 2, run: 2, search: 0, agent: 1, ask: 0, other: 0 });
	assert.equal(s.added, 2 + 3); // patch +2, write 3 lines
	assert.equal(s.removed, 1);
	assert.deepEqual(s.files, ["/x.ts", "/y.md"]);
	assert.equal(s.commits, 1);
	assert.equal(s.errors, 1);
	assert.deepEqual(s.agents, ["scout"]);
	assert.equal(Math.round(s.cost * 1000), 30);
	assert.equal(s.durationMs, 4 * 60000);
});

test("countPatch ignores headers", () => {
	assert.deepEqual(countPatch(PATCH), { added: 2, removed: 1 });
});

test("keptMessages: text of user/assistant messages from firstKeptEntryId up to the compaction", () => {
	const branch: Entry[] = [
		user("u1", "old task", 1),
		assistant("a1", 2, [{ type: "text", text: "old reply" }]),
		user("u2", "append a line to b.txt", 3),
		assistant("a2", 4, [
			{ type: "thinking", thinking: "hidden" },
			{ type: "toolCall", id: "c", name: "edit", arguments: {} },
		]),
		result("r", 4, "c", "edit"),
		assistant("a3", 5, [{ type: "text", text: "appended" }]),
		{ type: "compaction", id: "k", timestamp: ts(6), summary: "## Goal\n- old task", firstKeptEntryId: "u2" },
		user("u3", "after", 7),
	];
	assert.deepEqual(keptMessages(branch, "k", 8, 100), [
		{ role: "user", text: "append a line to b.txt" },
		{ role: "assistant", text: "appended" },
	]);
	assert.deepEqual(keptMessages(branch, "k", 1, 100), [{ role: "assistant", text: "appended" }]);
	assert.deepEqual(keptMessages(branch, "missing", 8, 100), []);
	const noKept = branch.map((e) => (e.id === "k" ? { ...e, firstKeptEntryId: undefined } : e));
	assert.deepEqual(keptMessages(noKept, "k", 8, 100), []);
});

test("lineCount: trailing newline is not an extra line", () => {
	assert.equal(lineCount(""), 0);
	assert.equal(lineCount("hello world\n"), 1);
	assert.equal(lineCount("a\nb"), 2);
	assert.equal(lineCount("a\nb\n"), 2);
	assert.equal(lineCount("\n"), 1);
});

test("computeStats: lens_diagnostics is not counted as a read", () => {
	const s = computeStats({
		startedAt: 0,
		endedAt: 0,
		entries: [assistant("a", 1, [{ type: "toolCall", id: "c", name: "lens_diagnostics", arguments: {} }])],
	});
	assert.equal(s.tools.read, 0);
	assert.equal(s.tools.other, 1);
});

test("turnText keeps user text and assistant text only (no thinking, no tool calls)", () => {
	const [t1] = splitTurns(sampleBranch());
	const t = turnText(t1);
	assert.equal(t.user, "帮我做时间线侧栏");
	assert.equal(t.assistant, "侧栏骨架写好了");
	assert.ok(!t.assistant.includes("secret"));
});

test("turnText redacts secrets", () => {
	const b = [user("u", "key is sk-abcdefghijklmnopqrstuvwxyz123", 1)];
	assert.ok(turnText(splitTurns(b)[0]).user.includes("sk-[redacted]"));
});

test("isContinueMessage", () => {
	assert.equal(isContinueMessage("继续"), true);
	assert.equal(isContinueMessage("好的。"), true);
	assert.equal(isContinueMessage("OK"), true);
	assert.equal(isContinueMessage("继续把侧栏做完"), false);
	assert.equal(isContinueMessage("换个话题"), false);
});

test("extractGoalSection handles both compaction prompt formats", () => {
	assert.equal(extractGoalSection("## Goal\n- 做侧栏\n\n## Constraints\n- x"), "- 做侧栏");
	assert.equal(extractGoalSection("### 1. Goal & Progress\n- 做 A 🔄\n### 2. Current Work\nb"), "- 做 A 🔄");
	assert.equal(extractGoalSection("## Original Request\n做 B\n## Progress So Far\nc"), "做 B");
	assert.equal(extractGoalSection("no headings here"), "no headings here");
});

test("parseSummary v2: intent / result / next / directions, truncation, bad status, bad JSON", () => {
	const ok = parseSummary(
		'```json\n{"continue_phase":false,"phase_title":"时间线","intent":"写意图书","result":"意图书写完并过审","status":"done","goal":"做侧栏","next":["开工 v1","开工 v1","挪进 extensions"],"directions":["做 v3"]}\n```',
	);
	assert.equal(typeof ok, "object");
	if (typeof ok === "object") {
		assert.equal(ok.intent, "写意图书");
		assert.equal(ok.result, "意图书写完并过审");
		assert.deepEqual(ok.next, ["开工 v1", "挪进 extensions"]); // duplicates dropped
		assert.deepEqual(ok.directions, ["做 v3"]);
	}
	// result that only repeats the intent is dropped; directions only when done; v1 `step` still read as intent
	const same = parseSummary('{"continue_phase":true,"phase_title":"天气","step":"搜索北京天气","result":"搜索北京天气。","status":"in_progress","goal":"","next":[],"directions":["x"]}');
	assert.equal(typeof same, "object");
	if (typeof same === "object") {
		assert.equal(same.intent, "搜索北京天气");
		assert.equal(same.result, "");
		assert.deepEqual(same.directions, []);
	}
	const long = parseSummary(
		JSON.stringify({ continue_phase: true, phase_title: "标".repeat(50), intent: "步".repeat(80), result: "果".repeat(99), status: "in_progress", goal: "", next: ["n".repeat(99)] }),
	);
	assert.equal(typeof long, "object");
	if (typeof long === "object") {
		assert.ok([...long.intent].length <= 40);
		assert.ok([...long.result].length <= 56);
		assert.ok([...long.phase_title].length <= 24);
		assert.equal(long.next[0], "n".repeat(99)); // Copy/fill text is never a display abbreviation.
	}
	assert.match(String(parseSummary('{"continue_phase":true,"phase_title":"a","intent":"b","status":"maybe","goal":""}')), /status/);
	assert.match(String(parseSummary("not json")), /JSON/);
	assert.match(String(parseSummary("{bad json}")), /JSON/);
});

test("single and batch predictions preserve complete longer text; oversize fails without abbreviation", () => {
	const next = `请检查 ${"extensions/session-timeline/".repeat(4)}sidebar.ts 的宽度变化后是否能完整复制`;
	const direction = "继续完善侧边栏的完整文字展示、缓存恢复和多行复制能力，避免再次丢失结尾内容";
	const fields = { continue_phase: false, phase_title: "显示", intent: "修复截断", result: "完成", status: "done", goal: "完整复制" };
	const one = parseSummary(JSON.stringify({ ...fields, next: [next], directions: [direction] }));
	const batch = parseBatch(JSON.stringify({ turns: [{ ...fields, id: "T1" }], next: [next], directions: [direction] }), ["T1"]);
	for (const result of [one, batch]) {
		assert.notEqual(typeof result, "string");
		if (typeof result === "string") assert.fail(result);
		assert.deepEqual(result.next, [next]);
		assert.deepEqual(result.directions, [direction]);
	}
	for (const key of ["next", "directions"]) {
		const oversized = { ...fields, [key]: ["长".repeat(PREDICTION_TEXT_MAX + 1)] };
		assert.match(String(parseSummary(JSON.stringify(oversized))), /超过.*未截断保存/);
		assert.match(String(parseBatch(JSON.stringify({ ...oversized, turns: [{ ...fields, id: "T1" }] }), ["T1"])), /超过.*未截断保存/);
	}
});

test("parseJsonObject salvages a later summary when an earlier brace span is broken", () => {
	const raw = parseJsonObject('先看 {not json} 然后 {"intent":"检查更新","continue_phase":true,"phase_title":"查更新","status":"done","goal":"整理"} 尾巴 }');
	assert.equal(typeof raw, "object");
	if (typeof raw === "object") assert.equal(raw.intent, "检查更新");
	const quoted = parseJsonObject('{"intent":"a}b","continue_phase":true,"phase_title":"t","status":"done","goal":"g"}');
	assert.equal(typeof quoted, "object");
	if (typeof quoted === "object") assert.equal(quoted.intent, "a}b");
});

test("parseBatch: per-turn validation, missing turns, next only when the last turn is done", () => {
	const t = (id: string, status = "done") => ({ id, continue_phase: false, phase_title: "P", intent: `i-${id}`, result: "", status, goal: "g" });
	const reply = JSON.stringify({ turns: [t("T1"), { ...t("T2"), status: "weird" }, t("T4"), t("T3")], next: ["a", "b"], directions: ["d"] });
	const r = parseBatch(reply, ["T1", "T2", "T3"]);
	assert.equal(typeof r, "object");
	if (typeof r === "object") {
		assert.equal(typeof r.turns.get("T1"), "object");
		assert.match(String(r.turns.get("T2")), /status/);
		assert.equal(typeof r.turns.get("T3"), "object"); // order in the reply does not matter
		assert.equal(r.turns.has("T4"), false); // ids not asked for are ignored
		assert.deepEqual(r.next, ["a", "b"]);
		assert.deepEqual(r.directions, ["d"]);
	}
	const notDone = parseBatch(JSON.stringify({ turns: [t("T1", "in_progress")], next: ["a"], directions: ["d"] }), ["T1"]);
	if (typeof notDone === "object") assert.deepEqual(notDone.directions, []);
	const missing = parseBatch(JSON.stringify({ turns: [t("T1")] }), ["T1", "T2"]);
	if (typeof missing === "object") assert.match(String(missing.turns.get("T2")), /T2/);
	assert.match(String(parseBatch("nope", ["T1"])), /JSON/);
	assert.match(String(parseBatch('{"x":1}', ["T1"])), /turns/);
});

test("commandShape keeps program + plain words only (no flag values, quotes, paths, URLs, env)", () => {
	assert.equal(commandShape('git -C /repo commit -m "fix: secret"'), "git commit");
	assert.equal(commandShape("PASSWORD=hunter2 mysql -u root -pSecret db"), "mysql db");
	assert.equal(commandShape('curl -H "Authorization: Bearer abc" https://x.com/?token=1'), "curl");
	assert.equal(commandShape("npm test && cd /tmp/x && ./scripts/run.sh --flag"), "npm test && run.sh"); // cd says nothing
	assert.equal(commandShape(""), "");
});

test("actionList: files changed, reads, commands (✗ failed), subagents; no tool output", () => {
	const [t1] = splitTurns(sampleBranch());
	assert.equal(actionList(t1), "改 /x.ts, /y.md\n读 1 次（/r.ts）\n跑 git commit\n跑 false ✗\n派 scout：look");
	assert.ok(!actionList(t1).includes("secret")); // no thinking; exact match above proves no tool output either
	assert.equal(actionList({ entries: [user("u", "hi", 1)] }), "");
});

test("budgetPieces: under budget joins everything; over budget keeps start, end and the replies around a compaction", () => {
	assert.equal(budgetPieces([{ text: "a", nearCompaction: false }, { text: "b", nearCompaction: false }], 100), "a\nb");
	const pieces = [
		{ text: "a".repeat(1000), nearCompaction: false },
		{ text: "b".repeat(1000), nearCompaction: true },
		{ text: "c".repeat(1000), nearCompaction: false },
		{ text: "d".repeat(1000), nearCompaction: false },
	];
	const out = budgetPieces(pieces, 1000);
	assert.ok(out.startsWith("a".repeat(250)));
	assert.ok(out.endsWith("d".repeat(550)));
	assert.ok(out.includes("bbb"));
	assert.ok(!out.includes("ccc"));
	const plain = budgetPieces(pieces.map((p) => ({ ...p, nearCompaction: false })), 1000);
	assert.ok(plain.endsWith("d".repeat(750))); // no compaction: the end gets that share
	assert.ok(!plain.includes("bbb"));
});

test("turnUntil: the part of a turn before a mid-turn compaction", () => {
	const branch: Entry[] = [
		user("u1", "long task", 1),
		assistant("a1", 2, [{ type: "text", text: "step 1 done" }]),
		{ type: "compaction", id: "k", timestamp: ts(3), summary: "## Goal\n- long task", firstKeptEntryId: "u1" },
		assistant("a2", 4, [{ type: "text", text: "step 2 done" }]),
	];
	const [turn] = splitTurns(branch);
	assert.equal(turn.toId, "a2");
	const part = turnUntil(turn, "k");
	assert.equal(part.toId, "a1");
	assert.equal(part.entries.length, 2);
	assert.equal(turnText(part).assistant, "step 1 done");
	assert.equal(turnUntil(turn, "missing").toId, "a2");
});

function step(fromId: string, phaseId: string, title: string, min: number, extra: Partial<TimelineStepV1> = {}): TimelineStepV1 {
	return {
		v: 1,
		kind: "step",
		fromId,
		toId: fromId,
		startedAt: Date.parse(ts(min)),
		endedAt: Date.parse(ts(min + 1)),
		phase: { id: phaseId, title, isNew: fromId === phaseId },
		summary: `s-${fromId}`,
		status: "in_progress",
		goal: `goal-${fromId}`,
		stats: emptyStats(),
		gen: { ok: true, model: "m", ms: 1 },
		...extra,
	};
}
const rec = (id: string, data: unknown): Entry => ({ type: "custom", id, customType: "session-timeline", data });
const step2 = (fromId: string, phaseId: string, title: string, min: number, extra: Partial<TimelineStep> = {}): TimelineStep => ({
	...upcastStep(step(fromId, phaseId, title, min)),
	intent: `i-${fromId}`,
	...extra,
});

test("buildView: phase grouping, compaction split, latest record wins, unknown versions counted", () => {
	const branch: Entry[] = [
		user("u1", "a", 1),
		assistant("a1", 1, [{ type: "text", text: "x" }]),
		rec("r1", step("u1", "u1", "阶段A", 1, { gen: { ok: false, model: "m", ms: 1, error: "boom" } })),
		...turn("u2", "b", 2),
		rec("r2", step("u2", "u1", "阶段A", 2)),
		rec("r2b", step("u2", "u1", "阶段A旧名", 2)), // retry of an earlier turn must not rename the phase
		rec("r1b", step("u1", "u1", "阶段A改名", 1)), // retry of u1 wins, and renames phase
		{ type: "compaction", id: "c1", timestamp: ts(3), summary: "## Goal\n- A", tokensBefore: 368000 },
		{ type: "custom", id: "k1", customType: "session-timeline-compaction", data: { v: 1, kind: "compaction", compactionId: "c1", at: 1, tokensBefore: 368000, preGoal: "g", postGoal: "A" } },
		...turn("u3", "c", 4),
		rec("r3", step("u3", "u1", "阶段A改名", 4)),
		...turn("u4", "d", 5),
		rec("r4", step("u4", "u4", "阶段B", 5, { status: "done" })),
		{ type: "custom", id: "bad", customType: "session-timeline", data: { v: 2 } },
	];
	const v = buildView(branch);
	assert.equal(v.unknownVersions, 1);
	assert.equal(v.steps, 4);
	assert.equal(v.failed, 0);
	assert.deepEqual(
		v.items.map((i) => (i.kind === "phase" ? `${i.title}${i.continued ? "(续)" : ""}:${i.steps.length}` : `压缩:${i.check ? "有检查" : "无"}`)),
		["阶段A改名:2", "压缩:有检查", "阶段A改名(续):1", "阶段B:1"],
	);
	assert.equal(v.goal, "goal-u4");
	assert.equal(v.lastStep?.status, "done");
	const before = phasesBefore(v, "c1");
	assert.deepEqual(before.map((p) => p.title), ["阶段A改名"]);
	assert.deepEqual(userMessagesBefore(branch, "c1", 5, 100), ["a", "b"]);
});

test("buildView uses in-memory records not yet written", () => {
	const branch: Entry[] = [user("u1", "a", 1)];
	const v = buildView(branch, [step2("u1", "u1", "内存", 1)]);
	assert.equal(v.steps, 1);
	assert.equal(v.items[0].kind === "phase" && v.items[0].title, "内存");
});

test("statsParts respects module switches", () => {
	const s = { ...emptyStats(), tools: { read: 2, edit: 1, run: 0, search: 0, agent: 1, ask: 0, other: 0 }, added: 3, removed: 1, files: ["a"], errors: 1, commits: 1, durationMs: 120000, agents: ["scout"] };
	const all = { time: true, duration: true, tools: true, diff: true, agents: true, errors: true, commits: true, cost: false, goal: true, compaction: true, score: true, next: true, hints: true };
	assert.deepEqual(statsParts(s, all).map((p) => p.text), ["读2 改1", "+3−1 1文件", "代理 scout", "⚠1", "✓commit", "2分"]);
	assert.deepEqual(statsParts(s, { ...all, tools: false, diff: false, agents: false, errors: false, commits: false }).map((p) => p.text), ["2分"]);
	assert.deepEqual(statsParts(s, { ...all, tools: false, diff: false, agents: false, errors: false, commits: false, duration: false }), []);
});

test("goalLine strips markdown and joins the first two items", () => {
	assert.equal(goalLine("- **把管理端**换成 `frontend-admin/`\n- 补齐运营维度\n- 第三条"), "把管理端换成 frontend-admin/；补齐运营维度");
	assert.equal(goalLine("1. [x] 做 A\n"), "做 A");
	assert.equal(formatTokens(368605), "369k");
	assert.equal(formatTokens(1_200_000), "1.2M");
});

test("v1 records are upcast: the old one-liner becomes the intent", () => {
	const v1 = step("u1", "u1", "A", 1);
	const v2 = upcastStep(v1);
	assert.equal(v2.v, 2);
	assert.equal(v2.intent, "s-u1");
	assert.equal(v2.summary, "");
	const { steps } = collectRecords([user("u1", "a", 1), rec("r1", v1)]);
	assert.equal(steps.get("u1")?.intent, "s-u1");
});

test("collectRecords: interim (fallback) steps only where no record exists", () => {
	const branch: Entry[] = [user("u1", "a", 1), rec("r1", step2("u1", "u1", "A", 1)), user("u2", "b", 2)];
	const interim = [step2("u1", "u1", "临时", 1, { gen: { ok: true, model: "m", ms: 1, partial: true } }), step2("u2", "u1", "临时", 2, { gen: { ok: true, model: "m", ms: 1, partial: true } })];
	const { steps } = collectRecords(branch, [], [], interim);
	assert.equal(steps.get("u1")?.gen.partial, undefined);
	assert.equal(steps.get("u2")?.gen.partial, true);
});

test("unsummarizedTurns and chunk (backfill planning)", () => {
	const branch: Entry[] = [user("u1", "a", 1), user("u2", "b", 2), user("u3", "c", 3), user("u4", "d", 4)];
	const turns = splitTurns(branch);
	const steps = new Map<string, TimelineStep>([
		["u2", step2("u2", "u2", "B", 2)],
		["u3", step2("u3", "u3", "C", 3, { gen: { ok: true, model: "m", ms: 1, partial: true } })],
	]);
	assert.deepEqual(unsummarizedTurns(turns, steps, false).map((t) => t.fromId), ["u1", "u3", "u4"]);
	assert.deepEqual(unsummarizedTurns(turns, steps, true).map((t) => t.fromId), ["u1", "u3"]);
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(chunk([], 8), []);
});

test("a continuing step joins the phase before it, even if it recorded another phase id (gap re-run)", () => {
	// u2 was re-summarized after backfill filled u1 and now continues u1's phase; u3 still says it continues "u2".
	const s1 = step2("u1", "u1", "A", 1);
	const s2 = step2("u2", "u1", "A2", 2, { phase: { id: "u1", title: "A2", isNew: false } });
	const s3 = step2("u3", "u2", "B", 3, { phase: { id: "u2", title: "B", isNew: false } });
	const s4 = step2("u4", "u4", "C", 4, { phase: { id: "u4", title: "C", isNew: true } });
	const lines = phaseList([s1, s2, s3, s4]);
	assert.deepEqual(lines.map((l) => `${l.id}:${l.title}:${l.lastStep}`), ["u1:B:i-u3", "u4:C:i-u4"]);
	const branch: Entry[] = [...turn("u1", "a", 1), ...turn("u2", "b", 2), ...turn("u3", "c", 3), ...turn("u4", "d", 4)];
	const v = buildView(branch, [s1, s2, s3, s4]);
	assert.deepEqual(v.items.map((i) => (i.kind === "phase" ? `${i.id}:${i.title}:${i.steps.length}` : "k")), ["u1:B:3", "u4:C:1"]);
});

test("buildView: predictions belong to the latest turn only; phase score is its latest scored step", () => {
	const score = { completion: 1, level: 3, confidence: 0.9, offIntent: 0.1, ms: 1, tokens: 1 };
	const next = { steps: [{ text: "下一步", score: 0.8, confidence: 0.7 }], directions: [] };
	const s1 = step2("u1", "u1", "A", 1, { score, next });
	const s2 = step2("u2", "u1", "A", 2, { next: { steps: [{ text: "新的" }], directions: ["方向"] } });
	const one: Entry[] = [user("u1", "a", 1)];
	assert.equal(buildView(one, [s1]).next?.steps[0].text, "下一步");
	const two: Entry[] = [...turn("u1", "a", 1), user("u2", "b", 2)];
	assert.equal(buildView(two, [s1]).next, undefined); // newest message has no record yet → no stale predictions
	const v = buildView(two, [s1, s2]);
	assert.equal(v.next?.steps[0].text, "新的");
	assert.equal(v.items[0].kind === "phase" && v.items[0].score?.completion, 1);
	const partial = step2("u2", "u1", "A", 2, { gen: { ok: true, model: "m", ms: 1, partial: true }, next: { steps: [{ text: "x" }], directions: [] } });
	assert.equal(buildView(two, [s1], [], [partial]).next, undefined); // interim summaries never predict
	assert.equal(buildView(two, [s1, step2("u2", "u1", "A", 2, { next: { steps: [], directions: [] } })]).next, undefined);
});

test("scorePart: percent with tone; grey + ? when Jev is unsure", () => {
	assert.equal(scorePart(undefined), undefined);
	assert.deepEqual(scorePart({ completion: 0.9, level: 2.7, confidence: 0.8, offIntent: 0, ms: 1, tokens: 1 }), { text: "90%", tone: "ok" });
	assert.deepEqual(scorePart({ completion: 0.5, level: 1.5, confidence: 0.8, offIntent: 0, ms: 1, tokens: 1 }), { text: "50%", tone: "warn" });
	assert.deepEqual(scorePart({ completion: 0.2, level: 0.6, confidence: 0.8, offIntent: 0, ms: 1, tokens: 1 }), { text: "20%", tone: "bad" });
	assert.deepEqual(scorePart({ completion: 0.9, level: 2.7, confidence: 0.3, offIntent: 0, ms: 1, tokens: 1 }), { text: "90%?", tone: "muted" });
});

test("wrapText: CJK breaks anywhere, ASCII words stay whole, no line starts with closing punctuation", () => {
	const w = (t: string) => [...t].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/u.test(c) ? 2 : 1), 0);
	assert.deepEqual(wrapText("新文档已成功发布上线且验证通过，主项目无影响", 16, w), ["新文档已成功发布", "上线且验证通过，", "主项目无影响"]);
	assert.deepEqual(wrapText("一二三四五六七八，九", 16, w), ["一二三四五六七", "八，九"]); // "，" may not open a line
	assert.deepEqual(wrapText("为文档站配置GitHub Actions自动化部署", 14, w), ["为文档站配置", "GitHub Actions", "自动化部署"]);
	assert.deepEqual(wrapText("abcdefghij", 4, w), ["abcd", "efgh", "ij"]);
	assert.deepEqual(wrapText("  a   b  ", 10, w), ["a b"]);
	assert.deepEqual(wrapText("", 10, w), []);
	for (const line of wrapText("推荐Veridrop、GPQA及iqbench三合一方案，给出三层测试与题库选型方案。", 12, w)) {
		assert.ok(w(line) <= 12, line);
		assert.ok(!/^[，。、]/.test(line), line);
	}
});

test("wrapText: a lone CJK character never ends up alone on the last line", () => {
	const w = (t: string) => [...t].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/u.test(c) ? 2 : 1), 0);
	assert.deepEqual(wrapText("确认搜索抓取均无法绕过登录需手动登录", 34, w), ["确认搜索抓取均无法绕过登录需手动", "登录"]);
	assert.deepEqual(wrapText("一二三四五六七八九", 16, w), ["一二三四五六七", "八九"]);
	assert.deepEqual(wrapText("一二三四五六，七", 14, w), ["一二三四五", "六，七"]); // punctuation travels with the character before it
	assert.deepEqual(wrapText("abcdefg好", 8, w), ["abcdefg", "好"]); // nothing Chinese to pull down
	assert.deepEqual(wrapText("一二三四五六七。", 14, w), ["一二三四五", "六七。"]); // both rules at once
});

test("wrapText: trailing punctuation cluster never opens a line; carry only when it fits", () => {
	const w = (t: string) => [...t].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/u.test(c) ? 2 : 1), 0);
	const quoted = wrapText("这是一句话。“这又是一句话。”", 14, w);
	assert.ok(quoted.every((line) => w(line) <= 14), JSON.stringify(quoted));
	assert.ok(quoted.every((line) => !/^[，。、”；！？）]/.test(line)), JSON.stringify(quoted));
	assert.deepEqual(
		wrapText("一二三.....", 6, w).map((line) => w(line)),
		[6, 5],
	); // previously produced a 7-column "三....." line
	assert.deepEqual(wrapText("一二三.....", 6, w), ["一二三", "....."]);
});

test("wrapText: fixed corpus stays within room, keeps punctuation off line starts, and joins back", () => {
	const w = (t: string) => [...t].reduce((n, c) => n + (/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/u.test(c) ? 2 : 1), 0);
	// Same character class as core.ts NO_LINE_START (kept here so the invariant is explicit in the test).
	const noStart = /^[\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f\uff09\u300b\u300d\u300f\u3011\u201d\u2019,.;:!?)\]}%\u2026\u00b7]/u;
	const corpus = [
		"这是一句话。“这又是一句话。”",
		"推荐Veridrop、GPQA及iqbench三合一方案，给出三层测试与题库选型方案。",
		"确认搜索抓取均无法绕过登录需手动登录",
		"为文档站配置GitHub Actions自动化部署",
		"一二三四五六七八九十一二三四五。",
		"Hello, world! 中文（括号）结束。",
		"a/b/c.ts：已改完。",
		"结尾带省略与引号……。”",
	];
	for (const text of corpus) {
		for (let room = 4; room <= 30; room++) {
			const lines = wrapText(text, room, w);
			for (const line of lines) assert.ok(w(line) <= room, `room=${room} line=${JSON.stringify(line)}`);
			// Ordinary Chinese sentences (not ones that themselves open with closing punct) must not put
			// NO_LINE_START at the start of a wrapped line once there is a previous body character to carry.
			if (room >= 8 && !noStart.test(text)) {
				for (const line of lines) {
					assert.ok(!noStart.test(line), `room=${room} opens with punct: ${JSON.stringify(line)} from ${text}`);
				}
			}
			assert.equal(lines.join("").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
		}
	}
});

test("redact and redactDeep mask sk- keys in nested payloads", () => {
	const key = `sk-${"Ab1".repeat(12)}`; // 36 alnum after sk-; shared pattern needs ≥16
	assert.match(key, /^sk-[A-Za-z0-9]{16,}$/);
	assert.equal(redact(`export KEY=${key}`).includes(key), false);
	assert.match(redact(`token ${key}`), /sk-\[redacted\]/);
	// Fallback intent style: head of a redacted user message must not keep the raw key.
	const userRaw = redact(`请用 ${key} 调接口`);
	assert.equal(userRaw.includes(key), false);
	const deep = redactDeep({
		after_compaction: { summary: { goal_section: `Goal with ${key}`, full_text: `see ${key}` }, kept: [{ role: "user", text: key }] },
		n: 3,
		ok: true,
	});
	const blob = JSON.stringify(deep);
	assert.equal(blob.includes(key), false);
	assert.match(blob, /sk-\[redacted\]/);
	assert.equal(deep.n, 3);
	assert.equal(deep.ok, true);
});

test("parseBrief keeps one Chinese sentence and refuses English", () => {
	assert.equal(parseBrief("设计并开发对比两个官方渠道同一 Claude 模型的自动化测试工具"), "设计并开发对比两个官方渠道同一 Claude 模型的自动化测试工具");
	assert.equal(parseBrief("目标：做侧栏\n第二行"), "做侧栏");
	assert.equal(parseBrief("```\n“做侧栏”\n```"), "做侧栏");
	assert.equal(parseBrief("- **压缩后目标：** 做侧栏"), "做侧栏");
	assert.equal(parseBrief("Design and build a tool"), undefined);
	assert.equal(parseBrief("   "), undefined);
	assert.equal([...(parseBrief("长".repeat(80)) ?? "")].length, 50);
});

test("unanswered turns: detected, hidden from the view (except the newest), their words passed to the next turn", () => {
	const branch: Entry[] = [
		...turn("u1", "先查一下", 1),
		user("u2", "一大段需求原文", 2), // interrupted before any reply
		assistant("u2-a", 2, [{ type: "thinking", thinking: "..." }]),
		...turn("u3", "继续", 3),
		user("u4", "新消息", 4), // newest: may still be running
	];
	const turns = splitTurns(branch);
	assert.deepEqual(turns.map((t) => isEmptyTurn(t)), [false, true, false, true]);
	assert.equal(isEmptyTurn({ entries: [user("x", "a", 1), assistant("x-a", 1, [{ type: "toolCall", id: "c", name: "read", arguments: {} }])] }), false);
	const v = buildView(branch, [step2("u1", "u1", "A", 1), step2("u2", "u1", "A", 2, { intent: "未给出回复" }), step2("u3", "u1", "A", 3), step2("u4", "u1", "A", 4)]);
	assert.equal(v.steps, 3);
	assert.deepEqual(v.items.flatMap((i) => (i.kind === "phase" ? i.steps.map((s) => s.fromId) : [])), ["u1", "u3", "u4"]);
	const ctx = previousContext(turns, 2);
	assert.match(ctx, /助手上一轮回复的结尾：\nre 先查一下/);
	assert.match(ctx, /没回答就中断了的消息：\n一大段需求原文/);
	assert.equal(previousContext(turns, 0), "");
	const long = [...turn("a", "x", 1), assistant("a-b", 1, [{ type: "text", text: `开头${"中".repeat(2000)}结尾问题？` }])];
	const tail = previousContext(splitTurns([...long, ...turn("b", "好", 2)]), 1);
	assert.match(tail, /…中+结尾问题？$/);
	assert.ok(tail.length < 1300);
});

test("turnDecisions: the user's answers to ask_user_question, structured or from the result text; cancelled skipped", () => {
	const ask = (id: string, callId: string) => assistant(id, 1, [{ type: "toolCall", id: callId, name: "ask_user_question", arguments: {} }]);
	const branch: Entry[] = [
		user("u1", "开工", 1),
		ask("a1", "q1"),
		result("r1", 1, "q1", "ask_user_question", { details: { answers: [{ question: "用哪个模型？", answer: "Opus 5.5" }, { question: "预算？", answer: "" }] } }),
		ask("a2", "q2"),
		result("r2", 1, "q2", "ask_user_question", { content: [{ type: "text", text: 'User answered: "题源用哪年？"="2026 新题". "弱对照？"="Sonnet 5 low"' }] }),
		ask("a3", "q3"),
		result("r3", 1, "q3", "ask_user_question", { details: { cancelled: true, answers: [{ question: "x", answer: "y" }] } }),
		ask("a4", "q4"),
		result("r4", 1, "q4", "ask_user_question", { isError: true, details: { answers: [{ question: "x", answer: "y" }] } }),
	];
	assert.deepEqual(turnDecisions(splitTurns(branch)[0]), ["问：用哪个模型？ → 用户选：Opus 5.5", "问：题源用哪年？ → 用户选：2026 新题", "问：弱对照？ → 用户选：Sonnet 5 low"]);
	const key = `sk-${"Ab1".repeat(12)}`;
	const withKey: Entry[] = [user("u1", "a", 1), ask("a1", "q1"), result("r1", 1, "q1", "ask_user_question", { details: { answers: [{ question: "key？", answer: key } ] } })];
	assert.equal(turnDecisions(splitTurns(withKey)[0]).join("").includes(key), false);
});

test("commandShape drops noise programs; pickRuns keeps head, tail and verification commands in the middle", () => {
	assert.equal(commandShape("cd /repo && echo start && npm test"), "npm test");
	assert.equal(commandShape("sleep 5; git status"), "git status");
	const runs = Array.from({ length: 30 }, (_, i) => (i === 15 ? "npx tsc" : i === 20 ? "pytest" : `cmd${i}`));
	const out = pickRuns(runs);
	assert.ok(out.length <= 12 + 4);
	assert.deepEqual(out.slice(0, 3), ["跑 cmd0", "跑 cmd1", "跑 cmd2"]);
	assert.ok(out.includes("跑 npx tsc"));
	assert.ok(out.includes("跑 pytest"));
	assert.equal(out.at(-1), "跑 cmd29");
	assert.ok(out.some((l) => /^…中间另 \d+ 条命令$/.test(l)));
	assert.deepEqual(pickRuns(["a", "b"]), ["a", "b"]);
});

test("scoreFlags: only rubric-2 scores raise flags; not-done needs confidence and nothing waiting on the user", () => {
	const base = { completion: 0.2, level: 0.6, confidence: 0.8, offIntent: 0.1, rubric: 2 as const, waiting: 0.1, ms: 1, tokens: 1 };
	assert.deepEqual(scoreFlags(base), { offIntent: false, notDone: true });
	assert.deepEqual(scoreFlags({ ...base, waiting: 0.8 }), { offIntent: false, notDone: false }); // waiting on a key / login
	assert.deepEqual(scoreFlags({ ...base, confidence: 0.3 }), { offIntent: false, notDone: false });
	assert.deepEqual(scoreFlags({ ...base, completion: 0.9, offIntent: 0.7 }), { offIntent: true, notDone: false });
	assert.deepEqual(scoreFlags({ ...base, completion: 0.9, offIntent: 0.55 }), { offIntent: false, notDone: false });
	const { rubric: _, ...old } = base;
	assert.deepEqual(scoreFlags({ ...old, offIntent: 0.9 }), { offIntent: false, notDone: false }); // old rubric: not shown
	assert.deepEqual(scoreFlags(undefined), { offIntent: false, notDone: false });
});

test("compactionProblems: empty when the check is clean; lists direction / invented / current / missed phases", () => {
	const jev = { consistency: 0.9, level: 2.7, confidence: 0.8, invented: 0.1, currentCovered: 0.9, phases: [{ phaseId: "p", title: "A", covered: 0.9 }], ms: 1, tokens: 1 };
	const check = { v: 1 as const, kind: "compaction" as const, compactionId: "c", at: 1, tokensBefore: 1, preGoal: "g", postGoal: "g", keptMessages: 1, jev };
	assert.deepEqual(compactionProblems(check), []);
	assert.deepEqual(compactionProblems({ ...check, jev: undefined }), []);
	assert.deepEqual(compactionProblems({ ...check, jev: { ...jev, consistency: 0.2, confidence: 0.3 } }), []); // unsure direction
	assert.deepEqual(compactionProblems({ ...check, jev: { ...jev, currentCovered: -1 } }), []);
	assert.deepEqual(
		compactionProblems({ ...check, jev: { ...jev, consistency: 0.2, invented: 0.7, currentCovered: 0.3, phases: [{ phaseId: "p", title: "A", covered: 0.2 }] } }),
		["压缩后的目标和之前不是一个方向", "摘要里有你没提过的目标", "压缩后看不出当前在做的事", "漏了 A"],
	);
});

test("parseSummary / parseBatch carry mid-turn decisions and the session's current state", () => {
	const one = parseSummary('{"continue_phase":false,"phase_title":"筛题","intent":"筛 25 道题","result":"筛出 21 题","decisions":["题源改 2026 新题","弱对照改 Sonnet 5 low","题源改2026新题。","第四条"],"status":"in_progress","goal":"对比两渠道","now":"等你配 Bedrock 凭据","next":[]}');
	assert.ok(typeof one !== "string");
	assert.deepEqual(one.decisions, ["题源改 2026 新题", "弱对照改 Sonnet 5 low", "第四条"]);
	assert.equal(one.now, "等你配 Bedrock 凭据");
	const b = parseBatch('{"turns":[{"id":"T1","continue_phase":false,"phase_title":"a","intent":"b","result":"","status":"done","goal":""}],"now":"已跑通自检","next":[]}', ["T1"]);
	assert.ok(typeof b !== "string");
	const t1 = b.turns.get("T1");
	assert.ok(t1 && typeof t1 !== "string");
	assert.deepEqual(t1.decisions, []);
	assert.equal(b.now, "已跑通自检");
});

test("scrubNextSteps drops empty placeholders, keeps a concrete next message", () => {
	assert.equal(isVagueNext("继续"), true);
	assert.equal(isVagueNext("好的"), true);
	assert.equal(isVagueNext("下一步"), true);
	assert.equal(isVagueNext("用老会话实测回填"), false);
	assert.deepEqual(scrubNextSteps(["继续", "用老会话实测回填", "好的", ""]), ["用老会话实测回填"]);
});

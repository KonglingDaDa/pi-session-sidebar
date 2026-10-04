import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const require = createRequire(`${root}/package.json`);
const { createJiti } = require("jiti");
const loader = createJiti(import.meta.url, { fsCache: false, alias: {
	"@earendil-works/pi-tui": fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")),
} });
const { SessionManager } = await loader.import(`${root}/dist/core/session-manager.js`);
const { emptyStats } = await loader.import("./core.ts");
const { PostReplyController } = await loader.import("../advice/postreply-queue.ts");
const { POSTREPLY_CACHE_ENTRY } = await loader.import("../advice/postreply-cache.ts");
const { TASK_ASSISTANT_CHANNEL } = await loader.import("../advice/events.ts");

// Keep config and session writes isolated from the user's running session.
const temporary = mkdtempSync(join(tmpdir(), "pi-sidebar-cache-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = temporary;
const { default: timeline } = await loader.import("./index.ts");
if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
const { default: assistant } = await loader.import("../advice/index.ts");

test("disk resume preserves the advice pane with and without cache in either registration order, zero model requests", { timeout: 5000 }, async () => {
	try {
		const session = SessionManager.create(temporary, temporary);
		const user = session.appendMessage({ role: "user", content: "修复侧栏复制", timestamp: Date.now() });
		const reply = session.appendMessage({ role: "assistant", content: [{ type: "text", text: "修好了，请验收。" }],
			api: "openai-responses", provider: "fixture", model: "fixture", timestamp: Date.now(), stopReason: "stop",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		});
		session.appendCustomEntry("session-timeline", { v: 2, kind: "step", fromId: user, toId: reply, startedAt: Date.now(), endedAt: Date.now(),
			phase: { id: user, title: "侧栏修复", isNew: true }, intent: "修复复制", summary: "修复完成", now: "等待验收", status: "done", goal: "隔离侧栏复制",
			stats: emptyStats(), gen: { ok: true, model: "fixture", ms: 1 }, next: { steps: [{ text: "试试跨行复制", score: .96, confidence: .9 }], directions: ["完善侧栏交互"] },
		});
		const firstStep = session.getBranch().find((e: { customType?: string }) => e.customType === "session-timeline").data;
		// Force the previously missing predecessor case: it used to trigger a fresh Gemini request
		// on resume despite already having a completed latest prediction cache.
		const latestUser = session.appendMessage({ role: "user", content: "再检查一下布局", timestamp: Date.now() });
		const latestReply = session.appendMessage({ ...session.getEntry(reply).message, content: [{ type: "text", text: "布局也调整好了。" }] });
		session.appendCustomEntry("session-timeline", { ...firstStep, fromId: latestUser, toId: latestReply,
			phase: { id: latestUser, title: "布局检查", isNew: true }, gen: { ...firstStep.gen, gap: true },
		});
		const uncachedFile = join(temporary, "without-advice-cache.jsonl");
		writeFileSync(uncachedFile, readFileSync(session.getSessionFile()));
		let complete!: () => void;
		const saved = new Promise<void>((done) => { complete = done; });
		const producer = new PostReplyController({
			emit: (e: { type: string; status?: string }) => { if (e.type === "update" && e.status === "ready") complete(); },
			notify: (s: string) => assert.fail(s), persist: (cache: unknown) => session.appendCustomEntry(POSTREPLY_CACHE_ENTRY, cache),
		});
		producer.generate = async () => ({ kind: "ok", value: { directions: [], actions: [{ label: "确认界面布局", prompt: "确认界面布局。", evidence: "用户要求调整侧栏" }] } });
		producer.judge = async (items: unknown[]) => ({ kind: "ready", directions: [], actions: items });
		producer.kick({ sessionManager: session });
		await saved;
		const file = session.getSessionFile();
		assert.ok(readFileSync(file, "utf8").includes(POSTREPLY_CACHE_ENTRY));
		producer.abort("shutdown");
		for (const startup of [{ file, cached: true }, { file: uncachedFile, cached: false }]) {
		for (const order of [[timeline, assistant], [assistant, timeline]]) {
			const resumed = SessionManager.open(startup.file);
			let modelRequests = 0;
			let writes = 0;
			const bus = new EventEmitter();
			const events: unknown[] = [];
			bus.on(TASK_ASSISTANT_CHANNEL, (e) => events.push(e));
			const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
			let widget: { render(width: number): string[] } | undefined;
			const commands = new Map<string, { handler: (args: string, ctx: unknown) => unknown }>();
			const pi = {
				events: { on: (channel: string, fn: (...args: unknown[]) => void) => { bus.on(channel, fn); return () => bus.off(channel, fn); }, emit: (channel: string, e: unknown) => bus.emit(channel, e) },
				on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
				registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => commands.set(name, command), registerShortcut() {}, getCommands: () => [],
				appendEntry: (kind: string, data: unknown) => { writes++; resumed.appendCustomEntry(kind, data); },
			};
			const ctx = { mode: "tui", cwd: temporary, sessionManager: resumed, isIdle: () => true, hasPendingMessages: () => false,
				modelRegistry: { find: () => { modelRequests++; assert.fail("cache resume called a model"); } },
				ui: { notify: (s: string): void => assert.fail(s), setWidget: (_key: string, factory: unknown) => {
					if (typeof factory === "function") widget = factory({ mode: "regular", terminal: { columns: 160, rows: 40 }, requestRender() {} }, { fg: (_: string, s: string) => s });
				} },
			};
			for (const factory of order) factory(pi);
			for (const fn of handlers.get("session_start") ?? []) await fn({}, ctx);
			await new Promise<void>((done) => setImmediate(done));
			const rendered = widget!.render(160).join("\n");
			assert.match(rendered, /试试跨行复制/);
			assert.match(rendered, /96%/);
			assert.match(rendered, /完善侧栏交互/);
			assert.match(rendered, /回复后建议/);
			if (startup.cached) assert.match(rendered, /确认界面布局/);
			else {
				assert.match(rendered, /暂无缓存/);
				assert.doesNotMatch(rendered, /生成中|正在生成|无过线项|确认界面布局/);
			}
			assert.equal(modelRequests, 0);
			assert.equal(writes, 0, "unchanged resume should not append another cache");
			assert.equal(events.some((e) => (e as { status?: string }).status === "pending"), false);
			assert.equal(resumed.buildSessionContext().messages.some((m: { content?: unknown }) => JSON.stringify(m.content).includes("确认界面布局")), false, "UI cache must not become model context");
			// Explicit off/on must remain distinct from idle with no cache, even after a fresh sidebar hello.
			ctx.ui.notify = () => {};
			await commands.get("task-assistant")!.handler("off", ctx);
			pi.events.emit(TASK_ASSISTANT_CHANNEL, { type: "hello", version: 1, role: "sidebar" });
			assert.doesNotMatch(widget!.render(160).join("\n"), /回复后建议/);
			await commands.get("task-assistant")!.handler("on", ctx);
			assert.match(widget!.render(160).join("\n"), /回复后建议/);
			assert.equal(modelRequests, 0);
			for (const fn of handlers.get("session_shutdown") ?? []) await fn({}, ctx);
		}
		}
	} finally { rmSync(temporary, { recursive: true, force: true }); }
});

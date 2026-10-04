import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Exercise the installed renderer and Editor, not a reimplementation of selection.
const root = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
const require = createRequire(`${root}/package.json`);
const { createJiti } = require("jiti");
const loader = createJiti(import.meta.url, { fsCache: false, alias: {
	"@earendil-works/pi-tui": fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")),
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")),
} });
const { TuiAltScreen, Editor, HStack, ScrollView, VStack, visibleWidth, stripTerminalSequences } = await loader.import(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")));
const { renderLayoutFrame } = await loader.import(`${dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-tui")))}/layout.js`);
const { isolateColumnSelection } = await loader.import("./column-selection.ts");
const { TimelineSidebar, SplitHost } = await loader.import("./sidebar.ts");
const { buildView, emptyStats, parseSummary } = await loader.import("./core.ts");
const { parseGenerated } = await loader.import("../advice/postreply.ts");
const { adviceView, applyAdviceEvent, EMPTY_ADVICE_SLOT } = await loader.import("./assistant-owner.ts");

const input = ["第一行中文内容", "第二行 emoji🙂内容", "第三行目标"];
/** Inspect the terminal's reverse-video state on visible cells, not inherited boundary escapes. */
function invertedCells(line: string): number[] {
	const text = line.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b_pi:c\x07/g, "");
	let inverse = false;
	let column = 0;
	const cells: number[] = [];
	for (const token of text.matchAll(/\x1b\[[0-9;]*m|[^\x1b]/gu)) {
		if (token[0].startsWith("\x1b[")) {
			for (const code of token[0].slice(2, -1).split(";").map(Number)) {
				if (code === 0 || code === 27) inverse = false;
				if (code === 7) inverse = true;
			}
		} else {
			const width = visibleWidth(token[0]);
			for (let i = 0; i < width; i++) if (inverse) cells.push(column + i);
			column += width;
		}
	}
	return cells;
}
function fixture(enabled = true) {
	const terminal = { columns: 90, rows: 14, write: () => {} };
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	const style = (s: string) => `\x1b[36m${s}\x1b[39m`;
	const editor = new Editor(tui, { borderColor: style, selectList: {
		selectedPrefix: style, selectedText: style, description: style, scrollInfo: style, noMatch: style,
	} });
	editor.setText(input.join("\n"));
	const transcript = new ScrollView({ render: () => ["history one", "history two"], invalidate() {} }, { primary: true });
	const main = new VStack([
		{ component: transcript, basis: 0, grow: 1, minSize: 1 },
		{ component: new VStack([editor]), basis: "auto", minSize: 3 },
	]);
	const right = { render: () => Array.from({ length: terminal.rows }, (_, i) => style(`右栏独立内容 ${i}`)), invalidate() {} };
	let split = new HStack([{ component: main, basis: 60 }, { component: right, basis: 30 }]);
	const frame = () => {
		tui.layoutRoot = split;
		tui.currentLayout = renderLayoutFrame(split, terminal.columns, terminal.rows, () => {});
		tui.previousScreen = tui.currentLayout.lines;
	};
	frame();
	const firstY = tui.previousScreen.findIndex((s: string) => stripTerminalSequences(s).includes(input[0]));
	assert.ok(firstY >= 0);
	const restore = enabled ? isolateColumnSelection(tui, () => split) : () => {};
	const mouse = (x: number, y: number, button = 0, release = false) => tui.handleMouseEvent({ x, y, button, release });
	return { tui, terminal, editor, main, right, frame, firstY, mouse, restore,
		resize: (left: number) => {
			split = new HStack([{ component: main, basis: left }, { component: right, basis: 90 - left }]);
			frame();
		},
	};
}

test("installed renderer reproduces editor cross-line copy leaking sidebar before isolation", () => {
	const f = fixture(false);
	f.mouse(0, f.firstY);
	f.mouse(visibleWidth(input[2]) - 1, f.firstY + 2, 32);
	f.mouse(visibleWidth(input[2]) - 1, f.firstY + 2, 0, true);
	assert.match(f.tui.getActiveSelectionText(), /右栏独立内容/);
});

for (const reverse of [false, true]) {
	test(`editor drag ${reverse ? "upward" : "downward"}: CJK/emoji text and highlight stay in left column`, async () => {
		const f = fixture();
		let copied = "";
		f.tui.copySelection = async (text: string) => { copied = text; return true; };
		f.tui.setCopyOnSelect(true);
		try {
			const from = reverse ? [visibleWidth(input[2]) - 1, f.firstY + 2] : [0, f.firstY];
			const to = reverse ? [0, f.firstY] : [visibleWidth(input[2]) - 1, f.firstY + 2];
			f.mouse(from[0], from[1]);
			f.mouse(to[0], to[1], 32);
			f.mouse(to[0], to[1], 0, true);
			assert.equal(f.tui.getActiveSelectionText(), input.join("\n"));
			const highlighted = f.tui.applySelection(f.tui.previousScreen);
			for (let row = f.firstY; row <= f.firstY + 2; row++) {
				const cells = invertedCells(highlighted[row]);
				assert.ok(cells.length > 0, "selected editor text must be highlighted");
				assert.ok(cells.every((column) => column < 60), "no right-column cell may be highlighted");
			}
			assert.equal(copied, input.join("\n"), "release must automatically copy only the editor text");
			assert.equal(await f.tui.copyActiveSelectionToClipboard(), true);
			assert.equal(copied, input.join("\n"));
		} finally { f.restore(); }
	});
}

test("automatically wrapped editor text copies without sidebar content", () => {
	const f = fixture();
	try {
		// 60-column editor reserves one cursor cell, so CJK wraps after 29 characters.
		const long = "中文".repeat(23);
		f.editor.setText(long);
		f.frame();
		const row = f.tui.previousScreen.findIndex((line: string) => stripTerminalSequences(line).startsWith(long.slice(0, 29)));
		assert.ok(row >= 0);
		f.mouse(0, row);
		const end = visibleWidth(long.slice(29)) - 1;
		f.mouse(end, row + 1, 32);
		f.mouse(end, row + 1, 0, true);
		assert.equal(f.tui.getActiveSelectionText(), `${long.slice(0, 29)}\n${long.slice(29)}`);
	} finally { f.restore(); }
});

test("dragging from input into sidebar stays clamped to the initiating column", () => {
	const f = fixture();
	try {
		f.mouse(0, f.firstY);
		f.mouse(88, f.firstY + 2, 32);
		f.mouse(88, f.firstY + 2, 0, true);
		assert.equal(f.tui.selectionFocus.col, 59);
		assert.equal(f.tui.getActiveSelectionText(), input.join("\n"));
	} finally { f.restore(); }
});

test("sidebar free-text selection stays in the right column", () => {
	const f = fixture();
	try {
		f.mouse(60, f.firstY);
		f.mouse(2, f.firstY + 2, 32);
		f.mouse(2, f.firstY + 2, 0, true);
		const text = f.tui.getActiveSelectionText();
		assert.match(text, /右栏独立内容/);
		assert.doesNotMatch(text, /第一行|第二行|第三行/);
		assert.equal(f.tui.selectionFocus.col, 60);
	} finally { f.restore(); }
});

test("triple-click selects only the editor line; double-click keeps word selection", () => {
	const f = fixture();
	try {
		for (let i = 0; i < 3; i++) {
			f.mouse(3, f.firstY);
			f.mouse(3, f.firstY, 0, true);
			if (i === 1) {
				assert.equal(f.tui.selectionGranularity, "word");
				assert.doesNotMatch(f.tui.getActiveSelectionText(), /右栏/);
			}
		}
		assert.equal(f.tui.selectionGranularity, "line");
		assert.equal(f.tui.getActiveSelectionText(), input[0]);
	} finally { f.restore(); }
});

test("transcript keeps native ScrollView selection and a new press can switch columns", () => {
	const f = fixture();
	try {
		f.mouse(0, f.firstY);
		f.mouse(5, f.firstY + 1, 32);
		f.mouse(5, f.firstY + 1, 0, true);
		f.mouse(0, 0);
		f.mouse(10, 1, 32);
		f.mouse(10, 1, 0, true);
		assert.equal(f.tui.selectionAnchor.scrollView, f.tui.currentLayout.primaryScrollView);
		assert.equal(f.tui.selectionAnchor.columnScope, undefined);
		assert.equal(f.tui.getActiveSelectionText(), "history one\nhistory two");
		f.mouse(60, f.firstY);
		f.mouse(75, f.firstY + 1, 32);
		f.mouse(75, f.firstY + 1, 0, true);
		assert.match(f.tui.getActiveSelectionText(), /右栏/);
		assert.doesNotMatch(f.tui.getActiveSelectionText(), /第一行|第二行/);
	} finally { f.restore(); }
});

test("column bounds follow resize; overlays use native selection; restore is idempotent", () => {
	const f = fixture();
	const nativePoint = Object.getPrototypeOf(f.tui).getSelectionPoint;
	try {
		f.resize(64);
		f.mouse(0, f.firstY);
		f.mouse(88, f.firstY + 2, 32);
		f.mouse(88, f.firstY + 2, 0, true);
		assert.equal(f.tui.selectionFocus.col, 63);
		assert.doesNotMatch(f.tui.getActiveSelectionText(), /右栏/);
		const hasOverlay = f.tui.hasOverlay;
		f.tui.hasOverlay = () => true;
		assert.equal(f.tui.getSelectionPoint({ x: 88, y: 0, button: 0 }).columnScope, undefined);
		f.tui.hasOverlay = hasOverlay;
	} finally { f.restore(); f.restore(); }
	assert.equal(f.tui.getSelectionPoint, nativePoint);
	assert.equal(Object.hasOwn(f.tui, "getSelectionPoint"), false);
	assert.equal(f.tui.hasActiveSelection(), false);
});

test("unsupported runtime fails explicitly instead of claiming isolation", () => {
	assert.throws(() => isolateColumnSelection({}, () => undefined), /缺少 getSelectionPoint/);
});

test("fullscreen sidebar reserves the idle advice pane after startup without cache", () => {
	const slot = applyAdviceEvent(EMPTY_ADVICE_SLOT, { type: "hello", version: 1, role: "provider", enabled: true });
	const model = { view: () => buildView([]), config: () => ({ modules: {} }),
		busy: () => ({ summarizing: false, checking: new Set(), agent: false }), predictions: () => undefined,
		advice: () => adviceView(slot, false),
	};
	const sidebar = new TimelineSidebar({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_: string, s: string) => s, bold: (s: string) => s }, model);
	const rendered = sidebar.render(42).map(stripTerminalSequences).join("\n");
	assert.match(rendered, /回复后建议.*暂无缓存/);
	assert.match(rendered, /本轮回复结束后更新建议/);
	assert.doesNotMatch(rendered, /生成中|无过线项|没查出错/);
	assert.ok(sidebar.lowerRows > 0);
	assert.ok(sidebar.lowerRows <= 24 / 3);
});

test("sidebar prediction rows omit redundant labels but retain scores, directions and actions", () => {
	const model = { copy: async () => true };
	const sidebar = new TimelineSidebar({ requestRender() {} }, { fg: (_: string, s: string) => s }, model);
	const lines = sidebar.predictionLines({ pending: false,
		steps: [{ text: "验收侧栏界面", score: .96, confidence: .9 }], directions: ["检查复制隔离"],
	}, 60);
	const text = lines.map((line: { text: string }) => stripTerminalSequences(line.text)).join("\n");
	assert.match(text, /① 96% 验收侧栏界面/);
	assert.match(text, /预测下一步执行方向\n.*◇ 检查复制隔离/);
	assert.doesNotMatch(text, /下一句|· 下一|◇ 执行方向/);
	assert.equal(lines.find((line: { action?: string }) => line.action === "copy:验收侧栏界面")?.action, "copy:验收侧栏界面");
	for (const state of [{ pending: true }, { pending: false, error: "失效" }]) {
		const status = sidebar.predictionLines({ ...state, steps: [], directions: [] }, 60)[0].text;
		assert.match(stripTerminalSequences(status), state.pending ? /打分中/ : /未打分/);
	}
});

test("long predictions/directions/advice reflow after a real divider drag and copy complete text", async () => {
	const next = "请检查侧栏预测和方向在拖动宽度前后是否能够显示全部文字并复制出完整的结尾内容";
	const direction = "完善侧栏交互并验证宽度变化后预测方向回复建议以及依据都能够显示完整并可滚动查看全部内容";
	const label = "检查回复后建议的完整文字显示以及跨行复制并确认没有人工省略号";
	const prompt = `请检查${"侧栏显示和复制、".repeat(36)}确保完整的提示词结尾被填入输入框。`;
	const evidence = "用户要求拖动宽度以后能看到完整内容并且复制出的文字没有省略号，同时明确要求回复后建议只占底部三分之一";
	const summary = parseSummary(JSON.stringify({ continue_phase: false, phase_title: "侧栏显示", intent: "完整复制", result: "已调整", status: "done", goal: "完整显示", next: [next], directions: [direction] }));
	assert.notEqual(typeof summary, "string");
	const generated = parseGenerated(JSON.stringify({ directions: [], actions: [{ label, prompt, evidence }] }), false);
	assert.equal(generated.kind, "ok");
	const item = { ...generated.value.actions[0], id: "advice1", kind: "action" };
	const pred = { pending: false, steps: [{ text: summary.next[0], score: .96, confidence: .9 }], directions: summary.directions };
	const step = { v: 2, kind: "step", fromId: "u", toId: "a", startedAt: 1, endedAt: 2,
		phase: { id: "u", title: "侧栏显示", isNew: true }, intent: "完整复制", summary: "已调整", status: "done", goal: "完整显示",
		stats: emptyStats(), gen: { ok: true, model: "fixture", ms: 1 }, next: { steps: pred.steps, directions: pred.directions },
	};
	const view = buildView([
		{ type: "message", id: "u", message: { role: "user", content: "修复显示" } },
		{ type: "message", id: "a", message: { role: "assistant", content: "完成" } },
		{ type: "custom", customType: "session-timeline", data: step },
	]);
	const copied: string[] = [];
	const cfg = { enabled: true, width: 24, modules: { next: true } };
	const terminal = { columns: 160, rows: 40, write() {} };
	const tui = new TuiAltScreen(terminal, false, undefined, { copyOnSelect: false });
	const style = (s: string) => s;
	const editor = new Editor(tui, { borderColor: style, selectList: {
		selectedPrefix: style, selectedText: style, description: style, scrollInfo: style, noMatch: style,
	} });
	editor.setText("已有草稿🙂");
	tui.layoutRoot = editor;
	const model = {
		view: () => view, config: () => cfg,
		busy: () => ({ summarizing: false, checking: new Set(), agent: false }), predictions: () => pred,
		advice: () => ({ pending: false, steps: [], directions: [], items: [item] }),
		copy: async (text: string) => { copied.push(text); return true; },
		fillAdvice: () => assert.fail("click must never insert into the editor"),
		setWidth: (width: number) => { cfg.width = width; host.sync(); },
	};
	const host = new SplitHost(model, (s: string) => assert.fail(s));
	host.attach(tui, { fg: (_: string, s: string) => s, bold: (s: string) => s });
	const sidebar = host.sidebar;
	const render = () => {
		tui.currentLayout = renderLayoutFrame(tui.layoutRoot, terminal.columns, terminal.rows, () => {});
		tui.previousScreen = tui.currentLayout.lines;
		return tui.previousScreen;
	};
	try {
		render();
		const narrow = sidebar.predictionLines(pred, 22);
		assert.ok(narrow.filter((line: { action?: string }) => line.action === `copy:${next}`).length > 3);
		assert.doesNotMatch(narrow.map((line: { text: string }) => stripTerminalSequences(line.text)).join(""), /…/);
		assert.ok(sidebar.lowerRows < terminal.rows / 3 + 1);
		assert.equal(stripTerminalSequences(tui.previousScreen[sidebar.headerRows + sidebar.upperRows + sidebar.dividerRows]).includes("回复后建议"), true);
		const adviceRows = sidebar.adviceLines(model.advice(), 22);
		assert.ok(adviceRows.length > sidebar.lowerRows);
		assert.doesNotMatch(adviceRows.map((line: { text: string }) => line.text).join(""), /…/);
		// Every advice continuation remains reachable by the lower pane's wheel, with its heading pinned.
		let shown = "";
		for (let i = 0; i <= sidebar.maxAdviceScroll; i++) {
			const rows = render();
			const top = sidebar.headerRows + sidebar.upperRows + sidebar.dividerRows;
			shown += rows.slice(top, top + sidebar.lowerRows).map(stripTerminalSequences).join("\n");
			assert.ok(stripTerminalSequences(rows[top]).includes("回复后建议"));
			sidebar.handleMouse({ type: "wheel", y: top + 1, wheelDelta: 1 });
		}
		assert.ok(shown.includes(evidence.slice(-3)), "evidence tail must be scrollable, not replaced by a marker");
		// Drag the real installed renderer divider from 24 to 80 columns.
		tui.handleMouseEvent({ x: 136, y: 1, button: 0, release: false });
		tui.handleMouseEvent({ x: 80, y: 1, button: 32, release: false });
		tui.handleMouseEvent({ x: 80, y: 1, button: 0, release: true });
		assert.equal(cfg.width, 80);
		render();
		const wide = sidebar.predictionLines(pred, 78);
		assert.ok(wide.length < narrow.length, "drag must rewrap existing stored text");
		const completeText = (lines: { text: string; action?: string }[], text: string) => lines
			.filter((line) => line.action === `copy:${text}`)
			.map((line) => stripTerminalSequences(line.text).replace(/[^\p{Script=Han}]/gu, "")).join("");
		for (const text of [next, direction]) {
			assert.equal(completeText(narrow, text), text);
			assert.equal(completeText(wide, text), text);
		}
		for (const text of [next, direction]) {
			const row = sidebar.actions.indexOf(`copy:${text}`);
			assert.ok(row >= 0);
			tui.handleMouseEvent({ x: 85, y: row, button: 0, release: false });
			tui.handleMouseEvent({ x: 85, y: row, button: 0, release: true });
			await Promise.resolve();
			await Promise.resolve();
		}
		assert.deepEqual(copied, [next, direction]);
		const adviceRow = sidebar.actions.indexOf(`advice:${item.id}`);
		assert.ok(adviceRow >= 0);
		tui.handleMouseEvent({ x: 85, y: adviceRow, button: 0, release: false });
		tui.handleMouseEvent({ x: 85, y: adviceRow, button: 0, release: true });
		await Promise.resolve();
		await Promise.resolve();
		assert.deepEqual(copied, [next, direction, prompt]);
		assert.equal(editor.getText(), "已有草稿🙂");
		assert.doesNotMatch(copied.at(-1)!, /omitted|…/);
		const feedback = render().map(stripTerminalSequences).join("\n");
		assert.match(feedback, /回复后建议.*✓ 已复制/);
		assert.doesNotMatch(sidebar.predictionLines(pred, 78)[0].text, /已复制/);
		model.copy = async () => false;
		tui.handleMouseEvent({ x: 85, y: adviceRow, button: 0, release: false });
		tui.handleMouseEvent({ x: 85, y: adviceRow, button: 0, release: true });
		await Promise.resolve();
		await Promise.resolve();
		assert.match(render().map(stripTerminalSequences).join("\n"), /回复后建议.*复制失败/);
		assert.equal(editor.getText(), "已有草稿🙂");
		assert.ok(tui.previousScreen.every((line: string) => visibleWidth(line) <= terminal.columns));
	} finally { clearTimeout(sidebar.copiedTimer); host.dispose(); }
});

test("SplitHost hide/dispose restores selection methods and the original root", () => {
	const f = fixture(false);
	const config = { enabled: true, width: 30 };
	const host = new SplitHost({ config: () => config }, (reason: string) => assert.fail(reason));
	const original = f.tui.layoutRoot;
	const native = f.tui.getSelectionPoint;
	host.attach(f.tui, {});
	assert.notEqual(f.tui.getSelectionPoint, native);
	assert.notEqual(f.tui.layoutRoot, original);
	config.enabled = false;
	host.sync();
	assert.equal(f.tui.getSelectionPoint, native);
	assert.equal(f.tui.layoutRoot, original);
	config.enabled = true;
	host.sync();
	assert.notEqual(f.tui.getSelectionPoint, native);
	host.dispose();
	assert.equal(f.tui.getSelectionPoint, native);
	assert.equal(f.tui.layoutRoot, original);
});

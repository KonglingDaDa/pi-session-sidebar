/**
 * The sidebar: a plain component rendered as the right column of an HStack that replaces Pi's fullscreen
 * layout root (the approach pi-atelier uses, MIT). Pi's own root stays the left column, so the transcript,
 * editor and pi-open-tui's footer reflow into the remaining width instead of being covered.
 *
 * Layout (v2): a phase is a drawer (▾ / ▸); opened, its turns hang off it like files in a folder (├─ └─ │).
 * Predictions hang off the current phase as a separate dashed branch (╰┄ ├┄ └┄) drawn in bright purple.
 *
 * `layoutRoot` is a private pi-tui field (setLayoutRoot is public on ViewportTUI). Every access is guarded;
 * on any failure the host marks itself broken and the extension falls back to the below-editor widget.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	HStack,
	isViewportTUI,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ModuleName, NextStepV1, StepStatus, TimelineConfig, TimelineStep } from "./contracts.ts";
import { clampScroll, hitPane, splitRegions } from "./sidebar-layout.ts";
import { isolateColumnSelection } from "./column-selection.ts";
import {
	compactionProblems,
	formatClock,
	formatTokens,
	goalLine,
	JEV_UNSURE,
	scoreFlags,
	statsParts,
	type TimelineView,
	type Tone,
	type ViewCompaction,
	type ViewPhase,
	wrapText,
} from "./core.ts";

export const WIDTH_MIN = 24;
export const WIDTH_MAX = 80;
export const MAIN_MIN = 60;
export const WIDTH_STEP = 4;
/** Below this inner width the turns drop their clock column (the text column would get too narrow). */
const CLOCK_MIN_WIDTH = 34;
export { JEV_UNSURE };

export function clampWidth(w: number): number {
	return Math.max(WIDTH_MIN, Math.min(WIDTH_MAX, Math.round(Number.isFinite(w) ? w : 42)));
}

/** Lower pane: goal-closure checklist. The top pane predicts the next message; this one asks what is
 * still between here and the user's original goal. Never merge the two. */
export interface Predictions {
	/** Top 3 next-message texts, highest score first. */
	steps: NextStepV1[];
	/** Broader next execution directions (not the next typed message). */
	directions: string[];
	/** Jev is still scoring them, or advice is still generating. */
	pending: boolean;
	/** Scoring/generation failed. */
	error?: string;
	/** task-assistant = lower advice pane; omitted for original predictions. */
	source?: "timeline" | "task-assistant";
	/** Full prompt copied by clicking a lower-pane item. */
	items?: { id: string; kind: "direction" | "action"; label: string; prompt: string; evidence?: string }[];
	/** Well-formed none: show an explicit empty row. */
	empty?: boolean;
	/** Provider is enabled, but this reply has no completed cache/job yet. */
	idle?: boolean;
}

export interface SidebarModel {
	view(): TimelineView;
	config(): TimelineConfig;
	busy(): { summarizing: boolean; checking: Set<string>; backfill?: { done: number; total: number }; agent: boolean };
	predictions(): Predictions | undefined;
	advice(): Predictions | undefined;
	/** persist=false while dragging; true when the drag ends. */
	setWidth(width: number, persist: boolean): void;
	/** Copy prediction or advice text to the system clipboard; false when no path worked. */
	copy(text: string): Promise<boolean>;
}

/** How long "已复制" stays next to a clicked prediction. */
const COPIED_MS = 2000;

const STATUS: Record<StepStatus, { icon: string; label: string; color: "success" | "accent" | "warning" | "error" }> = {
	done: { icon: "✓", label: "完成", color: "success" },
	in_progress: { icon: "▶", label: "进行中", color: "accent" },
	waiting_user: { icon: "?", label: "等你回话", color: "warning" }, // not ◆: that marks decisions under a turn
	blocked: { icon: "✗", label: "卡住", color: "error" },
};

/** "What you wanted" vs "→ what came of it": brightness plus hue, so the two lines read apart at a glance. */
const INTENT_COLOR = "text" as const;
const RESULT_COLOR = "mdLink" as const;
/** "◆ what got decided" under a turn: the marker in the accent colour, the text in the default colour. */
const DECISION_MARK = "◆";

/** Bright purple (256-colour 171, #d75fff): prediction branches only. */
export function purple(text: string): string {
	return `\x1b[38;5;171m${text}\x1b[39m`;
}

export const CIRCLED = ["①", "②", "③"];

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const dayKey = (ms: number) => new Date(ms).toDateString();

/** "今天" / "昨天" / "9月25日 周四" for a day separator. */
export function dayLabel(ms: number, now = Date.now()): string {
	if (dayKey(ms) === dayKey(now)) return "今天";
	if (dayKey(ms) === dayKey(now - 86_400_000)) return "昨天";
	const d = new Date(ms);
	return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
}

interface Line {
	text: string;
	action?: string;
}

export class TimelineSidebar implements Component {
	private scroll = 0;
	private readonly toggled = new Set<string>();
	private actions: (string | undefined)[] = [];
	private dragging = false;
	private lastWidth = 0;
	private maxScroll = 0;
	/** Wheeling down past the newest line lifts it off the bottom edge, by up to this many rows (scroll < 0). */
	private overscroll = 0;
	private adviceScroll = 0;
	private maxAdviceScroll = 0;
	private headerRows = 0;
	private upperRows = 0;
	private dividerRows = 0;
	private lowerRows = 0;
	/** The prediction just clicked (its text) and whether the copy worked, until the timer clears it. */
	private copied?: { text: string; ok: boolean; source: "prediction" | "advice" };
	private copiedTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly model: SidebarModel,
	) {}

	invalidate(): void {}

	private tone(t: Tone, text: string): string {
		if (t === "warn") return this.theme.fg("warning", text);
		if (t === "bad") return this.theme.fg("error", text);
		if (t === "ok") return this.theme.fg("success", text);
		if (t === "add") return this.theme.fg("toolDiffAdded", text);
		return this.theme.fg("dim", text);
	}

	private line(text: string): string {
		return this.theme.fg("borderMuted", text);
	}

	private small(parts: { text: string; tone: Tone }[], indent: string, width: number): Line[] {
		if (!parts.length) return [];
		const sep = this.theme.fg("dim", " · ");
		return this.wrap(parts.map((p) => this.tone(p.tone, p.text)).join(sep), width, indent, indent);
	}

	/** Wrap styled text into lines of `width`, with a first-line prefix and a hanging indent. */
	private wrap(text: string, width: number, first: string, rest: string, maxLines = 99): Line[] {
		const room = Math.max(4, width - Math.max(visibleWidth(first), visibleWidth(rest)));
		const wrapped = wrapTextWithAnsi(text, room);
		const out = wrapped.slice(0, maxLines).map((l, i) => ({ text: `${i === 0 ? first : rest}${l}` }));
		if (wrapped.length > maxLines && out.length) {
			const last = out[out.length - 1];
			last.text = `${truncateToWidth(last.text, Math.max(1, width - 1), "")}…`;
		}
		return out;
	}

	/** Wrap one run of plain text in one style (CJK-aware, no line starting with closing punctuation). */
	private wrapPlain(text: string, style: (s: string) => string, width: number, first: string, rest: string, maxLines = 99): Line[] {
		const room = Math.max(4, width - Math.max(visibleWidth(first), visibleWidth(rest)));
		const wrapped = wrapText(text, room, visibleWidth);
		const shown = wrapped.slice(0, maxLines);
		if (wrapped.length > maxLines && shown.length) shown[shown.length - 1] = `${truncateToWidth(shown[shown.length - 1], room - 1, "")}…`;
		return shown.map((l, i) => ({ text: `${i === 0 ? first : rest}${style(l)}` }));
	}

	private phaseKey(item: ViewPhase, index: number): string {
		return `${item.id}@${index}`;
	}

	/**
	 * One turn hanging off its phase. After the clock everything shares one text column, so wrapped lines line up:
	 * the first line is what you wanted (bright), `→ …` is what came of it (blue), `◆ …` what got decided;
	 * a warning (off-intent / not done) sits flush right only when Jev is sure something is wrong.
	 */
	private stepLines(s: TimelineStep, width: number, branch: string, stem: string, modules: Record<ModuleName, boolean>): Line[] {
		const th = this.theme;
		const clock = modules.time && width >= CLOCK_MIN_WIDTH ? `${formatClock(s.startedAt)} ` : "";
		const first = `${branch}${th.fg("dim", clock)}`;
		const rest = `${stem}${" ".repeat(visibleWidth(clock))}`;
		const intentStyle = (t: string) => th.fg(s.gen.ok ? INTENT_COLOR : "warning", t);
		const lines = this.wrapPlain(`${s.intent}${s.gen.partial ? "（进行中）" : ""}`, intentStyle, width, first, rest, 3);
		const intentEnd = lines.length;
		if (s.summary) {
			const result = (t: string) => th.fg(RESULT_COLOR, t);
			lines.push(...this.wrapPlain(s.summary, result, width, `${rest}${result("→ ")}`, `${rest}  `, 3));
		}
		for (const d of s.decisions ?? []) lines.push(...this.wrapPlain(d, (t) => t, width, `${rest}${th.fg("accent", DECISION_MARK)} `, `${rest}  `, 2));
		// The warning belongs to the whole turn: on the intent line when there is room.
		this.appendRight(lines, this.turnTag(s, modules), width, rest, intentEnd - 1);
		if (!s.gen.ok) lines.push(...this.wrapPlain(`⚠ 摘要失败：${s.gen.error ?? "未知错误"}`, (t) => th.fg("warning", t), width, rest, rest, 2));
		lines.push(...this.small(statsParts(s.stats, modules), rest, width));
		return lines;
	}

	/** Right-hand tag of a turn: only what Jev is sure is wrong (the numbers stay in the record and /timeline status). */
	private turnTag(s: TimelineStep, modules: Record<ModuleName, boolean>): string {
		if (!modules.score) return "";
		const f = scoreFlags(s.score);
		const bits: string[] = [];
		if (f.offIntent) bits.push(this.theme.fg("warning", "⚠偏题"));
		if (f.notDone) bits.push(this.theme.fg("error", "⚠没做完"));
		return bits.join(" ");
	}

	/** Put `tag` flush right on line `prefer` (default the last) when it fits there, else the last line, else a line of its own. */
	private appendRight(lines: Line[], tag: string, width: number, rest: string, prefer = lines.length - 1): void {
		if (!tag) return;
		const w = visibleWidth(tag);
		for (const i of new Set([prefer, lines.length - 1])) {
			const line = lines[i];
			if (line && visibleWidth(line.text) + 1 + w <= width) {
				line.text = `${line.text}${" ".repeat(width - visibleWidth(line.text) - w)}${tag}`;
				return;
			}
		}
		lines.push({ text: `${rest}${" ".repeat(Math.max(0, width - visibleWidth(rest) - w))}${tag}` });
	}

	/** The dashed purple prediction branch under the current phase (next message + execution directions). */
	private predictionLines(p: Predictions, width: number): Line[] {
		const th = this.theme;
		const state = p.pending ? " · 打分中…" : p.error ? " · 未打分" : "";
		const copyables = [...p.steps.map((s) => s.text), ...p.directions];
		const hit = this.copied?.source === "prediction" && copyables.includes(this.copied.text) ? this.copied : undefined;
		const note = hit ? (hit.ok ? th.fg("success", " · ✓ 已复制") : th.fg("warning", " · 复制失败")) : th.fg("dim", state);
		const lines: Line[] = [{ text: truncateToWidth(`${purple("╰┄")} ${purple("预测下一步")}${note}`, width, "") }];
		const items: { lead: string; text: string; copy: string }[] = p.steps.map((s, i) => {
			const unsure = typeof s.confidence === "number" && s.confidence < JEV_UNSURE;
			const pct = typeof s.score === "number" ? `${Math.round(s.score * 100)}%${unsure ? "?" : ""}` : "";
			const styled = pct ? ` ${unsure ? th.fg("dim", pct) : purple(pct)}` : "";
			return { lead: `${purple(CIRCLED[i] ?? "·")}${styled} `, text: s.text, copy: s.text };
		});
		if (p.error && !items.length && !p.directions.length) {
			lines.push(...this.wrapPlain(p.error, (t) => th.fg("warning", t), width, `   ${purple("└┄")} `, "      ", 2));
		}
		if (p.pending && !items.length && !p.directions.length) {
			lines.push({ text: truncateToWidth(`   ${purple("└┄")} ${th.fg("dim", "正在打分")}`, width, "") });
		}
		items.forEach((it, i) => {
			const last = i === items.length - 1 && !p.directions.length;
			const first = `   ${purple(last ? "└┄" : "├┄")} ${it.lead}`;
			const rest = `   ${last ? "  " : purple("┆ ")} ${" ".repeat(visibleWidth(it.lead))}`;
			const style = (t: string) => (this.copied?.source === "prediction" && this.copied.ok && this.copied.text === it.copy ? th.fg("success", t) : t);
			lines.push(...this.wrapPlain(it.text, style, width, first, rest, Infinity).map((l) => ({ ...l, action: `copy:${it.copy}` })));
		});
		if (p.directions.length) {
			lines.push({ text: truncateToWidth(`${purple("╰┄")} ${purple("预测下一步执行方向")}`, width, "") });
			p.directions.forEach((d, i) => {
				const last = i === p.directions.length - 1;
				const first = `   ${purple(last ? "└┄" : "├┄")} ${purple("◇")} `;
				const rest = `   ${last ? "  " : purple("┆ ")}   `;
				const style = (t: string) => (this.copied?.source === "prediction" && this.copied.ok && this.copied.text === d ? th.fg("success", t) : t);
				lines.push(...this.wrapPlain(d, style, width, first, rest, Infinity).map((l) => ({ ...l, action: `copy:${d}` })));
			});
		}
		return lines;
	}

	/** Lower pane: goal-closure advice. Click copies the full prompt; alt+1~3 stay on predictions. */
	private adviceLines(p: Predictions, width: number): Line[] {
		const th = this.theme;
		const state = p.idle ? " · 暂无缓存" : p.pending ? " · 生成中…" : p.error ? " · 未判定" : p.empty || !(p.items?.length) ? " · 无过线项" : " · 点选复制";
		const hit = this.copied?.source === "advice" && p.items?.some((s) => s.prompt === this.copied!.text) ? this.copied : undefined;
		const note = hit ? th.fg(hit.ok ? "success" : "warning", hit.ok ? " · ✓ 已复制" : " · 复制失败") : th.fg("dim", state);
		const lines: Line[] = [{ text: truncateToWidth(`${th.fg("accent", "回复后建议")}${note}`, width, "") }];
		if (p.idle) {
			lines.push(...this.wrapPlain("本轮回复结束后更新建议", (t) => th.fg("dim", t), width, "  ", "  ", Infinity));
		} else if (p.error && !(p.items?.length)) {
			lines.push(...this.wrapPlain(p.error, (t) => th.fg("warning", t), width, "  ", "  ", 2));
		} else if (p.empty && !(p.items?.length) && !p.error) {
			lines.push({ text: truncateToWidth(`  ${th.fg("dim", "没查出错——不是预测失败")}`, width, "") });
		} else if (p.pending && !(p.items?.length)) {
			lines.push({ text: truncateToWidth(`  ${th.fg("dim", "正在生成建议")}`, width, "") });
		}
		for (const s of p.items ?? []) {
			const tag = s.kind === "direction" ? th.fg("dim", "目标方向") : th.fg("dim", "建议动作");
			const first = `  ${tag} `;
			const rest = `  ${" ".repeat(visibleWidth(tag) + 1)}`;
			const style = (t: string) => hit?.ok && hit.text === s.prompt ? th.fg("success", t) : t;
			lines.push(...this.wrapPlain(s.label, style, width, first, rest, Infinity).map((l) => ({ ...l, action: `advice:${s.id}` })));
			// "What this rests on": the one line that makes a wrong item obvious at a glance.
			if (s.evidence) {
				const lead = `  ${th.fg("dim", "└ 依据")} `;
				lines.push(...this.wrapPlain(s.evidence, (t) => th.fg("dim", t), width, lead, "     ", Infinity));
			}
		}
		return lines;
	}

	private phaseLines(
		item: ViewPhase,
		index: number,
		isLast: boolean,
		width: number,
		modules: Record<ModuleName, boolean>,
		pred: Predictions | undefined,
	): Line[] {
		const th = this.theme;
		const st = STATUS[item.status];
		const key = this.phaseKey(item, index);
		const open = isLast ? !this.toggled.has(key) : this.toggled.has(key);
		// Open: the turns below carry the times. Closed: the phase shows when it started.
		const clock = modules.time && !open ? `${formatClock(item.startedAt)} ` : "";
		const first = `${th.fg("dim", open ? "▾" : "▸")}${th.fg(st.color, st.icon)} ${th.fg("dim", clock)}`;
		const rest = " ".repeat(3 + visibleWidth(clock));
		const warn = item.failed ? th.fg("warning", "⚠") : "";
		const title = `${item.title}${item.continued ? "（续）" : ""}`;
		const lines: Line[] = this.wrapPlain(title, (t) => th.bold(t), width, first, rest, 2).map((l) => ({ ...l, action: `toggle:${key}` }));
		if (open) {
			this.appendRight(lines, warn, width, rest);
			item.steps.forEach((s, i) => {
				const lastChild = i === item.steps.length - 1 && !pred;
				const branch = this.line(lastChild ? "└─ " : "├─ ");
				const stem = lastChild ? "   " : this.line("│  ");
				lines.push(...this.stepLines(s, width, branch, stem, modules));
			});
		} else {
			// No percentage here: a phase has no completion score of its own. A ⚠ says a turn inside needs a look.
			const flagged = modules.score && item.steps.some((s) => {
				const f = scoreFlags(s.score);
				return f.offIntent || f.notDone;
			});
			const mark = warn || (flagged ? th.fg("warning", "⚠") : "");
			const tag = [mark, th.fg("dim", `${item.steps.length}轮`)].filter(Boolean).join(" ");
			this.appendRight(lines, tag, width, rest);
			lines.push(...this.small(statsParts(item.stats, modules), pred ? `${this.line("│")}  ` : "   ", width));
		}
		if (pred) lines.push(...this.predictionLines(pred, width));
		return lines;
	}

	/**
	 * A compaction is one line while its check finds nothing wrong ("方向一致" when Jev is sure, "没发现问题" when it is
	 * not); only a problem opens it up into before / after goals and the warnings.
	 */
	private compactionLines(item: ViewCompaction, width: number, checking: boolean): Line[] {
		const th = this.theme;
		const c = item.check;
		const problems = compactionProblems(c);
		let verdict: string;
		if (problems.length) verdict = th.fg("warning", "⚠ 有问题");
		else if (c?.jev) verdict = c.jev.confidence >= JEV_UNSURE ? th.fg("success", "方向一致") : th.fg("dim", "没发现问题");
		else if (c?.error) verdict = th.fg("warning", "⚠ 没检查成");
		else verdict = th.fg("dim", checking ? "检查中…" : "未检查");
		const head = `${th.fg("accent", "⟲")} ${th.fg("dim", formatClock(item.at))} ${th.fg("accent", `压缩 ${formatTokens(item.tokensBefore)}`)} ${th.fg("dim", "·")} ${verdict}`;
		const lines: Line[] = [{ text: `${th.fg("borderMuted", "┄")}${head} ${th.fg("borderMuted", "┄".repeat(Math.max(0, width - visibleWidth(head) - 2)))}` }];
		if (c?.error && !c.jev) lines.push(...this.wrapPlain(c.error, (t) => th.fg("dim", t), width, "  ", "  ", 1));
		if (!problems.length) return lines;
		if (c?.preGoal) lines.push(...this.wrapPlain(c.preGoal, (t) => t, width, `  ${th.fg("dim", "前")} `, "     ", 2));
		// Pi writes the summary in English: show Gemini's Chinese one-liner; until it comes, one dim line of the original.
		if (c?.postBrief) lines.push(...this.wrapPlain(c.postBrief, (t) => t, width, `  ${th.fg("dim", "后")} `, "     ", 3));
		else if (c?.postGoal) lines.push(...this.wrapPlain(goalLine(c.postGoal), (t) => th.fg("dim", t), width, `  ${th.fg("dim", "后")} `, "     ", 1));
		for (const p of problems) lines.push(...this.wrapPlain(p, (t) => th.fg("warning", t), width, `  ${th.fg("warning", "⚠")} `, "     ", 3));
		return lines;
	}

	render(width: number): string[] {
		this.lastWidth = width;
		const th = this.theme;
		const rows = Math.max(1, this.tui.terminal.rows);
		const view = this.model.view();
		const cfg = this.model.config();
		const modules = cfg.modules;
		const busy = this.model.busy();
		const pred = modules.next ? this.model.predictions() : undefined;
		const advice = this.model.advice();
		const inner = Math.max(4, width - 2);

		// ---- header
		const header: Line[] = [];
		const progress = busy.backfill ? th.fg("warning", ` · 回填中 ${busy.backfill.done}/${busy.backfill.total}`) : "";
		const working = busy.summarizing && !busy.backfill ? th.fg("warning", " · 总结中…") : "";
		header.push({ text: `${th.bold(th.fg("accent", "时间线"))}${th.fg("dim", ` · ${view.steps}轮`)}${progress}${working}` });
		if (modules.goal && view.goal) header.push(...this.wrapPlain(view.goal, (t) => t, inner, `${th.fg("dim", "目标")} `, "     ", 2));
		// "现在": where the whole session stands (Gemini's `now` of the latest turn), not the latest turn's own status.
		const nowLabel = `${th.fg("dim", "现在")} `;
		if (busy.agent) header.push({ text: truncateToWidth(`${nowLabel}${th.fg("accent", "▶ AI 正在做这一轮…")}`, inner, "") });
		else if (view.lastStep?.now) {
			// No status icon here: the latest turn's own status (often ✓) would contradict "still waiting on …".
			header.push(...this.wrapPlain(view.lastStep.now, (t) => t, inner, nowLabel, "     ", 2));
		} else if (view.lastStep && modules.hints) {
			header.push({ text: truncateToWidth(`${nowLabel}${th.fg("dim", "（旧记录没有这一项，/timeline redo 重跑）")}`, inner, "") });
		}
		if (modules.hints && view.steps) {
			header.push({ text: truncateToWidth(`${th.fg(INTENT_COLOR, "你要什么")} ${th.fg(RESULT_COLOR, "→ 结果")} ${th.fg("accent", DECISION_MARK)} ${th.fg("dim", "拍板")}`, inner, "") });
		}
		header.push({ text: th.fg("borderMuted", "─".repeat(inner)) });

		// ---- body: predictions hang off the phase holding the latest turn
		const body: Line[] = [];
		const lastPhaseIndex = view.items.map((i) => i.kind).lastIndexOf("phase");
		const latestFrom = view.lastStep?.fromId;
		let predIndex = -1;
		view.items.forEach((item, i) => {
			if (item.kind === "phase" && latestFrom && item.steps.some((s) => s.fromId === latestFrom)) predIndex = i;
		});
		// Collapsed one-line phases stack tightly; anything taller gets a blank line around it.
		// When the session spans several days, a dim date line opens each day (the clocks alone would be ambiguous).
		const startOf = (item: (typeof view.items)[number]) => (item.kind === "phase" ? item.startedAt : item.at);
		// Only count items that will actually render (hidden compaction must not force a date line alone).
		const shown = view.items.filter((item) => item.kind !== "compaction" || modules.compaction);
		const multiDay = modules.time && new Set(shown.map(startOf).filter((t) => t > 0).map(dayKey)).size > 1;
		let lastDay = "";
		let prevTall = false;
		view.items.forEach((item, index) => {
			if (item.kind === "compaction" && !modules.compaction) return;
			const chunk =
				item.kind === "phase"
					? this.phaseLines(item, index, index === lastPhaseIndex, inner, modules, index === predIndex ? pred : undefined)
					: this.compactionLines(item, inner, busy.checking.has(item.entryId));
			const tall = chunk.length > 1 || item.kind === "compaction";
			const t = startOf(item);
			if (multiDay && t > 0 && dayKey(t) !== lastDay) {
				lastDay = dayKey(t);
				if (body.length) body.push({ text: "" });
				const label = `── ${dayLabel(t)} `;
				body.push({ text: th.fg("dim", `${label}${"─".repeat(Math.max(0, inner - visibleWidth(label)))}`) });
			} else if (body.length && (tall || prevTall)) body.push({ text: "" });
			body.push(...chunk);
			prevTall = tall;
		});
		if (!body.length) {
			const empty = busy.summarizing || busy.backfill ? "正在总结…" : "每轮对话结束后，这里会多一条摘要。";
			body.push(...this.wrap(th.fg("dim", empty), inner, "", ""));
		}

		// ---- footer
		const hint = pred?.steps.length || pred?.directions.length || advice
			? "点预测复制 · alt+1~3 填预测 · 点建议复制· alt+,/. 调宽 · alt+s 关"
			: "alt+, alt+. 调宽 · 拖左边线 · alt+s 关";
		const footer: Line[] = modules.hints ? [{ text: th.fg("dim", truncateToWidth(hint, inner, "")) }] : [];

		const adviceBody = advice ? this.adviceLines(advice, inner) : [];
		const split = splitRegions(rows, header.length, footer.length, Boolean(advice));
		this.headerRows = header.length;
		this.upperRows = split.upper;
		this.dividerRows = split.divider;
		this.lowerRows = split.lower;

		this.maxScroll = Math.max(0, body.length - split.upper);
		this.overscroll = body.length >= split.upper ? Math.floor(split.upper / 2) : 0;
		this.scroll = clampScroll(this.scroll, body.length, split.upper, this.overscroll);
		const end = body.length - this.scroll;
		const start = Math.max(0, end - split.upper);
		const visible = body.slice(start, Math.min(end, body.length));
		if (start > 0 && visible.length) visible[0] = { text: th.fg("dim", `↑ 还有 ${start} 行（滚轮）`) };
		if (this.scroll > 0 && visible.length) visible[visible.length - 1] = { text: th.fg("accent", `↓ 还有 ${this.scroll} 行 · 点这里回到最新`), action: "bottom" };
		while (visible.length < split.upper) visible.push({ text: "" });

		const divider: Line[] = split.divider ? [{ text: th.fg("borderMuted", "┄".repeat(inner)) }] : [];
		// Advice starts at its first item. Keep its heading visible while scrolling all wrapped rows.
		const adviceContent = adviceBody.slice(1);
		const adviceHeight = Math.max(0, split.lower - 1);
		this.maxAdviceScroll = Math.max(0, adviceContent.length - adviceHeight);
		this.adviceScroll = Math.max(0, Math.min(this.maxAdviceScroll, this.adviceScroll));
		const adviceVisible: Line[] = [];
		if (split.lower && adviceBody.length) {
			const above = this.adviceScroll > 0 ? "↑ " : "";
			const below = this.adviceScroll < this.maxAdviceScroll ? " ↓ 滚轮查看更多" : "";
			const heading = this.maxAdviceScroll
				? { text: truncateToWidth(`${adviceBody[0].text} ${th.fg("dim", `${above}${below.trim()}`)}`, inner, "") }
				: adviceBody[0];
			adviceVisible.push(heading, ...adviceContent.slice(this.adviceScroll, this.adviceScroll + adviceHeight));
			while (adviceVisible.length < split.lower) adviceVisible.push({ text: "" });
		}

		const all = [...header, ...visible, ...divider, ...adviceVisible, ...footer].slice(0, rows);
		this.actions = all.map((l) => l.action);
		const bar = this.dragging ? th.fg("accent", "┃") : th.fg("borderMuted", "│");
		return all.map((l) => truncateToWidth(`${bar} ${l.text}`, width, ""));
	}

	private copyText(text: string, source: "prediction" | "advice"): void {
		void this.model.copy(text).then((ok) => {
			this.copied = { text, ok, source };
			if (this.copiedTimer) clearTimeout(this.copiedTimer);
			this.copiedTimer = setTimeout(() => {
				this.copied = undefined;
				this.tui.requestRender();
			}, COPIED_MS);
			this.copiedTimer.unref?.();
			this.tui.requestRender();
		});
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? 0;
			const pane = hitPane(event.y, this.headerRows, this.upperRows, this.dividerRows, this.lowerRows);
			if (pane === "lower") {
				this.adviceScroll = Math.max(0, Math.min(this.maxAdviceScroll, this.adviceScroll + delta));
			} else {
				this.scroll = Math.max(-this.overscroll, Math.min(this.maxScroll, this.scroll - delta));
			}
			return { handled: true };
		}
		if (this.dragging) {
			if (event.type === "drag" || event.type === "move") {
				this.model.setWidth(clampWidth(event.screenX >= 0 ? this.tui.terminal.columns - event.screenX : this.lastWidth), false);
				return { handled: true, render: true };
			}
			if (event.type === "release") {
				this.dragging = false;
				this.model.setWidth(this.model.config().width, true);
				return { handled: true, render: true };
			}
			return { handled: true };
		}
		if (event.type === "press" && event.button === "left") {
			if (event.x <= 1) {
				this.dragging = true;
				return { capture: true, render: true };
			}
			if (this.actions[event.y]) return { handled: true };
			return undefined;
		}
		if (event.type === "click" && event.button === "left") {
			const action = this.actions[event.y];
			if (!action) return undefined;
			if (action === "bottom") this.scroll = 0;
			else if (action.startsWith("copy:")) this.copyText(action.slice("copy:".length), "prediction");
			else if (action.startsWith("advice:")) {
				const item = this.model.advice()?.items?.find((s) => s.id === action.slice("advice:".length));
				if (item) this.copyText(item.prompt, "advice");
			}
			else if (action.startsWith("toggle:")) {
				const key = action.slice("toggle:".length);
				if (this.toggled.has(key)) this.toggled.delete(key);
				else this.toggled.add(key);
			}
			return { handled: true, render: true };
		}
		return undefined;
	}
}

type LayoutTui = TUI & { layoutRoot?: Component; setLayoutRoot?: (c: Component | undefined) => void };

/** Owns the HStack split: wraps Pi's fullscreen root when shown, restores it when hidden or disposed. */
export class SplitHost {
	private tui?: LayoutTui;
	private sidebar?: TimelineSidebar;
	private original?: Component;
	private split?: Component;
	private splitWidth = 0;
	private scheduled = false;
	private restoreSelection?: () => void;
	broken?: string;

	constructor(
		private readonly model: SidebarModel,
		private readonly onBroken: (reason: string) => void,
	) {}

	attach(tui: TUI, theme: Theme): void {
		if (this.tui && this.tui !== tui) this.restore();
		this.tui = tui as LayoutTui;
		this.sidebar = new TimelineSidebar(tui, theme, this.model);
		this.splitWidth = 0; // force sync() to remount with the new sidebar (theme may have changed)
		this.sync();
	}

	/** Fullscreen renderer with a usable layout-root API. */
	canSplit(): boolean {
		const tui = this.tui;
		if (!tui || this.broken) return false;
		try {
			return tui.mode === "fullscreen" && isViewportTUI(tui) && typeof tui.setLayoutRoot === "function" && "layoutRoot" in tui;
		} catch {
			return false;
		}
	}

	/** Split is mounted and the terminal is wide enough for it to show. */
	isShowing(): boolean {
		const tui = this.tui;
		return !!tui && !!this.split && tui.layoutRoot === this.split && tui.terminal.columns >= MAIN_MIN + WIDTH_MIN;
	}

	/** The sidebar is (or is about to be) visible: fullscreen split available, switched on, terminal wide enough. */
	wouldShow(): boolean {
		const tui = this.tui;
		return !!tui && this.model.config().enabled && this.canSplit() && tui.terminal.columns >= MAIN_MIN + WIDTH_MIN;
	}

	private fail(error: unknown): void {
		this.broken = error instanceof Error ? error.message : String(error);
		this.restore();
		this.onBroken(this.broken);
	}

	/** Called from the anchor widget's render: re-wrap if Pi swapped the root (e.g. a TUI mode switch). */
	checkRoot(): void {
		if (this.scheduled || !this.canSplit() || !this.model.config().enabled) return;
		if (this.tui?.layoutRoot === this.split && this.splitWidth === this.model.config().width) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			this.sync();
		});
	}

	sync(): void {
		const tui = this.tui;
		const sidebar = this.sidebar;
		if (!tui || !sidebar) return;
		if (!this.model.config().enabled || !this.canSplit()) {
			this.restore();
			return;
		}
		try {
			const root = tui.layoutRoot;
			if (!root) return; // not mounted yet; the anchor render will call again
			const width = this.model.config().width;
			if (root === this.split && this.splitWidth === width) return;
			const original = root === this.split ? this.original : root;
			if (!original) return;
			this.original = original;
			this.split = new HStack([
				{ component: original, basis: 0, grow: 1, shrink: 0, minSize: MAIN_MIN },
				{
					component: sidebar,
					basis: width,
					grow: 0,
					shrink: 1,
					minSize: WIDTH_MIN,
					visible: (viewport) => viewport.width >= MAIN_MIN + WIDTH_MIN,
				},
			]);
			this.splitWidth = width;
			this.restoreSelection ??= isolateColumnSelection(tui, () => this.split);
			tui.setLayoutRoot?.(this.split);
		} catch (error) {
			this.fail(error);
		}
	}

	restore(): void {
		const tui = this.tui;
		this.restoreSelection?.();
		this.restoreSelection = undefined;
		try {
			if (tui && this.split && tui.layoutRoot === this.split) tui.setLayoutRoot?.(this.original);
		} catch {
			// Nothing else to do: Pi rebuilt its renderer already.
		}
		this.split = undefined;
		this.splitWidth = 0;
	}

	requestRender(): void {
		try {
			this.tui?.requestRender();
		} catch {
			// Renderer gone (shutdown).
		}
	}

	dispose(): void {
		this.restore();
		this.tui = undefined;
		this.sidebar = undefined;
		this.original = undefined;
	}
}

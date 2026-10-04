import type { Component } from "@earendil-works/pi-tui";
import { sliceByColumn } from "@earendil-works/pi-tui";

interface ColumnScope {
	component: Component;
	min: number;
	max: number;
}
interface SelectionPoint {
	row: number;
	col: number;
	scrollView?: unknown;
	boundary?: boolean;
	columnScope?: ColumnScope;
}
interface SelectionBounds { start: SelectionPoint; end: SelectionPoint }
interface RawMouse { x: number; y: number; button: number; release?: boolean }
interface LayoutBox {
	component: Component;
	rect: { x: number; width: number };
	clip: { x: number; width: number };
	children: LayoutBox[];
}
interface SelectionHost {
	layoutRoot?: Component;
	currentLayout?: { root: LayoutBox };
	selectionAnchor?: SelectionPoint;
	getSelectionPoint(event: RawMouse, scrollView?: unknown): SelectionPoint;
	getSelectionSourceLine(point: SelectionPoint): string;
	getSelectionColumns(line: string, row: number, bounds: SelectionBounds, min?: number, max?: number): { start: number; end: number };
	hasOverlay(): boolean;
	clearTextSelection(): void;
}

/** Pi already scopes transcript selection to its ScrollView, but dock/editor selection falls back
 * to full-screen rows. Adapt that fallback to the rendered HStack column, for BOTH highlight and
 * clipboard extraction. No layout/focus/input replacement and no changes to the installed runtime.
 * These renderer methods are private: check them before mounting and restore them on hide/reload. */
export function isolateColumnSelection(host: unknown, splitRoot: () => Component | undefined): () => void {
	const tui = host as SelectionHost;
	const keys = ["getSelectionPoint", "getSelectionSourceLine", "getSelectionColumns", "hasOverlay", "clearTextSelection"] as const;
	for (const key of keys) {
		if (typeof tui[key] !== "function") throw new Error(`当前 Pi 不支持侧栏选区隔离：缺少 ${key}`);
	}
	const point = tui.getSelectionPoint;
	const source = tui.getSelectionSourceLine;
	const columns = tui.getSelectionColumns;
	const pointOwn = Object.getOwnPropertyDescriptor(tui, "getSelectionPoint");
	const sourceOwn = Object.getOwnPropertyDescriptor(tui, "getSelectionSourceLine");
	const columnsOwn = Object.getOwnPropertyDescriptor(tui, "getSelectionColumns");

	const scopes = (): ColumnScope[] => {
		const root = splitRoot();
		const layout = tui.currentLayout?.root;
		if (!root || tui.layoutRoot !== root || layout?.component !== root || tui.hasOverlay()) return [];
		return layout.children.map((box) => ({
			component: box.component,
			min: Math.max(box.rect.x, box.clip.x),
			max: Math.min(box.rect.x + box.rect.width, box.clip.x + box.clip.width),
		})).filter((scope) => scope.max > scope.min);
	};
	const current = (scope?: ColumnScope): ColumnScope | undefined =>
		scope && scopes().find((candidate) => candidate.component === scope.component);

	tui.getSelectionPoint = function (event, scrollView) {
		const result = point.call(this, event, scrollView);
		if (result.scrollView) return result;
		const freshPress = !event.release && (event.button & 32) === 0;
		// On drag/release keep the column where the selection began, even across its border.
		const scope = freshPress
			? scopes().find((s) => event.x >= s.min && event.x < s.max)
			: current(this.selectionAnchor?.columnScope);
		return scope ? { ...result, col: Math.max(scope.min, Math.min(scope.max - 1, result.col)), columnScope: scope } : result;
	};
	tui.getSelectionSourceLine = function (selectionPoint) {
		const line = source.call(this, selectionPoint);
		const scope = current(selectionPoint.columnScope);
		// Keep absolute screen columns for word/line selection; exclude the neighbouring pane.
		return scope ? " ".repeat(scope.min) + sliceByColumn(line, scope.min, scope.max - scope.min, true) : line;
	};
	tui.getSelectionColumns = function (line, row, bounds, min, max) {
		const scope = current(bounds.start.columnScope);
		return scope
			? columns.call(this, line, row, bounds, Math.max(min ?? 0, scope.min), Math.min(max ?? Infinity, scope.max))
			: columns.call(this, line, row, bounds, min, max);
	};
	const patchedPoint = tui.getSelectionPoint;
	const patchedSource = tui.getSelectionSourceLine;
	const patchedColumns = tui.getSelectionColumns;
	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		if (tui.selectionAnchor?.columnScope) tui.clearTextSelection();
		if (tui.getSelectionPoint === patchedPoint) {
			if (pointOwn) Object.defineProperty(tui, "getSelectionPoint", pointOwn);
			else Reflect.deleteProperty(tui, "getSelectionPoint");
		}
		if (tui.getSelectionSourceLine === patchedSource) {
			if (sourceOwn) Object.defineProperty(tui, "getSelectionSourceLine", sourceOwn);
			else Reflect.deleteProperty(tui, "getSelectionSourceLine");
		}
		if (tui.getSelectionColumns === patchedColumns) {
			if (columnsOwn) Object.defineProperty(tui, "getSelectionColumns", columnsOwn);
			else Reflect.deleteProperty(tui, "getSelectionColumns");
		}
	};
}

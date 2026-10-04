/** Pure layout for the timeline/prediction upper pane and the advice lower pane. */

export type SidebarSplit = {
	upper: number;
	lower: number;
	divider: number;
};

/**
 * Reserve roughly one third of the body for advice; the timeline keeps the rest.
 * Content length must not move the divider; short advice is padded in the pane.
 */
export function splitRegions(rows: number, header: number, footer: number, hasAdvicePane: boolean): SidebarSplit {
	const chrome = Math.max(0, header) + Math.max(0, footer);
	const avail = Math.max(1, Math.max(1, rows) - chrome);
	if (!hasAdvicePane) return { upper: avail, lower: 0, divider: 0 };
	if (avail < 3) return { upper: avail, lower: 0, divider: 0 };
	const divider = 1;
	const room = avail - divider;
	const lower = Math.min(room - 1, Math.max(2, Math.floor(room / 3)));
	return { upper: room - lower, lower, divider };
}

export function clampScroll(scroll: number, content: number, height: number, overscroll: number): number {
	const maxScroll = Math.max(0, content - Math.max(1, height));
	const over = content >= height ? Math.max(0, overscroll) : 0;
	return Math.max(-over, Math.min(scroll, maxScroll));
}

export function hitPane(y: number, header: number, upper: number, divider: number, lower: number): "upper" | "lower" | "chrome" {
	if (y < header) return "chrome";
	if (y < header + upper) return "upper";
	if (divider && y < header + upper + divider) return "chrome";
	if (lower && y < header + upper + divider + lower) return "lower";
	return "chrome";
}

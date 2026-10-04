import assert from "node:assert/strict";
import { test } from "node:test";
import { clampScroll, hitPane, splitRegions } from "./sidebar-layout.ts";

test("splitRegions: no advice uses the full body", () => {
	assert.deepEqual(splitRegions(24, 5, 1, false), { upper: 18, lower: 0, divider: 0 });
});

test("splitRegions: advice keeps a stable lower third, independent of content length", () => {
	const short = splitRegions(24, 5, 1, true);
	const long = splitRegions(24, 5, 1, true);
	assert.deepEqual(short, long);
	assert.equal(short.divider, 1);
	assert.equal(short.upper + short.lower + short.divider, 18);
	assert.deepEqual(short, { upper: 12, lower: 5, divider: 1 });
});

test("splitRegions: 36-row sidebar gives advice about a third of the body", () => {
	const s = splitRegions(36, 6, 1, true);
	assert.equal(s.upper + s.lower + s.divider, 29);
	assert.deepEqual(s, { upper: 19, lower: 9, divider: 1 });
});

test("splitRegions: tiny height still splits without dropping upper", () => {
	const s = splitRegions(8, 3, 1, true);
	assert.equal(s.upper + s.lower + s.divider, 4);
	assert.ok(s.upper >= 1);
	assert.ok(s.lower >= 1);
});

test("splitRegions: short terminals never allocate more body rows than available", () => {
	for (let rows = 1; rows <= 12; rows++) {
		const s = splitRegions(rows, 0, 0, true);
		assert.equal(s.upper + s.lower + s.divider, rows);
		assert.ok(s.upper >= 1);
	}
});

test("hitPane maps y after resize independently of content", () => {
	assert.equal(hitPane(5, 4, 8, 1, 6), "upper");
	assert.equal(hitPane(12, 4, 8, 1, 6), "chrome");
	assert.equal(hitPane(14, 4, 8, 1, 6), "lower");
	assert.equal(hitPane(0, 4, 8, 1, 6), "chrome");
	assert.equal(hitPane(5, 4, 18, 0, 0), "upper");
});

test("clampScroll pins to newest and allows limited overscroll", () => {
	assert.equal(clampScroll(99, 10, 20, 10), 0);
	assert.equal(clampScroll(99, 30, 10, 5), 20);
	assert.equal(clampScroll(-99, 30, 10, 5), -5);
});

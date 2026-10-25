import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectUnits, lastPageNeeded, runs, unitPages, type PageSide, type Raster } from './crop-layout.ts';

const W = 1000;
const H = 1400;

function blankPage(): Raster {
	return { width: W, height: H, gray: new Uint8Array(W * H).fill(252) };
}

function fill(page: Raster, x0: number, y0: number, x1: number, y1: number, value = 20) {
	for (let y = y0; y < y1; y++) page.gray.fill(value, y * W + x0, y * W + x1);
}

/** A synthetic unit: rule, checkbox + number + text lines, then the side's panel. */
function drawUnit(page: Raster, top: number, side: PageSide) {
	fill(page, 100, top, 900, top + 2, 180); // faint rule
	const textLeft = side === 'Q' ? 200 : 160;
	if (side === 'Q') fill(page, 20, top + 10, 80, top + 70); // unit badge
	for (let line = 0; line < 4; line++) {
		const y = top + 20 + line * 40;
		fill(page, textLeft - 90, y, textLeft - 70, y + 20); // checkbox
		fill(page, textLeft - 50, y, textLeft - 30, y + 20); // number
		for (let x = textLeft; x < 850; x += 60) fill(page, x, y, x + 52, y + 20); // words
	}
	const panelTop = top + 230;
	if (side === 'Q') {
		fill(page, 110, panelTop, 890, panelTop + 2);
		fill(page, 110, panelTop + 150, 890, panelTop + 152);
		fill(page, 110, panelTop, 112, panelTop + 152);
		fill(page, 888, panelTop, 890, panelTop + 152);
		fill(page, 150, panelTop + 40, 400, panelTop + 60);
	} else {
		fill(page, 90, panelTop - 30, 250, panelTop - 10); // ANSWERS label
		fill(page, 80, panelTop, 900, panelTop + 150, 210); // gray panel
		fill(page, 100, panelTop + 40, 400, panelTop + 60);
	}
}

function syntheticPage(side: PageSide): Raster {
	const page = blankPage();
	drawUnit(page, 100, side);
	drawUnit(page, 700, side);
	return page;
}

const margin = Math.round(W * 0.006);
// Rectangles are rounded to 4 decimals.
const near = (actual: number, expected: number) =>
	assert.ok(Math.abs(actual - expected) <= 0.0001, `${actual} != ${expected}`);

test('units map to question and answer pages from the first unit page', () => {
	assert.deepEqual(unitPages(1, 54), { q: 54, a: 55, lower: false });
	assert.deepEqual(unitPages(2, 54), { q: 54, a: 55, lower: true });
	assert.deepEqual(unitPages(3, 54), { q: 56, a: 57, lower: false });
	assert.deepEqual(unitPages(232, 54), { q: 284, a: 285, lower: true });
	assert.equal(lastPageNeeded(54), 285);
});

test('runs bridge small gaps', () => {
	assert.deepEqual(runs([0, 1, 1, 0, 0, 1, 0, 1]), [[1, 2], [5, 5], [7, 7]]);
	assert.deepEqual(runs([1, 0, 1, 0, 0, 1], 1), [[0, 2], [5, 5]]);
});

test('question text starts after the checkbox and number, and the box is found', () => {
	const [upper, lower] = detectUnits(syntheticPage('Q'), 'Q');
	for (const [unit, top] of [[upper, 100], [lower, 700]] as const) {
		near(unit.text[0], (200 - margin) / W);
		near(unit.text[1], (top + 20 - margin) / H);
		near(unit.panel[0], (110 - margin) / W);
		near(unit.panel[1], (top + 230 - margin) / H);
	}
});

test('answer text skips the number column and the panel includes the ANSWERS label', () => {
	const [upper, lower] = detectUnits(syntheticPage('A'), 'A');
	for (const [unit, top] of [[upper, 100], [lower, 700]] as const) {
		near(unit.text[0], (160 - margin) / W);
		near(unit.panel[1], (top + 200 - margin) / H);
		near(unit.panel[0], (80 - margin) / W);
	}
});

test('a page without the expected panels is rejected', () => {
	assert.throws(() => detectUnits(blankPage(), 'Q'), /expected 2 panels/);
	assert.throws(() => detectUnits(blankPage(), 'A'), /expected 2 panels/);
});

// Finds the two rectangles of each unit on a scanned page of the book.
// Mirrors scripts/detect-crops.py, which was used to validate it on every page of the book.

import { unitCount } from './catalog.ts';

/** x, y, width, height as fractions of the page. */
export type Rect = [number, number, number, number];
export type UnitCrop = { text: Rect; panel: Rect };
export type PageSide = 'Q' | 'A';

/** One channel per pixel: the darkest of R, G and B. */
export type Raster = { width: number; height: number; gray: Uint8Array };

const ink = 150; // printed ink (black or pink)
const paper = 240; // a row whose middle has a median below this is the gray ANSWERS panel

/** Pages (1-based) holding a unit, and whether it is the upper or lower unit on them. */
export function unitPages(unit: number, firstPage: number) {
	const q = firstPage + 2 * Math.floor((unit - 1) / 2);
	return { q, a: q + 1, lower: unit % 2 === 0 };
}

export function lastPageNeeded(firstPage: number): number {
	return unitPages(unitCount, firstPage).a;
}

/** Shown instead when detection fails: the whole half of the page the unit is on. */
export function halfPage(lower: boolean): Rect {
	return lower ? [0, 0.48, 1, 0.5] : [0, 0.02, 1, 0.5];
}

export function toRaster(rgba: Uint8ClampedArray, width: number, height: number): Raster {
	const gray = new Uint8Array(width * height);
	for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
		gray[i] = Math.min(rgba[p], rgba[p + 1], rgba[p + 2]);
	}
	return { width, height, gray };
}

type Range = [number, number];

/** [start, end] index ranges of true values, bridging gaps of at most `close`. */
export function runs(mask: ArrayLike<boolean | number>, close = 0): Range[] {
	const out: Range[] = [];
	for (let i = 0; i < mask.length; i++) {
		if (!mask[i]) continue;
		const last = out.at(-1);
		if (last && i - last[1] <= close + 1) last[1] = i;
		else out.push([i, i]);
	}
	return out;
}

/** Median of 8-bit values, as numpy computes it (mean of the middle pair for even counts). */
function median(histogram: Uint32Array, count: number): number {
	const lowRank = Math.floor((count - 1) / 2);
	const highRank = Math.floor(count / 2);
	let low = -1;
	for (let value = 0, seen = 0; value < 256; value++) {
		seen += histogram[value];
		if (low < 0 && seen > lowRank) low = value;
		if (seen > highRank) return (low + value) / 2;
	}
	return 255;
}

function argmax(values: Float64Array, from: number, to: number): number {
	let best = from;
	for (let i = from; i < to; i++) if (values[i] > values[best]) best = i;
	return best;
}

class Page {
	readonly w: number;
	readonly h: number;
	readonly gray: Uint8Array;
	readonly ink: Uint8Array;
	/** Ink without the long horizontal rules between units. */
	readonly textInk: Uint8Array;

	constructor({ width, height, gray }: Raster) {
		this.w = width;
		this.h = height;
		this.gray = gray;
		this.ink = new Uint8Array(gray.length);
		for (let i = 0; i < gray.length; i++) this.ink[i] = gray[i] < ink ? 1 : 0;

		// Rules are long horizontal lines (often faint and tilted); text never is.
		const lineRows = new Uint8Array(height);
		for (let y = 0; y < height; y++) {
			let best = 0;
			for (let x = 0, run = 0, i = y * width; x < width; x++, i++) {
				run = gray[i] < 200 ? run + 1 : 0;
				if (run > best) best = run;
			}
			lineRows[y] = best > width * 0.25 ? 1 : 0;
		}
		this.textInk = this.ink.slice();
		for (let y = 0; y < height; y++) {
			let near = false;
			for (let d = -2; d <= 2; d++) near ||= lineRows[y + d] === 1;
			if (near) this.textInk.fill(0, y * width, (y + 1) * width);
		}
	}

	rowsWithInk(mask: Uint8Array, top: number, bottom: number, left = 0): boolean[] {
		const out: boolean[] = [];
		for (let y = top; y < bottom; y++) out.push(mask.subarray(y * this.w + left, (y + 1) * this.w).includes(1));
		return out;
	}

	findPanels(side: PageSide): Range[] {
		const { w, h, gray, ink } = this;
		if (side === 'A') {
			const from = Math.floor(w * 0.2);
			const to = Math.floor(w * 0.8);
			const histogram = new Uint32Array(256);
			const grayRows: boolean[] = [];
			for (let y = 0; y < h; y++) {
				histogram.fill(0);
				for (let x = from; x < to; x++) histogram[gray[y * w + x]]++;
				grayRows.push(median(histogram, to - from) < paper);
			}
			return runs(grayRows, 6).filter(([s, e]) => e - s > h * 0.05);
		}
		const panels: Range[] = [];
		for (const [start, end] of runs(this.rowsWithInk(ink, 0, h), 2)) {
			if (end - start < h * 0.05) continue;
			// The vocabulary box has left and right borders: a column on each side is inked on nearly
			// every row. Columns are widened by a few pixels so a slightly tilted border still counts.
			const coverage = new Float64Array(w);
			for (let y = start; y <= end; y++) {
				const row = ink.subarray(y * w, (y + 1) * w);
				for (let x = 0; x < w; x++) {
					for (let k = 0; k <= 6 && x + k < w; k++) {
						if (row[x + k]) {
							coverage[x]++;
							break;
						}
					}
				}
			}
			const rows = end - start + 1;
			const left = coverage[argmax(coverage, 0, Math.floor(w * 0.3))] / rows;
			const right = coverage[argmax(coverage, Math.floor(w * 0.7), w)] / rows;
			if (left > 0.8 && right > 0.8) panels.push([start, end]);
		}
		return panels;
	}

	panelColumns(side: PageSide, top: number, bottom: number): Range {
		const { w, gray, ink } = this;
		if (side === 'A') {
			// The run of gray columns through the page centre (scan shadows at the edge are separate).
			const histogram = new Uint32Array(256);
			const grayColumns: boolean[] = [];
			for (let x = 0; x < w; x++) {
				histogram.fill(0);
				for (let y = top; y <= bottom; y++) histogram[gray[y * w + x]]++;
				grayColumns.push(median(histogram, bottom - top + 1) < paper);
			}
			const centre = Math.floor(w / 2);
			const run = runs(grayColumns, 3).find(([a, b]) => a <= centre && centre <= b);
			if (!run) throw new Error('ANSWERS panel columns not found');
			return run;
		}
		// From the left border to the right border (stray marks in the margin are ignored).
		const coverage = new Float64Array(w);
		for (let y = top; y <= bottom; y++) for (let x = 0; x < w; x++) coverage[x] += ink[y * w + x];
		return [argmax(coverage, 0, Math.floor(w * 0.3)), argmax(coverage, Math.floor(w * 0.7), w)];
	}

	rect(x0: number, y0: number, x1: number, y1: number, extraRight = 0): Rect {
		const { w, h } = this;
		const margin = Math.round(w * 0.006);
		x0 = Math.max(0, x0 - margin);
		y0 = Math.max(0, y0 - margin);
		x1 = Math.min(w, x1 + margin + extraRight + 1);
		y1 = Math.min(h, y1 + margin + 1);
		const round = (value: number) => Math.round(value * 10000) / 10000;
		return [round(x0 / w), round(y0 / h), round((x1 - x0) / w), round((y1 - y0) / h)];
	}
}

/** Detects the upper and lower unit on a page, or throws when the layout is not recognised. */
export function detectUnits(raster: Raster, side: PageSide): [UnitCrop, UnitCrop] {
	const page = new Page(raster);
	const { w, h, textInk } = page;
	const panels = page.findPanels(side);
	if (panels.length !== 2) throw new Error(`expected 2 panels, found ${panels.length}`);

	const units: UnitCrop[] = [];
	let floor = 0;
	for (const [panelStart, panelBottom] of panels) {
		let panelTop = panelStart;
		const [panelLeft, panelRight] = page.panelColumns(side, panelTop, panelBottom);
		if (side === 'A') {
			// The ANSWERS label sits just above the gray panel.
			const label = runs(page.rowsWithInk(textInk, floor, panelTop), 2).at(-1);
			if (!label || panelTop - (floor + label[1]) > h * 0.02) throw new Error('ANSWERS label not found');
			panelTop = floor + label[0];
		}

		// Sentence lines: the chain of text rows directly above the panel with small gaps.
		const bands = runs(page.rowsWithInk(textInk, floor, panelTop), 3).filter(([s, e]) => e - s >= 12);
		if (!bands.length) throw new Error('no sentence rows');
		const chain = [bands[bands.length - 1]];
		for (let i = bands.length - 2; i >= 0; i--) {
			if (chain[0][0] - bands[i][1] > h * 0.025) break;
			chain.unshift(bands[i]);
		}
		const blockTop = floor + chain[0][0];
		const blockBottom = floor + chain[chain.length - 1][1];

		// Columns: [unit badge (Q)], checkbox, number, then the wide sentence text.
		const columnInk = new Float64Array(w);
		for (let y = blockTop; y <= blockBottom; y++) {
			for (let x = 0; x < w; x++) columnInk[x] += textInk[y * w + x];
		}
		const columns = runs(
			Array.from(columnInk, (count) => count > 1),
			10
		).filter(([s, e]) => e - s >= 3);
		const text = columns.find(([s, e]) => e - s > w * 0.15);
		if (!text) throw new Error('sentence text column not found');
		const textLeft = text[0];
		const textRight = columns[columns.length - 1][1];
		// Rows of the text column only, so the unit badge does not stretch the rectangle.
		const rows = runs(page.rowsWithInk(textInk, blockTop, blockBottom + 1, textLeft), 3).filter(
			([s, e]) => e - s >= 12
		);
		if (!rows.length) throw new Error('no sentence rows');

		units.push({
			// Faint glyph edges (e.g. a full-width "。") reach past the last inked column.
			text: page.rect(
				textLeft,
				blockTop + rows[0][0],
				textRight,
				blockTop + rows[rows.length - 1][1],
				Math.round(w * 0.012)
			),
			panel: page.rect(panelLeft, panelTop, panelRight, panelBottom)
		});
		floor = panelBottom + 1;
	}
	return [units[0], units[1]];
}

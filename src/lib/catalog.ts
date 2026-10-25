export const unitCount = 232;

export type Side = 'Q' | 'A';
/** The sentences, and the CHECK YOUR VOCABULARY box (Q) or the ANSWERS panel (A). */
export type Part = 'text' | 'panel';

/** The page number (1-based) of Unit 1 in the scanned book. */
export const defaultFirstPage = 54;

/** The imported PDF and its settings, kept next to the cropped images. */
export const bookFilename = 'book.pdf';
export const bookSettingsFilename = 'book.json';

export type BookSettings = { firstPage: number; fallbackUnits: number[] };

export const units: readonly number[] = Array.from({ length: unitCount }, (_, index) => index + 1);

export function isUnit(value: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= unitCount;
}

export function imageFilename(unit: number, side: Side, part: Part): string {
	return `unit${String(unit).padStart(3, '0')}_${side}_${part}.jpg`;
}

/** Every unit has at least the text image of both sides (the panel is missing when detection failed). */
export const requiredFilenames: readonly string[] = units.flatMap((unit) => [
	imageFilename(unit, 'Q', 'text'),
	imageFilename(unit, 'A', 'text')
]);

/** Images imported by earlier versions from ZIPs or folders (whole, uncropped unit images). */
export function isLegacyImage(name: string): boolean {
	return /^unit\d{3}_[QA]\.jpg$/.test(name);
}

/** Collapses unit numbers into readable ranges such as "1–3, 7". */
export function formatUnitRanges(values: readonly number[]): string {
	const sorted = [...new Set(values)].sort((a, b) => a - b);
	const ranges: string[] = [];
	for (let index = 0; index < sorted.length; ) {
		let end = index;
		while (end + 1 < sorted.length && sorted[end + 1] === sorted[end] + 1) end++;
		ranges.push(end === index ? `${sorted[index]}` : `${sorted[index]}–${sorted[end]}`);
		index = end + 1;
	}
	return ranges.join(', ');
}

/** Parses a location hash such as "#12" or "#12a". */
export function parseLocation(hash: string): { unit: number; side: Side } | null {
	const match = /^#?(\d{1,3})([QA])?$/i.exec(hash);
	if (!match || !isUnit(Number(match[1]))) return null;
	return { unit: Number(match[1]), side: (match[2]?.toUpperCase() as Side | undefined) ?? 'Q' };
}

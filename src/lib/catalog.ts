export const unitCount = 232;

export type Side = 'Q' | 'A';

export const units: readonly number[] = Array.from({ length: unitCount }, (_, index) => index + 1);

export function isUnit(value: number): boolean {
	return Number.isInteger(value) && value >= 1 && value <= unitCount;
}

export function imageFilename(unit: number, side: Side): string {
	return `unit${String(unit).padStart(3, '0')}_${side}.jpg`;
}

export const expectedFilenames: readonly string[] = units.flatMap((unit) => [
	imageFilename(unit, 'Q'),
	imageFilename(unit, 'A')
]);

/** Returns the catalog filename for an archive entry, or null when the entry is not a unit image. */
export function archiveImageName(path: string): string | null {
	const segments = path.split(/[/\\]/);
	if (segments.some((segment) => segment === '__MACOSX' || segment.startsWith('._'))) return null;
	const match = /^unit(\d{1,3})_([QA])\.jpe?g$/i.exec(segments.at(-1) ?? '');
	if (!match) return null;
	const unit = Number(match[1]);
	return isUnit(unit) ? imageFilename(unit, match[2].toUpperCase() as Side) : null;
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

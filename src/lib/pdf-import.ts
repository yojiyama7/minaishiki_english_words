import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { imageFilename, unitCount, type Part, type Side } from './catalog.ts';
import { detectUnits, halfPage, lastPageNeeded, toRaster, type Rect, type UnitCrop } from './crop-layout.ts';

GlobalWorkerOptions.workerSrc = workerUrl;

/** Pages are rendered about as wide as the scan itself, so crops keep its full resolution. */
const renderWidth = 1420;

export async function openPdf(file: Blob): Promise<PDFDocumentProxy> {
	return getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
}

export async function renderPage(pdf: PDFDocumentProxy, pageNumber: number, width = renderWidth) {
	const page = await pdf.getPage(pageNumber);
	const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
	const canvas = document.createElement('canvas');
	canvas.width = Math.round(viewport.width);
	canvas.height = Math.round(viewport.height);
	// The print intent renders without requestAnimationFrame, which stalls while the page is not
	// being painted (a background tab, or a hidden preview).
	await page.render({ canvas, viewport, intent: 'print' }).promise;
	page.cleanup();
	return canvas;
}

function cropToFile(canvas: HTMLCanvasElement, rect: Rect, name: string): Promise<File> {
	const [x, y, w, h] = rect;
	const crop = document.createElement('canvas');
	crop.width = Math.max(1, Math.round(w * canvas.width));
	crop.height = Math.max(1, Math.round(h * canvas.height));
	crop.getContext('2d')!.drawImage(
		canvas,
		Math.round(x * canvas.width),
		Math.round(y * canvas.height),
		crop.width,
		crop.height,
		0,
		0,
		crop.width,
		crop.height
	);
	return new Promise((resolve, reject) =>
		crop.toBlob(
			(blob) => (blob ? resolve(new File([blob], name, { type: 'image/jpeg' })) : reject(new Error('画像を作成できませんでした。'))),
			'image/jpeg',
			0.9
		)
	);
}

export type CroppedUnits = { files: File[]; fallbackUnits: number[] };

/**
 * Renders the question and answer page of every unit pair and crops each unit into its text and
 * panel images. Units whose layout is not recognised get their half page as the text image.
 */
export async function cropBook(
	pdf: PDFDocumentProxy,
	firstPage: number,
	onPair: (cropped: CroppedUnits, done: number, total: number) => Promise<void>
): Promise<void> {
	const lastPage = lastPageNeeded(firstPage);
	if (firstPage < 1 || pdf.numPages < lastPage) {
		throw new Error(
			`Unit 1 を ${firstPage} ページとすると ${lastPage} ページまで必要ですが、このPDFは ${pdf.numPages} ページです。`
		);
	}
	const pairs = unitCount / 2;
	for (let pair = 0; pair < pairs; pair++) {
		const files: File[] = [];
		const fallbackUnits = new Set<number>();
		for (const [side, offset] of [['Q', 0], ['A', 1]] as const) {
			const canvas = await renderPage(pdf, firstPage + pair * 2 + offset);
			const context = canvas.getContext('2d', { willReadFrequently: true })!;
			const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
			let crops: (UnitCrop | null)[];
			try {
				crops = detectUnits(toRaster(data, canvas.width, canvas.height), side);
			} catch {
				crops = [null, null];
			}
			for (const [index, crop] of crops.entries()) {
				const unit = pair * 2 + index + 1;
				const parts: [Part, Rect][] = crop
					? [['text', crop.text], ['panel', crop.panel]]
					: [['text', halfPage(index === 1)]];
				if (!crop) fallbackUnits.add(unit);
				for (const [part, rect] of parts) {
					files.push(await cropToFile(canvas, rect, imageFilename(unit, side as Side, part)));
				}
			}
			canvas.width = canvas.height = 0;
		}
		await onPair({ files, fallbackUnits: [...fallbackUnits] }, pair + 1, pairs);
	}
}

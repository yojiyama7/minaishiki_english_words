import { unzipSync } from 'fflate';
import { archiveImageName } from './catalog.ts';

async function unpack(input: Uint8Array<ArrayBuffer>): Promise<Record<string, Uint8Array>> {
	// Keep decompression off the browser UI thread. Node tests use the same decoder directly.
	if (typeof Worker === 'undefined') {
		return unzipSync(input, { filter: (entry) => archiveImageName(entry.name) !== null });
	}
	const worker = new Worker(new URL('./zip-worker.ts', import.meta.url), { type: 'module' });
	try {
		return await new Promise((resolve, reject) => {
			worker.onmessage = (event) => {
				if (event.data.error) reject(new Error(event.data.error));
				else resolve(event.data.entries);
			};
			worker.onerror = () => reject(new Error('ZIPの解凍処理を実行できませんでした。'));
			worker.postMessage({ input }, [input.buffer]);
		});
	} finally {
		worker.terminate();
	}
}

/** Extracts the unit images of one archive, keyed by catalog filename. */
export async function extractUnitImages(archive: Blob): Promise<File[]> {
	const entries = await unpack(new Uint8Array(await archive.arrayBuffer()));
	const images = new Map<string, File>();
	for (const [path, bytes] of Object.entries(entries)) {
		const name = archiveImageName(path)!;
		if (images.has(name)) throw new Error(`同じUnitの画像が複数あります: ${name}`);
		images.set(name, new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' }));
	}
	return [...images.values()];
}

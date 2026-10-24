import { unzipSync } from 'fflate';
import { archiveImageName } from './catalog.ts';

self.onmessage = (event: MessageEvent<{ input: Uint8Array }>) => {
	try {
		const entries = unzipSync(event.data.input, {
			filter: (entry) => archiveImageName(entry.name) !== null
		});
		self.postMessage(
			{ entries },
			{ transfer: Object.values(entries).map((bytes) => bytes.buffer as ArrayBuffer) }
		);
	} catch (error) {
		self.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
};

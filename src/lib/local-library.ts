// Unit images live only in this browser's origin-private file system (OPFS).
const imagesDirectoryName = 'unit-images';

async function getImagesDirectory(create = false): Promise<FileSystemDirectoryHandle | null> {
	const root = await navigator.storage.getDirectory();
	return root.getDirectoryHandle(imagesDirectoryName, { create }).catch((error) => {
		if (error instanceof DOMException && error.name === 'NotFoundError') return null;
		throw error;
	});
}

/** Names of the images that have been fully written. */
export async function listStoredImages(): Promise<Set<string>> {
	const directory = await getImagesDirectory();
	const names = new Set<string>();
	if (!directory) return names;
	for await (const [name, handle] of directory.entries()) {
		if (handle.kind === 'file' && (await (handle as FileSystemFileHandle).getFile()).size > 0) {
			names.add(name);
		}
	}
	return names;
}

export async function storeImages(files: readonly File[], onStored: (name: string) => void) {
	const directory = (await getImagesDirectory(true))!;
	for (const file of files) {
		const handle = await directory.getFileHandle(file.name, { create: true });
		// createWritable writes to a swap file, so an interrupted import never leaves a partial image.
		const writable = await handle.createWritable();
		try {
			await file.stream().pipeTo(writable);
		} catch (error) {
			await writable.abort().catch(() => undefined);
			throw error;
		}
		onStored(file.name);
	}
}

export async function readStoredImage(name: string): Promise<File> {
	const directory = await getImagesDirectory();
	if (!directory) throw new Error('教材が保存されていません。');
	return (await directory.getFileHandle(name)).getFile();
}

export async function deleteStoredImages(): Promise<void> {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(imagesDirectoryName, { recursive: true }).catch((error) => {
		if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
	});
}

export async function availableStorageBytes(): Promise<number | undefined> {
	const estimate = await navigator.storage.estimate?.();
	return estimate?.quota === undefined
		? undefined
		: Math.max(0, estimate.quota - (estimate.usage ?? 0));
}

export function formatBytes(bytes: number): string {
	if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)} KB`;
	if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
	return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

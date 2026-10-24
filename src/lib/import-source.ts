import { archiveImageName } from './catalog.ts';

export type ImportSource = {
	archives: File[];
	/** Loose unit images, renamed to their catalog filenames. */
	images: File[];
	ignoredCount: number;
};

/** Sorts picked or dropped files into ZIP archives and loose unit images (e.g. from a folder). */
export function splitImportFiles(files: readonly File[]): ImportSource {
	const archives: File[] = [];
	const images = new Map<string, File>();
	let ignoredCount = 0;
	for (const file of files) {
		const path = file.webkitRelativePath || file.name;
		const name = archiveImageName(path);
		if (name) {
			if (images.has(name)) throw new Error(`同じUnitの画像が複数あります: ${name}`);
			images.set(name, new File([file], name, { type: 'image/jpeg' }));
		} else if (/\.zip$/i.test(file.name) && !/(?:^|\/)(?:__MACOSX\/|\._)/.test(path)) {
			archives.push(file);
		} else {
			ignoredCount++;
		}
	}
	return { archives, images: [...images.values()], ignoredCount };
}

function readAllEntries(directory: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
	const reader = directory.createReader();
	const entries: FileSystemEntry[] = [];
	return new Promise((resolve, reject) => {
		// readEntries returns results in batches until it yields an empty array.
		const next = () =>
			reader.readEntries((batch) => {
				if (!batch.length) return resolve(entries);
				entries.push(...batch);
				next();
			}, reject);
		next();
	});
}

async function filesFromEntry(entry: FileSystemEntry): Promise<File[]> {
	if (entry.isFile) {
		return [await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))];
	}
	if (!entry.isDirectory) return [];
	const children = await readAllEntries(entry as FileSystemDirectoryEntry);
	return (await Promise.all(children.map(filesFromEntry))).flat();
}

/** Collects dropped files, descending into dropped folders. Must be called synchronously in the drop handler. */
export function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
	const entries = [...dataTransfer.items]
		.filter((item) => item.kind === 'file')
		.map((item) => item.webkitGetAsEntry?.());
	if (entries.some((entry) => !entry)) return Promise.resolve([...dataTransfer.files]);
	return Promise.all(entries.map((entry) => filesFromEntry(entry!))).then((lists) => lists.flat());
}

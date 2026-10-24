import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitImportFiles } from './import-source.ts';

const file = (name: string, relativePath = '') => {
	const value = new File(['x'], name);
	Object.defineProperty(value, 'webkitRelativePath', { value: relativePath });
	return value;
};

test('folder images are renamed to catalog names and other files are ignored', () => {
	const source = splitImportFiles([
		file('unit001_Q.jpg', 'images/unit001_Q.jpg'),
		file('unit1_a.JPEG', 'images/unit1_a.JPEG'),
		file('.DS_Store', 'images/.DS_Store'),
		file('._unit002_Q.jpg', 'images/._unit002_Q.jpg'),
		file('notes.txt')
	]);
	assert.deepEqual(source.images.map((image) => image.name).sort(), ['unit001_A.jpg', 'unit001_Q.jpg']);
	assert.equal(source.archives.length, 0);
	assert.equal(source.ignoredCount, 3);
});

test('ZIPs and images can be imported together', () => {
	const source = splitImportFiles([file('eitango_unit001-058.zip'), file('unit100_Q.jpg')]);
	assert.deepEqual(source.archives.map((archive) => archive.name), ['eitango_unit001-058.zip']);
	assert.deepEqual(source.images.map((image) => image.name), ['unit100_Q.jpg']);
});

test('the same unit image twice is rejected', () => {
	assert.throws(
		() => splitImportFiles([file('unit001_Q.jpg', 'a/unit001_Q.jpg'), file('unit1_Q.jpg', 'b/unit1_Q.jpg')]),
		/unit001_Q\.jpg/
	);
});

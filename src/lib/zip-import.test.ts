import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zipSync } from 'fflate';
import { extractUnitImages } from './zip-import.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

test('only unit images are extracted from an archive', async () => {
	const archive = zipSync({
		'unit001_Q.jpg': bytes('q'),
		'folder/unit001_A.jpg': bytes('a'),
		'__MACOSX/._unit001_Q.jpg': bytes('x'),
		'readme.txt': bytes('r')
	});
	const images = await extractUnitImages(new Blob([archive]));
	assert.deepEqual(images.map((file) => file.name).sort(), ['unit001_A.jpg', 'unit001_Q.jpg']);
	assert.equal(await images.find((file) => file.name === 'unit001_A.jpg')!.text(), 'a');
});

test('duplicate unit images in one archive are rejected', async () => {
	const archive = zipSync({ 'a/unit001_Q.jpg': bytes('1'), 'b/unit001_Q.jpg': bytes('2') });
	await assert.rejects(extractUnitImages(new Blob([archive])), /unit001_Q\.jpg/);
});

test('a broken archive is rejected', async () => {
	await assert.rejects(extractUnitImages(new Blob([bytes('not a zip')])));
});

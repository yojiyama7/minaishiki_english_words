import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	archiveImageName,
	expectedFilenames,
	formatUnitRanges,
	imageFilename,
	parseLocation
} from './catalog.ts';

test('catalog lists a question and an answer image for every unit', () => {
	assert.equal(expectedFilenames.length, 464);
	assert.equal(new Set(expectedFilenames).size, 464);
	assert.equal(imageFilename(7, 'A'), 'unit007_A.jpg');
	assert.equal(expectedFilenames.at(-1), 'unit232_A.jpg');
});

test('archive entries are matched by basename and normalized', () => {
	assert.equal(archiveImageName('unit001_Q.jpg'), 'unit001_Q.jpg');
	assert.equal(archiveImageName('eitango/unit058_a.JPEG'), 'unit058_A.jpg');
	assert.equal(archiveImageName('unit12_Q.jpg'), 'unit012_Q.jpg');
	assert.equal(archiveImageName('unit233_Q.jpg'), null);
	assert.equal(archiveImageName('unit000_Q.jpg'), null);
	assert.equal(archiveImageName('__MACOSX/._unit001_Q.jpg'), null);
	assert.equal(archiveImageName('notes.txt'), null);
});

test('unit ranges are collapsed for messages', () => {
	assert.equal(formatUnitRanges([3, 1, 2, 7, 9, 10]), '1–3, 7, 9–10');
	assert.equal(formatUnitRanges([]), '');
});

test('location hashes select a unit and side', () => {
	assert.deepEqual(parseLocation('#12'), { unit: 12, side: 'Q' });
	assert.deepEqual(parseLocation('#12a'), { unit: 12, side: 'A' });
	assert.equal(parseLocation('#0'), null);
	assert.equal(parseLocation('#233'), null);
	assert.equal(parseLocation(''), null);
});

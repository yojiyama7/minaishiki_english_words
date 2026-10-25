import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	formatUnitRanges,
	imageFilename,
	isLegacyImage,
	parseLocation,
	requiredFilenames
} from './catalog.ts';

test('every unit needs the text image of both sides', () => {
	assert.equal(requiredFilenames.length, 464);
	assert.equal(new Set(requiredFilenames).size, 464);
	assert.equal(imageFilename(7, 'A', 'panel'), 'unit007_A_panel.jpg');
	assert.equal(requiredFilenames.at(-1), 'unit232_A_text.jpg');
});

test('whole images from the ZIP import are recognised as legacy', () => {
	assert.equal(isLegacyImage('unit001_Q.jpg'), true);
	assert.equal(isLegacyImage('unit001_Q_text.jpg'), false);
	assert.equal(isLegacyImage('book.pdf'), false);
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

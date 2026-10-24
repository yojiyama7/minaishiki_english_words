import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const forbidden = /\.(?:zip|jpe?g|png|webp|gif|pdf)$/i;
const isMaterial = (path) => forbidden.test(path) || /(?:^|\/)local-materials\//i.test(path);

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
	.split('\0').filter(Boolean);
const violations = tracked.filter(isMaterial);

async function inspect(directory) {
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) await inspect(path);
		else if (isMaterial(path)) violations.push(path);
	}
}

// static/ is copied into the published site, including ignored files.
await inspect('static');
if (process.argv.includes('--build')) await inspect('build');
if (violations.length) {
	throw new Error(`Local materials must not be tracked or published:\n${violations.join('\n')}`);
}
console.log('No local images or archives are tracked or included in static assets.');

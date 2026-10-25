<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import {
		expectedFilenames,
		formatUnitRanges,
		imageFilename,
		isUnit,
		parseLocation,
		unitCount,
		units,
		type Side
	} from '$lib/catalog';
	import {
		availableStorageBytes,
		deleteStoredImages,
		formatBytes,
		listStoredImages,
		readStoredImage,
		storeImages
	} from '$lib/local-library';
	import { filesFromDataTransfer, splitImportFiles } from '$lib/import-source';
	import { extractUnitImages } from '$lib/zip-import';

	type ViewMode = Side | 'both';
	const lastLocationKey = 'minaishiki:last-location';
	const viewModeKey = 'minaishiki:view-mode';

	let status = $state<'loading' | 'unsupported' | 'ready'>('loading');
	let stored = $state(new Set<string>());
	let unit = $state(1);
	let mode = $state<ViewMode>('Q');
	let drawerOpen = $state(false);
	let jumpValue = $state('');

	let importing = $state(false);
	let importProgress = $state('');
	let importError = $state('');
	let importNotice = $state('');
	let dragging = $state(false);
	let fileInput = $state<HTMLInputElement>();
	let folderInput = $state<HTMLInputElement>();

	const urlCache = new Map<string, Promise<string>>();
	let shownUrls = $state<Partial<Record<Side, string>>>({});

	const hasImages = $derived(stored.size > 0);
	const isComplete = $derived(expectedFilenames.every((name) => stored.has(name)));
	const missingUnits = $derived(
		units.filter((u) => !stored.has(imageFilename(u, 'Q')) || !stored.has(imageFilename(u, 'A')))
	);
	const availableUnits = $derived(units.filter((u) => !missingUnits.includes(u)));
	const visibleSides = $derived<Side[]>(mode === 'both' ? ['Q', 'A'] : [mode]);

	function unitAvailable(u: number) {
		return stored.has(imageFilename(u, 'Q')) || stored.has(imageFilename(u, 'A'));
	}

	function readSetting(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	function writeSetting(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// Remembering the position is only a convenience.
		}
	}

	function imageUrl(name: string): Promise<string> {
		let url = urlCache.get(name);
		if (!url) {
			url = readStoredImage(name).then((file) => URL.createObjectURL(file));
			url.catch(() => urlCache.delete(name));
			urlCache.set(name, url);
		}
		return url;
	}

	function clearUrlCache() {
		for (const url of urlCache.values()) url.then(URL.revokeObjectURL, () => undefined);
		urlCache.clear();
		shownUrls = {};
	}

	function applyLocation(hash: string) {
		const location = parseLocation(hash);
		if (!location) return false;
		unit = location.unit;
		mode = location.side;
		return true;
	}

	function goTo(next: number, nextMode: ViewMode = mode) {
		if (!isUnit(next)) return;
		unit = next;
		mode = nextMode;
		drawerOpen = false;
	}

	function step(delta: number) {
		const index = availableUnits.indexOf(unit);
		const next = index === -1
			? availableUnits.find((u) => (delta > 0 ? u > unit : u < unit))
			: availableUnits[index + delta];
		if (next !== undefined) goTo(next, mode === 'both' ? 'both' : 'Q');
	}

	function toggleSide() {
		if (mode !== 'both') mode = mode === 'Q' ? 'A' : 'Q';
	}

	function submitJump(event: SubmitEvent) {
		event.preventDefault();
		const value = Number(jumpValue);
		if (isUnit(value)) {
			goTo(value);
			jumpValue = '';
		}
	}

	async function refreshStored() {
		stored = await listStoredImages();
	}

	async function importFiles(files: File[]) {
		if (importing) return;
		importing = true;
		importError = '';
		importNotice = '';
		const ignored: string[] = [];
		try {
			const { archives, images: looseImages } = splitImportFiles(files);
			if (!archives.length && !looseImages.length) {
				throw new Error('Unit画像（unit001_Q.jpg など）またはZIPが見つかりませんでした。');
			}
			const totalBytes = [...archives, ...looseImages].reduce((total, file) => total + file.size, 0);
			const available = await availableStorageBytes();
			if (available !== undefined && available < totalBytes * 1.1) {
				throw new Error(
					`端末の空き容量が足りません（必要: 約${formatBytes(totalBytes)}、空き: ${formatBytes(available)}）。`
				);
			}
			await navigator.storage.persist?.().catch(() => false);

			if (looseImages.length) {
				let done = 0;
				await storeImages(looseImages, (name) => {
					done++;
					stored = new Set(stored).add(name);
					importProgress = `保存しています: ${done}/${looseImages.length}枚`;
				});
			}
			for (const [index, archive] of archives.entries()) {
				const label = `(${index + 1}/${archives.length}) ${archive.name}`;
				importProgress = `解凍しています ${label}`;
				let images: File[];
				try {
					images = await extractUnitImages(archive);
				} catch (error) {
					throw new Error(
						`${archive.name} を解凍できませんでした。${error instanceof Error ? error.message : ''}`
					);
				}
				if (!images.length) {
					ignored.push(archive.name);
					continue;
				}
				let done = 0;
				await storeImages(images, (name) => {
					done++;
					stored = new Set(stored).add(name);
					importProgress = `保存しています ${label}: ${done}/${images.length}枚`;
				});
			}
			await refreshStored();
			const notices: string[] = [];
			if (ignored.length) notices.push(`Unit画像が入っていないため無視しました: ${ignored.join(', ')}`);
			if (missingUnits.length) {
				notices.push(`まだ取り込まれていないUnit: ${formatUnitRanges(missingUnits)}`);
			} else {
				notices.push(`全${unitCount}ユニットの取り込みが完了しました。`);
			}
			importNotice = notices.join('\n');
			if (!unitAvailable(unit) && availableUnits.length) unit = availableUnits[0];
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
			await refreshStored().catch(() => undefined);
		} finally {
			importing = false;
			importProgress = '';
			if (fileInput) fileInput.value = '';
			if (folderInput) folderInput.value = '';
		}
	}

	async function removeLibrary() {
		if (!confirm('この端末に保存した教材画像をすべて削除しますか？')) return;
		clearUrlCache();
		await deleteStoredImages();
		await refreshStored();
		importNotice = '';
		drawerOpen = false;
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		if (!event.dataTransfer) return;
		filesFromDataTransfer(event.dataTransfer).then(importFiles, (error) => {
			importError = `ドロップされたファイルを読み込めませんでした。${error instanceof Error ? error.message : ''}`;
		});
	}

	function onKeydown(event: KeyboardEvent) {
		if (status !== 'ready' || !hasImages) return;
		const target = event.target as HTMLElement;
		if (target.closest('input, textarea, select')) return;
		if (event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.key === 'Escape') drawerOpen = false;
		else if (event.key === 'ArrowRight') step(1);
		else if (event.key === 'ArrowLeft') step(-1);
		else if (event.key === ' ' || event.key === 'ArrowUp' || event.key === 'ArrowDown') {
			if (target.closest('button')) return;
			toggleSide();
		} else if (event.key === 'q') mode = 'Q';
		else if (event.key === 'a') mode = 'A';
		else if (event.key === 'b') mode = 'both';
		else return;
		event.preventDefault();
	}

	let swipeStart: { x: number; y: number } | null = null;
	function onPointerDown(event: PointerEvent) {
		if (event.pointerType !== 'mouse') swipeStart = { x: event.clientX, y: event.clientY };
	}
	function onPointerUp(event: PointerEvent) {
		if (!swipeStart) return;
		const dx = event.clientX - swipeStart.x;
		const dy = event.clientY - swipeStart.y;
		swipeStart = null;
		if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
	}

	onMount(() => {
		if (!navigator.storage?.getDirectory) {
			status = 'unsupported';
			return;
		}
		if (!applyLocation(location.hash)) applyLocation(readSetting(lastLocationKey) ?? '');
		if (readSetting(viewModeKey) === 'both') mode = 'both';
		const onHashChange = () => applyLocation(location.hash);
		addEventListener('hashchange', onHashChange);
		refreshStored().then(
			() => {
				if (!unitAvailable(unit) && availableUnits.length) unit = availableUnits[0];
				status = 'ready';
			},
			(error) => {
				importError = `保存済みの教材を読み込めませんでした。${error instanceof Error ? error.message : ''}`;
				status = 'ready';
			}
		);
		return () => {
			removeEventListener('hashchange', onHashChange);
			clearUrlCache();
		};
	});

	// Keep the address bar and the remembered position in sync with the current view.
	$effect(() => {
		if (status !== 'ready') return;
		const hash = `#${unit}${mode === 'A' ? 'a' : ''}`;
		if (location.hash !== hash) history.replaceState(history.state, '', hash);
		writeSetting(lastLocationKey, hash);
		writeSetting(viewModeKey, mode === 'both' ? 'both' : 'single');
	});

	// Load the visible images, then warm up the neighbours so paging feels instant.
	$effect(() => {
		const current = unit;
		const sides = visibleSides;
		const available = stored;
		let cancelled = false;
		for (const side of sides) {
			const name = imageFilename(current, side);
			if (!available.has(name)) {
				// untrack: reading shownUrls here would make this effect re-run itself.
				untrack(() => (shownUrls = { ...shownUrls, [side]: undefined }));
				continue;
			}
			imageUrl(name).then(
				(url) => {
					if (!cancelled) shownUrls = { ...shownUrls, [side]: url };
				},
				() => undefined
			);
		}
		const preload = setTimeout(() => {
			for (const neighbour of [current + 1, current - 1, current]) {
				for (const side of ['Q', 'A'] as const) {
					const name = imageFilename(neighbour, side);
					if (isUnit(neighbour) && available.has(name)) {
						imageUrl(name).then((url) => (new Image().src = url), () => undefined);
					}
				}
			}
		}, 150);
		return () => {
			cancelled = true;
			clearTimeout(preload);
		};
	});

	$effect(() => {
		if (!drawerOpen) return;
		document.querySelector('.unit-grid [aria-current="true"]')?.scrollIntoView({ block: 'center' });
	});
</script>

<svelte:window onkeydown={onKeydown} />

<input
	bind:this={fileInput}
	type="file"
	accept=".zip,application/zip,.jpg,.jpeg,image/jpeg"
	multiple
	hidden
	onchange={(event) => importFiles([...(event.currentTarget.files ?? [])])}
/>
<input
	bind:this={folderInput}
	type="file"
	webkitdirectory
	hidden
	onchange={(event) => importFiles([...(event.currentTarget.files ?? [])])}
/>

{#snippet importStatus()}
	{#if importing}
		<p class="progress" role="status"><span class="spinner"></span>{importProgress}</p>
	{/if}
	{#if importError}
		<p class="message error" role="alert">{importError}</p>
	{/if}
	{#if importNotice}
		<p class="message notice">{importNotice}</p>
	{/if}
{/snippet}

{#if status === 'loading'}
	<main class="centered"><p class="muted">読み込んでいます…</p></main>
{:else if status === 'unsupported'}
	<main class="centered">
		<div class="card">
			<h1>このブラウザでは利用できません</h1>
			<p>教材を端末内に保存する機能（Origin Private File System）に対応した、最新のChrome・Edge・Safari・Firefoxで開いてください。</p>
		</div>
	</main>
{:else if !hasImages}
	<main class="centered">
		<div
			class="card import-card"
			class:dragging
			role="region"
			aria-label="教材の取り込み"
			ondragover={(event) => {
				event.preventDefault();
				dragging = true;
			}}
			ondragleave={() => (dragging = false)}
			ondrop={onDrop}
		>
			<h1>薬袋式英単語ビューア</h1>
			<p>
				<code>unit001_Q.jpg</code>・<code>unit001_A.jpg</code>…
				が入ったフォルダ、または <code>eitango_unit001-058.zip</code> などのZIPを選択してください。
			</p>
			<div class="import-actions">
				<button class="primary" disabled={importing} onclick={() => folderInput?.click()}>
					フォルダを選択
				</button>
				<button class="secondary" disabled={importing} onclick={() => fileInput?.click()}>
					ZIP・画像を選択
				</button>
			</div>
			<p class="hint">フォルダやファイルをここにドラッグ＆ドロップもできます</p>
			{@render importStatus()}
			<p class="fine">
				画像はこのブラウザの中で解凍し、端末内の保存領域に保管します。サーバーへは送信されません。2回目以降は取り込み済みの画像を使います。
			</p>
		</div>
	</main>
{:else}
	<div class="app">
		<header class="topbar">
			<button
				class="unit-button"
				aria-expanded={drawerOpen}
				aria-controls="unit-drawer"
				onclick={() => (drawerOpen = !drawerOpen)}
			>
				<span class="unit-label">Unit</span>
				<span class="unit-number">{unit}</span>
				<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" /></svg>
			</button>

			<div class="segmented" role="radiogroup" aria-label="表示">
				{#each [['Q', 'Q'], ['A', 'A'], ['both', 'Q+A']] as const as [value, label] (value)}
					<button role="radio" aria-checked={mode === value} onclick={() => (mode = value)}>
						{label}
					</button>
				{/each}
			</div>

			<nav class="pager" aria-label="ユニット移動">
				<button aria-label="前のユニット" disabled={unit <= (availableUnits[0] ?? 1)} onclick={() => step(-1)}>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" /></svg>
				</button>
				<button
					aria-label="次のユニット"
					disabled={unit >= (availableUnits.at(-1) ?? unitCount)}
					onclick={() => step(1)}
				>
					<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" /></svg>
				</button>
			</nav>
		</header>

		<aside id="unit-drawer" class="drawer" class:open={drawerOpen} aria-label="ユニット一覧">
			<form class="jump" onsubmit={submitJump}>
				<input
					type="number"
					inputmode="numeric"
					min="1"
					max={unitCount}
					placeholder="Unit番号"
					aria-label="Unit番号を入力して移動"
					bind:value={jumpValue}
				/>
				<button type="submit">移動</button>
			</form>
			<div class="unit-grid">
				{#each units as u (u)}
					<button
						aria-current={u === unit}
						disabled={!unitAvailable(u)}
						onclick={() => goTo(u, mode === 'both' ? 'both' : 'Q')}
					>
						{u}
					</button>
				{/each}
			</div>
			<section class="library">
				<p class="muted">
					保存済み {stored.size}/{expectedFilenames.length}枚
					{#if !isComplete}<br />未取り込み: Unit {formatUnitRanges(missingUnits)}{/if}
				</p>
				{@render importStatus()}
				<div class="library-actions">
					<button disabled={importing} onclick={() => folderInput?.click()}>フォルダを取り込み</button>
					<button disabled={importing} onclick={() => fileInput?.click()}>ZIP・画像を取り込み</button>
					<button class="danger" disabled={importing} onclick={removeLibrary}>端末から削除</button>
				</div>
				<p class="fine">← → でユニット移動、Space で Q/A 切替。スマホは左右スワイプで移動。</p>
			</section>
		</aside>
		{#if drawerOpen}
			<button class="scrim" aria-label="一覧を閉じる" onclick={() => (drawerOpen = false)}></button>
		{/if}

		<main
			class="viewer"
			class:both={mode === 'both'}
			onpointerdown={onPointerDown}
			onpointerup={onPointerUp}
			onpointercancel={() => (swipeStart = null)}
		>
			{#each visibleSides as side (side)}
				<figure class="page">
					<figcaption><span class="side-tag" data-side={side}>{side}</span> Unit {unit}</figcaption>
					{#if !stored.has(imageFilename(unit, side))}
						<p class="missing">この画像はまだ取り込まれていません</p>
					{:else if shownUrls[side]}
						<button
							class="image-button"
							disabled={mode === 'both'}
							aria-label={mode === 'both' ? undefined : side === 'Q' ? 'Aを表示' : 'Qを表示'}
							onclick={toggleSide}
						>
							<img src={shownUrls[side]} alt="Unit {unit} {side === 'Q' ? '問題' : '解答'}" draggable="false" />
						</button>
					{/if}
				</figure>
			{/each}
		</main>
	</div>
{/if}

<style>
	:global(:root) {
		--bg: #f4f2ee;
		--surface: #ffffff;
		--surface-2: #ebe8e2;
		--text: #23211e;
		--muted: #6d6860;
		--border: #d9d4cb;
		--accent: #1f5f8b;
		--accent-text: #ffffff;
		--q: #1f5f8b;
		--a: #c23b55;
		--danger: #b3261e;
		--focus: #2b7bb9;
		color-scheme: light;
	}
	@media (prefers-color-scheme: dark) {
		:global(:root) {
			--bg: #161616;
			--surface: #222222;
			--surface-2: #2d2d2d;
			--text: #ecebe8;
			--muted: #a29d95;
			--border: #3a3a3a;
			--accent: #6aaee0;
			--accent-text: #0e1a24;
			--q: #6aaee0;
			--a: #f08aa0;
			--danger: #ff8a80;
			--focus: #8cc4ee;
			color-scheme: dark;
		}
	}
	:global(html, body) {
		margin: 0;
		height: 100%;
		background: var(--bg);
		color: var(--text);
		font-family:
			system-ui, -apple-system, 'Hiragino Sans', 'Noto Sans JP', sans-serif;
		-webkit-text-size-adjust: 100%;
	}
	:global(*) {
		box-sizing: border-box;
	}
	:global(button) {
		font: inherit;
		color: inherit;
		cursor: pointer;
	}
	:global(:focus-visible) {
		outline: 2px solid var(--focus);
		outline-offset: 2px;
	}

	.centered {
		min-height: 100dvh;
		display: grid;
		place-items: center;
		padding: 16px;
	}
	.card {
		width: min(100%, 34rem);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 16px;
		padding: 28px 24px;
		line-height: 1.7;
	}
	.card h1 {
		margin: 0 0 8px;
		font-size: 1.4rem;
	}
	.import-card {
		text-align: center;
		border-style: dashed;
		border-width: 2px;
		transition: border-color 0.15s, background 0.15s;
	}
	.import-card.dragging {
		border-color: var(--accent);
		background: var(--surface-2);
	}
	code {
		font-size: 0.85em;
		background: var(--surface-2);
		padding: 1px 5px;
		border-radius: 4px;
		word-break: break-all;
	}
	.primary {
		margin-top: 8px;
		background: var(--accent);
		color: var(--accent-text);
		border: none;
		border-radius: 999px;
		padding: 12px 28px;
		font-weight: 600;
		font-size: 1rem;
	}
	.import-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: 8px;
	}
	.secondary {
		margin-top: 8px;
		background: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 11px 22px;
		font-weight: 600;
		font-size: 1rem;
	}
	.secondary:disabled,
	.primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
	.hint,
	.muted {
		color: var(--muted);
		font-size: 0.9rem;
	}
	.fine {
		color: var(--muted);
		font-size: 0.8rem;
		line-height: 1.6;
		margin-bottom: 0;
	}
	.progress {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		font-size: 0.9rem;
	}
	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
		flex: none;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.message {
		white-space: pre-line;
		font-size: 0.85rem;
		text-align: left;
		border-radius: 8px;
		padding: 8px 12px;
	}
	.error {
		color: var(--danger);
		border: 1px solid currentColor;
	}
	.notice {
		background: var(--surface-2);
	}

	/* Viewer */
	.app {
		--topbar: 56px;
		--drawer: 300px;
		min-height: 100dvh;
	}
	.topbar {
		position: sticky;
		top: 0;
		z-index: 20;
		height: var(--topbar);
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 0 12px;
		background: color-mix(in srgb, var(--bg) 88%, transparent);
		backdrop-filter: blur(8px);
		border-bottom: 1px solid var(--border);
	}
	.unit-button {
		display: flex;
		align-items: baseline;
		gap: 6px;
		background: none;
		border: none;
		padding: 6px 8px;
		border-radius: 8px;
	}
	.unit-button:hover {
		background: var(--surface-2);
	}
	.unit-label {
		font-size: 0.8rem;
		color: var(--muted);
	}
	.unit-number {
		font-size: 1.4rem;
		font-weight: 700;
		font-variant-numeric: tabular-nums;
		min-width: 2.2ch;
	}
	.unit-button svg,
	.pager svg {
		width: 14px;
		height: 14px;
		fill: none;
		stroke: currentColor;
		stroke-width: 2;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	.segmented {
		display: flex;
		background: var(--surface-2);
		border-radius: 999px;
		padding: 3px;
		margin-left: auto;
	}
	.segmented button {
		border: none;
		background: none;
		border-radius: 999px;
		padding: 6px 14px;
		font-weight: 600;
		font-size: 0.9rem;
		color: var(--muted);
	}
	.segmented button[aria-checked='true'] {
		background: var(--surface);
		color: var(--text);
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.15);
	}
	.pager {
		display: flex;
		gap: 4px;
	}
	.pager button {
		width: 40px;
		height: 40px;
		display: grid;
		place-items: center;
		border: 1px solid var(--border);
		background: var(--surface);
		border-radius: 50%;
	}
	.pager button:disabled {
		opacity: 0.35;
		cursor: default;
	}
	.pager svg {
		width: 16px;
		height: 16px;
	}

	.drawer {
		position: fixed;
		top: var(--topbar);
		bottom: 0;
		left: 0;
		z-index: 15;
		width: min(var(--drawer), 88vw);
		overflow-y: auto;
		background: var(--surface);
		border-right: 1px solid var(--border);
		padding: 12px;
		transform: translateX(-100%);
		transition: transform 0.2s ease;
	}
	.drawer.open {
		transform: none;
	}
	.scrim {
		position: fixed;
		inset: var(--topbar) 0 0 0;
		z-index: 10;
		border: none;
		background: rgb(0 0 0 / 0.3);
	}
	.jump {
		display: flex;
		gap: 6px;
		margin-bottom: 12px;
	}
	.jump input {
		flex: 1;
		min-width: 0;
		font: inherit;
		font-size: 16px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
		color: var(--text);
	}
	.jump button,
	.library-actions button {
		border: 1px solid var(--border);
		background: var(--surface-2);
		border-radius: 8px;
		padding: 8px 12px;
		font-size: 0.85rem;
	}
	.unit-grid {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: 4px;
	}
	.unit-grid button {
		aspect-ratio: 1.3;
		border: 1px solid transparent;
		background: var(--surface-2);
		border-radius: 6px;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
	}
	.unit-grid button:hover:not(:disabled) {
		border-color: var(--accent);
	}
	.unit-grid button[aria-current='true'] {
		background: var(--accent);
		color: var(--accent-text);
		font-weight: 700;
	}
	.unit-grid button:disabled {
		opacity: 0.3;
		cursor: default;
	}
	.library {
		margin-top: 16px;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}
	.library-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}
	.library-actions .danger {
		color: var(--danger);
	}

	.viewer {
		display: grid;
		gap: 16px;
		padding: 16px;
		justify-content: center;
		touch-action: pan-y pinch-zoom;
	}
	.page {
		margin: 0;
		width: min(100%, 860px);
	}
	.page figcaption {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.85rem;
		color: var(--muted);
		margin-bottom: 6px;
	}
	.side-tag {
		display: inline-grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 6px;
		color: #fff;
		font-weight: 700;
		font-size: 0.8rem;
		background: var(--q);
	}
	.side-tag[data-side='A'] {
		background: var(--a);
	}
	.image-button {
		display: block;
		width: 100%;
		padding: 0;
		border: none;
		background: #fff;
		border-radius: 10px;
		overflow: hidden;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.12);
		cursor: pointer;
	}
	.image-button:disabled {
		cursor: default;
	}
	.image-button img {
		display: block;
		width: 100%;
		height: auto;
		user-select: none;
		-webkit-user-select: none;
	}
	.missing {
		padding: 48px 16px;
		text-align: center;
		color: var(--muted);
		border: 1px dashed var(--border);
		border-radius: 10px;
	}

	@media (min-width: 960px) {
		.app {
			display: grid;
			grid-template-columns: var(--drawer) 1fr;
			grid-template-rows: var(--topbar) 1fr;
		}
		.topbar {
			grid-column: 1 / -1;
		}
		.drawer {
			position: sticky;
			top: var(--topbar);
			height: calc(100dvh - var(--topbar));
			width: auto;
			transform: none;
			transition: none;
		}
		.scrim {
			display: none;
		}
		.unit-button {
			pointer-events: none;
		}
		.unit-button svg {
			display: none;
		}
		/* Fit a single page to the window so it can be read without scrolling. */
		.viewer:not(.both) .image-button {
			width: fit-content;
			max-width: 100%;
			margin: 0 auto;
		}
		.viewer:not(.both) .image-button img {
			width: auto;
			max-width: 100%;
			max-height: calc(100dvh - var(--topbar) - 68px);
		}
		.viewer.both {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			align-items: start;
		}
		.viewer.both .page {
			width: 100%;
		}
	}
	@media (max-width: 420px) {
		.topbar {
			gap: 6px;
			padding: 0 8px;
		}
		.segmented button {
			padding: 6px 10px;
		}
		.pager button {
			width: 36px;
			height: 36px;
		}
	}
	/* Phones: images span the full screen width. */
	@media (max-width: 640px) {
		.viewer {
			padding: 12px 0;
		}
		.page {
			width: 100%;
		}
		.page figcaption {
			padding: 0 12px;
		}
		.image-button {
			border-radius: 0;
			box-shadow: none;
		}
	}
</style>

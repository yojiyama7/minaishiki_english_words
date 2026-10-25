<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { PDFDocumentProxy } from 'pdfjs-dist';
	import {
		bookFilename,
		bookSettingsFilename,
		defaultFirstPage,
		formatUnitRanges,
		imageFilename,
		isLegacyImage,
		isUnit,
		parseLocation,
		unitCount,
		units,
		type BookSettings,
		type Part,
		type Side
	} from '$lib/catalog';
	import { unitPages } from '$lib/crop-layout';
	import {
		availableStorageBytes,
		deleteStoredFiles,
		formatBytes,
		listStoredFiles,
		readStoredFile,
		storeFiles
	} from '$lib/local-library';

	type ViewMode = Side | 'both';
	const parts: Part[] = ['text', 'panel'];
	const lastLocationKey = 'minaishiki:last-location';
	const viewModeKey = 'minaishiki:view-mode';
	const firstPageKey = 'minaishiki:first-page';

	let status = $state<'loading' | 'unsupported' | 'ready'>('loading');
	let stored = $state(new Set<string>());
	let settings = $state<BookSettings | null>(null);
	let unit = $state(1);
	let mode = $state<ViewMode>('Q');
	let showOriginal = $state(false);
	let drawerOpen = $state(false);
	let jumpValue = $state('');

	let firstPageInput = $state(String(defaultFirstPage));
	let importing = $state(false);
	let importProgress = $state('');
	let importError = $state('');
	let importNotice = $state('');
	let dragging = $state(false);
	let fileInput = $state<HTMLInputElement>();

	const urlCache = new Map<string, Promise<string>>();
	let shownUrls = $state<Record<string, string | undefined>>({});
	/** Natural width / height of each shown image, needed to lay out rotated images. */
	let imageRatios = $state<Record<string, number>>({});
	// Rotating by 90° is a per-visit convenience on phones and tablets, so it is not remembered.
	let rotated = $state(false);

	const availableUnits = $derived(units.filter((u) => unitAvailable(u)));
	const hasUnits = $derived(availableUnits.length > 0);
	const hasLegacyImages = $derived([...stored].some(isLegacyImage));
	const visibleSides = $derived<Side[]>(mode === 'both' ? ['Q', 'A'] : [mode]);

	function unitAvailable(u: number) {
		return stored.has(imageFilename(u, 'Q', 'text')) && stored.has(imageFilename(u, 'A', 'text'));
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

	function cachedUrl(key: string, load: () => Promise<Blob>): Promise<string> {
		let url = urlCache.get(key);
		if (!url) {
			url = load().then((blob) => URL.createObjectURL(blob));
			url.catch(() => urlCache.delete(key));
			urlCache.set(key, url);
		}
		return url;
	}

	const imageUrl = (name: string) => cachedUrl(name, () => readStoredFile(name));

	// The original pages are rendered from the stored PDF only when asked for.
	let pdfPromise: Promise<PDFDocumentProxy> | null = null;
	function originalPageUrl(page: number) {
		return cachedUrl(`page:${page}`, async () => {
			const { openPdf, renderPage } = await import('$lib/pdf-import');
			pdfPromise ??= readStoredFile(bookFilename).then(openPdf);
			pdfPromise.catch(() => (pdfPromise = null));
			const canvas = await renderPage(await pdfPromise, page, 1100);
			return new Promise<Blob>((resolve, reject) =>
				canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('render failed'))), 'image/jpeg', 0.85)
			);
		});
	}

	function clearUrlCache() {
		for (const url of urlCache.values()) url.then(URL.revokeObjectURL, () => undefined);
		urlCache.clear();
		shownUrls = {};
		pdfPromise?.then((pdf) => pdf.loadingTask.destroy(), () => undefined);
		pdfPromise = null;
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

	async function refreshStored(): Promise<BookSettings | null> {
		stored = await listStoredFiles();
		settings = stored.has(bookSettingsFilename)
			? JSON.parse(await (await readStoredFile(bookSettingsFilename)).text())
			: null;
		return settings;
	}

	async function importPdf(file: File | undefined) {
		if (!file || importing) return;
		const firstPage = Number(firstPageInput);
		importError = '';
		importNotice = '';
		if (!Number.isInteger(firstPage) || firstPage < 1) {
			importError = 'Unit 1 のページ番号を入力してください。';
			return;
		}
		if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
			importError = 'PDFファイルを選択してください。';
			return;
		}
		importing = true;
		writeSetting(firstPageKey, String(firstPage));
		try {
			// The PDF is kept for the original-page view; the crops add roughly twice its size.
			const needed = file.size * 3;
			const available = await availableStorageBytes();
			if (available !== undefined && available < needed) {
				throw new Error(
					`端末の空き容量が足りません（必要: 約${formatBytes(needed)}、空き: ${formatBytes(available)}）。`
				);
			}
			await navigator.storage.persist?.().catch(() => false);

			importProgress = 'PDFを開いています';
			const { openPdf, cropBook } = await import('$lib/pdf-import');
			let pdf: PDFDocumentProxy;
			try {
				pdf = await openPdf(file);
			} catch (error) {
				throw new Error(`PDFを開けませんでした。${error instanceof Error ? error.message : ''}`);
			}
			try {
				clearUrlCache();
				await deleteStoredFiles();
				stored = new Set();
				settings = null;
				const fallbackUnits: number[] = [];
				await cropBook(pdf, firstPage, async (cropped, done, total) => {
					await storeFiles(cropped.files);
					fallbackUnits.push(...cropped.fallbackUnits);
					importProgress = `切り出しています: Unit ${done * 2}/${unitCount}（${Math.round((done / total) * 100)}%）`;
				});
				importProgress = 'PDFを保存しています';
				const bookSettings: BookSettings = { firstPage, fallbackUnits };
				await storeFiles([
					new File([file], bookFilename, { type: 'application/pdf' }),
					new File([JSON.stringify(bookSettings)], bookSettingsFilename, { type: 'application/json' })
				]);
			} finally {
				await pdf.loadingTask.destroy();
			}
			const imported = await refreshStored();
			importNotice = imported?.fallbackUnits.length
				? `自動で切り出せなかったUnit（ページの半分を表示します）: ${formatUnitRanges(imported.fallbackUnits)}`
				: `全${unitCount}ユニットを切り出しました。`;
			if (!unitAvailable(unit) && availableUnits.length) unit = availableUnits[0];
		} catch (error) {
			importError = error instanceof Error ? error.message : String(error);
			await refreshStored().catch(() => undefined);
		} finally {
			importing = false;
			importProgress = '';
			if (fileInput) fileInput.value = '';
		}
	}

	async function removeLibrary() {
		if (!confirm('この端末に保存した教材（PDFと切り出した画像）をすべて削除しますか？')) return;
		clearUrlCache();
		await deleteStoredFiles();
		await refreshStored();
		importNotice = '';
		drawerOpen = false;
	}

	function onDrop(event: DragEvent) {
		event.preventDefault();
		dragging = false;
		importPdf(event.dataTransfer?.files[0]);
	}

	function onKeydown(event: KeyboardEvent) {
		if (status !== 'ready' || !hasUnits || importing) return;
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
		else if (event.key === 'o') showOriginal = !showOriginal;
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
		firstPageInput = readSetting(firstPageKey) ?? firstPageInput;
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

	function viewKeys(u: number, side: Side, original: boolean): string[] {
		if (original && settings) {
			const pages = unitPages(u, settings.firstPage);
			return [`page:${side === 'Q' ? pages.q : pages.a}`];
		}
		return parts.map((part) => imageFilename(u, side, part));
	}

	function loadView(key: string): Promise<string> | null {
		if (key.startsWith('page:')) return originalPageUrl(Number(key.slice(5)));
		return stored.has(key) ? imageUrl(key) : null;
	}

	// Load the visible images, then warm up the neighbours so paging feels instant.
	$effect(() => {
		const current = unit;
		const keys = visibleSides.flatMap((side) => viewKeys(current, side, showOriginal));
		const available = stored;
		let cancelled = false;
		for (const key of keys) {
			const url = loadView(key);
			if (!url) continue;
			url.then(
				(value) => {
					// untrack: reading shownUrls here would make this effect re-run itself.
					if (!cancelled) untrack(() => (shownUrls = { ...shownUrls, [key]: value }));
				},
				() => undefined
			);
		}
		const preload = setTimeout(() => {
			for (const neighbour of [current + 1, current - 1, current]) {
				if (!isUnit(neighbour)) continue;
				for (const side of ['Q', 'A'] as const) {
					for (const part of parts) {
						const name = imageFilename(neighbour, side, part);
						if (available.has(name)) imageUrl(name).then((url) => (new Image().src = url), () => undefined);
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
	accept=".pdf,application/pdf"
	hidden
	onchange={(event) => importPdf(event.currentTarget.files?.[0])}
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

{#snippet firstPageField()}
	<label class="first-page">
		Unit 1 のページ番号
		<input type="number" inputmode="numeric" min="1" disabled={importing} bind:value={firstPageInput} />
	</label>
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
{:else if importing || !hasUnits}
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
				『薬袋式英単語暗記法』をスキャンしたPDFと、Unit 1 が載っているページ番号（PDFビューアでの番号）を指定してください。
			</p>
			{@render firstPageField()}
			<div class="import-actions">
				<button class="primary" disabled={importing} onclick={() => fileInput?.click()}>PDFを選択</button>
			</div>
			<p class="hint">PDFをここにドラッグ＆ドロップもできます</p>
			{#if hasLegacyImages && !importing}
				<p class="message notice">以前の形式（ZIP・フォルダ）で取り込んだ画像が残っています。PDFを取り込むと置き換わります。</p>
			{/if}
			{@render importStatus()}
			<p class="fine">
				PDFはこのブラウザの中でページを描画し、Unitごとに「問題文・訳文」と「CHECK YOUR VOCABULARY・ANSWERS」の枠を切り出して端末内の保存領域に保管します。サーバーへは送信されません。2回目以降は取り込み済みのデータを使います。
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

			<button
				class="rotate-button"
				aria-pressed={rotated}
				aria-label="画像を90°回転"
				title="画像を90°回転"
				onclick={() => (rotated = !rotated)}
			>
				<svg viewBox="0 0 16 16" aria-hidden="true">
					<path d="M12.5 7.5A5 5 0 1 1 9.5 3" /><path d="M9 1l1.5 2L8.5 4.5" />
				</svg>
			</button>

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
				<label class="toggle">
					<input type="checkbox" bind:checked={showOriginal} disabled={!stored.has(bookFilename)} />
					元のページを表示
				</label>
				{#if settings}
					<p class="muted">
						PDFの {settings.firstPage} ページを Unit 1 として取り込み済み
						{#if settings.fallbackUnits.length}<br />自動で切り出せなかったUnit: {formatUnitRanges(settings.fallbackUnits)}{/if}
					</p>
				{/if}
				{@render importStatus()}
				{@render firstPageField()}
				<div class="library-actions">
					<button disabled={importing} onclick={() => fileInput?.click()}>PDFを取り込み直す</button>
					<button class="danger" disabled={importing} onclick={removeLibrary}>端末から削除</button>
				</div>
				<p class="fine">← → でユニット移動、Space で Q/A 切替、O で元のページ。スマホは左右スワイプで移動。</p>
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
					<button
						class="image-button"
						disabled={mode === 'both'}
						aria-label={mode === 'both' ? undefined : side === 'Q' ? 'Aを表示' : 'Qを表示'}
						onclick={toggleSide}
					>
						{#each viewKeys(unit, side, showOriginal) as key (key)}
							{#if shownUrls[key]}
								<span
									class="image-frame"
									class:rotated={rotated && imageRatios[key]}
									style:--ratio={imageRatios[key]}
								>
									<img
										src={shownUrls[key]}
										alt="Unit {unit} {side === 'Q' ? '問題' : '解答'}"
										draggable="false"
										onload={(event) => {
											const image = event.currentTarget as HTMLImageElement;
											imageRatios[key] = image.naturalWidth / image.naturalHeight;
										}}
									/>
								</span>
							{/if}
						{/each}
					</button>
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
		/* An explicit column width: rotated images are absolutely positioned and give no width. */
		grid-template-columns: minmax(0, 860px);
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
		display: flex;
		flex-direction: column;
		gap: 14px;
		width: 100%;
		padding: 10px 0;
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
	.image-frame {
		display: block;
		position: relative;
		width: 100%;
	}
	.image-frame img {
		display: block;
		width: 100%;
		height: auto;
		user-select: none;
		-webkit-user-select: none;
	}
	/* Rotated 90° clockwise: the frame takes the rotated shape and the image is turned into it. */
	.image-frame.rotated {
		aspect-ratio: 1 / var(--ratio);
	}
	.image-frame.rotated img {
		position: absolute;
		top: 0;
		left: 0;
		width: calc(100% * var(--ratio));
		transform-origin: top left;
		transform: rotate(90deg) translateY(-100%);
	}
	/* Rotation is offered on touch devices (phones and tablets) only. */
	.rotate-button {
		display: none;
		width: 40px;
		height: 40px;
		place-items: center;
		border: 1px solid var(--border);
		background: var(--surface);
		border-radius: 50%;
		flex: none;
	}
	.rotate-button[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-text);
		border-color: var(--accent);
	}
	.rotate-button svg {
		width: 16px;
		height: 16px;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.8;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
	@media (hover: none) and (pointer: coarse) {
		.rotate-button {
			display: grid;
		}
	}
	.first-page {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		margin: 12px 0;
		font-size: 0.9rem;
	}
	.first-page input {
		width: 5.5em;
		font: inherit;
		font-size: 16px;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg);
		color: var(--text);
	}
	.library .first-page {
		justify-content: flex-start;
	}
	.toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.9rem;
		margin: 4px 0 8px;
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
		.pager button,
		.rotate-button {
			width: 36px;
			height: 36px;
		}
		.unit-label {
			display: none;
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

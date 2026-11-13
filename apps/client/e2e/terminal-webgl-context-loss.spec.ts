import { expect, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { androidSerial, benchUrl, git, installBenchBridge, require, root, test } from './fixtures/benchEnvironment';

// WebGL context-loss run of the renderer shootout (#1323, docs/architecture/terminal-benchmarks.md): the xterm.js WebGL addon
// on the benchmark page, its context taken away with WEBGL_lose_context, and what the user would see afterwards. Correctness is
// pixels: a screenshot of the terminal against one taken from a terminal that never lost its context and was fed the same bytes.
// Times are recorded, never asserted. Skipped where the browser has no WebGL2 (the addon cannot load).
const launchArgs = (process.env.LAZYSH_BENCH_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean);
test.use({ launchOptions: { args: launchArgs } });
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => isMobile, 'Context loss does not depend on the viewport: one project is enough.');

const version = (name: string) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')).version;

const rowText = (i: number) => `\x1b[1;3${1 + (i % 6)}mrow ${String(i).padStart(2, '0')}\x1b[0m plain \x1b[48;5;${17 + i}m bg \x1b[0m café 中文 \u{1F600}`;
const FIRST = Array.from({ length: 60 }, (_, i) => rowText(i)).join('\r\n');
const LATER = '\r\n' + Array.from({ length: 12 }, (_, i) => rowText(100 + i)).join('\r\n');
/** The addon waits this long for a restore before it reports the loss (addon-webgl 0.18.0), so the app can fall back. */
const RESTORE_WINDOW_MS = 3000;

type Events = Array<{ type: string; at: number }>;
const events = (list: Events) => Object.fromEntries(list.map(e => [e.type, e.at]));
const gap = (log: Record<string, number>, from: string, to: string) => (log[to] === undefined || log[from] === undefined ? null : log[to] - log[from]);
const screenshot = (page: Page) => page.locator('.terminal-canvas .xterm-screen').screenshot();

async function open(page: Page, renderer: 'webgl' | 'dom', ...writes: string[]) {
  await page.goto(benchUrl(baseUrl, `renderer=${renderer}`));
  await page.waitForFunction(() => !!window.terminalBench);
  const geometry = await page.evaluate(() => window.terminalBench.open());
  await expect(page.locator('.terminal-canvas .xterm-screen')).toBeVisible();
  expect(geometry.canvases > 0, `renderer ${renderer} must be drawing`).toBe(renderer === 'webgl');
  await page.evaluate(() => window.terminalBench.quiet());
  for (const text of writes) await page.evaluate(t => window.terminalBench.write(t), text);
  return geometry;
}
/** The pixels of a terminal that never lost its context; the same bytes must look the same after a loss. */
async function reference(page: Page, renderer: 'webgl' | 'dom', ...writes: string[]) {
  await open(page, renderer, ...writes);
  return screenshot(page);
}
/** Polls screenshots until the terminal shows `expected`; the time is an upper bound with the resolution of one screenshot. */
async function pixelsEqualWithin(page: Page, expected: Buffer, timeout: number) {
  const started = Date.now();
  let equal = false;
  try { await expect.poll(async () => (equal = (await screenshot(page)).equals(expected)), { timeout, intervals: [20] }).toBe(true); } catch { /* reported by the caller */ }
  return { equal, ms: Date.now() - started };
}

const results: Array<Record<string, unknown>> = [];
let context: Record<string, unknown> = {};
const pageErrors: string[] = [];
let baseUrl: string | undefined;

test.beforeEach(async ({ page, baseURL }) => {
  baseUrl = baseURL;
  pageErrors.length = 0;
  page.on('pageerror', error => pageErrors.push(error.message));
  await installBenchBridge(page);
  await page.goto('about:blank');
  test.skip(!(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))), 'The browser has no WebGL2.');
});

test.afterEach(() => { expect(pageErrors, 'a lost or restored context must not throw in the page').toEqual([]); });

for (const [name, restoreAfterMs] of [['restored quickly', 300], ['restored just inside the addon grace period', 2000]] as const) {
  test(`lost and ${name}`, async ({ page }) => {
    const wanted = await reference(page, 'webgl', FIRST);
    const geometry = await open(page, 'webgl', FIRST);
    context = { geometry, chromium: page.context().browser()!.version() };
    expect(await page.evaluate(() => window.terminalBench.loseContext()), 'the terminal must have a WebGL context to lose').toBe(true);
    await page.waitForTimeout(restoreAfterMs);
    // Guard of the method: a lost context must be visible in the pixels, or "equal after restore" proves nothing.
    const whileLost = (await screenshot(page)).equals(wanted);
    await page.evaluate(() => window.terminalBench.restoreContext());
    const restored = await pixelsEqualWithin(page, wanted, 5000);
    const log = events(await page.evaluate(() => window.terminalBench.contextEvents()));
    const losses = await page.evaluate(() => window.terminalBench.contextLosses());
    results.push({ scenario: name, restoreAfterMs, identicalWhileLost: whileLost, pixelsIdenticalAfterRestore: restored.equal, restoreToIdenticalPixelsMsUpperBound: restored.ms, loseToCanvasLostMs: gap(log, 'lose', 'canvas-lost'), restoreToCanvasRestoredMs: gap(log, 'restore', 'canvas-restored'), addonGaveUp: losses, canvasesAfter: await page.evaluate(() => window.terminalBench.canvases()) });
    expect(whileLost, 'a lost context must show in the pixels').toBe(false);
    expect(losses, 'the addon restored itself: the app was never asked to fall back').toBe(0);
    expect(restored.equal, 'after the restore the terminal looks as if nothing had happened').toBe(true);
  });
}

test('output arrives while the context is lost', async ({ page }) => {
  const wanted = await reference(page, 'webgl', FIRST, LATER);
  await open(page, 'webgl', FIRST);
  await page.evaluate(() => window.terminalBench.loseContext());
  await page.evaluate(t => window.terminalBench.write(t), LATER);
  await page.waitForTimeout(500);
  await page.evaluate(() => window.terminalBench.restoreContext());
  const restored = await pixelsEqualWithin(page, wanted, 5000);
  const losses = await page.evaluate(() => window.terminalBench.contextLosses());
  results.push({ scenario: 'output while lost, then restored', bytesWhileLost: LATER.length, pixelsIdenticalToNeverLost: restored.equal, restoreToIdenticalPixelsMsUpperBound: restored.ms, addonGaveUp: losses });
  expect(losses).toBe(0);
  expect(restored.equal, 'the restored terminal shows the output written while it had no context').toBe(true);
});

test('never restored: the app falls back to the DOM renderer and can come back', async ({ page }) => {
  const webgl = await reference(page, 'webgl', FIRST, LATER), dom = await reference(page, 'dom', FIRST, LATER);
  await open(page, 'webgl', FIRST);
  const linesBefore = await page.evaluate(() => window.terminalBench.screenLines());
  await page.evaluate(() => window.terminalBench.loseContext());
  await page.evaluate(t => window.terminalBench.write(t), LATER);
  await page.waitForFunction(() => window.terminalBench.contextLosses() === 1, null, { timeout: 4 * RESTORE_WINDOW_MS, polling: 50 });
  const fallback = await pixelsEqualWithin(page, dom, 5000);
  const canvasesAfterFallback = await page.evaluate(() => window.terminalBench.canvases());
  const linesAfterFallback = await page.evaluate(() => window.terminalBench.screenLines());
  // The platform may hand the context back after the app gave up on it (an app resumed late): the DOM terminal must not notice.
  await page.evaluate(() => window.terminalBench.restoreContext());
  await page.waitForTimeout(500);
  const lateRestoreKeepsDom = (await screenshot(page)).equals(dom);
  await page.evaluate(() => window.terminalBench.reattach());
  const back = await pixelsEqualWithin(page, webgl, 5000);
  const log = events(await page.evaluate(() => window.terminalBench.contextEvents()));
  const canvasesAfterReattach = await page.evaluate(() => window.terminalBench.canvases());
  results.push({ scenario: 'never restored, then WebGL attached again', loseToAddonGaveUpMs: gap(log, 'lose', 'fallback'), fallbackPixelsIdenticalToDomRenderer: fallback.equal, fallbackToIdenticalPixelsMsUpperBound: fallback.ms, canvasesAfterFallback, lateRestoreKeepsDomPixels: lateRestoreKeepsDom, bufferKeptAcrossFallback: linesAfterFallback.length === linesBefore.length && linesAfterFallback.some(line => line.includes('row 111')), reattachPixelsIdenticalToWebgl: back.equal, reattachToIdenticalPixelsMsUpperBound: back.ms, canvasesAfterReattach, addonGaveUpTotal: await page.evaluate(() => window.terminalBench.contextLosses()) });
  expect(canvasesAfterFallback, 'only the DOM renderer is left').toBe(0);
  expect(fallback.equal, 'the DOM fallback shows the same pixels as a DOM terminal fed the same bytes').toBe(true);
  expect(linesAfterFallback.some(line => line.includes('row 111')), 'the output written while lost is in the buffer').toBe(true);
  expect(lateRestoreKeepsDom, 'a restore after the fallback changes nothing on screen').toBe(true);
  expect(canvasesAfterReattach > 0 && back.equal, 'a new addon draws the same pixels as one that never lost its context').toBe(true);
});

test.afterAll(async () => {
  if (results.length === 0) return;
  const out = process.env.LAZYSH_BENCH_OUT ?? path.resolve(root, `apps/client/bench-results/terminal-webgl-context-loss-${androidSerial ? 'android' : 'desktop'}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    schema: 1, candidate: 'xterm-webgl', run: 'context loss',
    host: { loadAverageAtEnd: os.loadavg(), cpu: os.cpus()[0]?.model, os: `${os.type()} ${os.release()}` },
    toolchain: { node: process.versions.node, xterm: version('@xterm/xterm'), webglAddon: version('@xterm/addon-webgl'), playwright: version('@playwright/test') },
    source: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '').length > 0 },
    androidSerial, launchArgs, restoreWindowMs: RESTORE_WINDOW_MS, context, results,
    limits: `${androidSerial ? 'The Android System WebView of the device with that adb serial' : 'Headless Chromium on a desktop host: not an Android WebView'}, no backgrounding of an app, no GPU process crash; the context is taken away with WEBGL_lose_context. Pixel comparison against a terminal fed the same bytes; times are upper bounds with the resolution of one screenshot unless taken in the page.`
  }, null, 2) + '\n');
});

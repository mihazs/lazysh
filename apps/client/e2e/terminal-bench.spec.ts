import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installNativeBridge } from './fixtures/nativeBridge';
import { medianOf, rng } from '../bench/workloads';

// Baseline benchmark of the current xterm.js pipeline (docs/architecture/terminal-benchmarks.md).
// Smoke mode (default, runs with the e2e suite) uses tiny workloads and asserts only that every workload completes
// correctly and reports finite numbers: it has no timing thresholds. `bun run bench:terminal` sets LAZYSH_BENCH=full.
const full = process.env.LAZYSH_BENCH === 'full';
const scale = full
  ? { runs: 5, plain: 4 << 20, ansi: 2 << 20, frames: 1500, shell: 300, idleMs: 10_000, idleRuns: 3, keys: 200, repeat: 150, scrollLines: 20_000, scrollback: 20_000, defaultScrollback: 5000, fillLines: 5000, sessions: [5, 10] }
  : { runs: 1, plain: 64 << 10, ansi: 32 << 10, frames: 30, shell: 12, idleMs: 300, idleRuns: 1, keys: 6, repeat: 6, scrollLines: 400, scrollback: 300, defaultScrollback: 100, fillLines: 120, sessions: [2] };

test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => !full && isMobile, 'The smoke run needs one viewport.');

const root = path.resolve(import.meta.dirname, '../../..');
const require = createRequire(import.meta.url);
const git = (...args: string[]) => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return null; } };
const read = (file: string) => { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } };

type Snapshot = { metrics: Record<string, number>; cpu: Record<string, number>; rssKiB: number | null };
async function snapshot(cdp: CDPSession, browser: CDPSession): Promise<Snapshot> {
  await cdp.send('HeapProfiler.collectGarbage');
  const metrics = Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
  const cpu: Record<string, number> = {};
  let rssKiB: number | null = null;
  for (const proc of (await browser.send('SystemInfo.getProcessInfo')).processInfo) {
    cpu[proc.type] = (cpu[proc.type] ?? 0) + proc.cpuTime;
    // A spare renderer may exist beside the page's; the page's is the largest.
    if (proc.type === 'renderer') rssKiB = Math.max(rssKiB ?? 0, Number(/VmRSS:\s+(\d+)/.exec(read(`/proc/${proc.id}/status`) ?? '')?.[1]) || 0) || null;
  }
  return { metrics, cpu, rssKiB };
}
const ms = (after: number, before: number) => (after - before) * 1000;
function cost(before: Snapshot, after: Snapshot) {
  const d = (name: string) => ms(after.metrics[name], before.metrics[name]);
  return {
    mainThreadMs: { task: d('TaskDuration'), script: d('ScriptDuration'), layout: d('LayoutDuration'), styleRecalc: d('RecalcStyleDuration') },
    layouts: after.metrics.LayoutCount - before.metrics.LayoutCount,
    styleRecalcs: after.metrics.RecalcStyleCount - before.metrics.RecalcStyleCount,
    processCpuMs: Object.fromEntries(Object.keys(after.cpu).map(type => [type, ms(after.cpu[type], before.cpu[type] ?? 0)])),
    heapUsedMiB: after.metrics.JSHeapUsedSize / 1048576, heapDeltaMiB: (after.metrics.JSHeapUsedSize - before.metrics.JSHeapUsedSize) / 1048576,
    domNodes: after.metrics.Nodes, rendererRssMiB: after.rssKiB === null ? null : after.rssKiB / 1024,
  };
}

type Result = { workload: string; title: string; variant: string | null; runs: unknown[]; median: unknown; correct: boolean; notes?: string };
const results: Result[] = [];

test.beforeEach(async ({ page }) => {
  await installNativeBridge(page, { reason: 'Synthetic benchmark fixture.', generation: '1' });
  await page.addInitScript(() => { window.nativeFixtureInvoke = async command => (command.startsWith('plugin:event|') ? 1 : undefined); });
});

let geometry: Awaited<ReturnType<Page['evaluate']>> & Record<string, unknown> = {};
let fixtures: Record<string, unknown> = {};

test('terminal baseline', async ({ page, browser, browserName }, info) => {
  const atStart = os.loadavg();
  test.skip(browserName !== 'chromium', 'CDP process metrics need Chromium.');
  await page.goto('/bench/terminal-bench.html');
  await page.waitForFunction(() => !!window.terminalBench);
  const cdp = await page.context().newCDPSession(page), browserCdp = await browser.newBrowserCDPSession();
  await cdp.send('Performance.enable');
  geometry = await page.evaluate(() => window.terminalBench.open());
  await expect(page.locator('.terminal-canvas .xterm-screen')).toBeVisible();
  if (full) expect(geometry.build, 'Release builds only: run through bun run bench:terminal').toBe('production');
  const nominal = await page.evaluate(() => window.terminalBench.calibrate());

  /** Runs `body` once per run with CDP counters around it; `runs` entries plus their median. */
  async function workload(id: string, title: string, runs: number, body: () => Promise<Record<string, unknown> & { correct: boolean }>, variant?: string, notes?: string) {
    const collected: Array<Record<string, unknown>> = [];
    for (let run = 0; run < runs; run++) {
      const before = await snapshot(cdp, browserCdp), started = performance.now();
      const metrics = await body();
      const windowMs = performance.now() - started;
      const after = await snapshot(cdp, browserCdp);
      collected.push({ ...metrics, cost: { windowMs, ...cost(before, after) } });
    }
    const correct = collected.every(entry => entry.correct === true);
    results.push({ workload: id, title, variant: variant ?? null, runs: collected, median: medianOf(collected as never), correct, notes });
    if (!correct) console.log(JSON.stringify(collected.map(({ cost: _, ...rest }) => rest)));
    expect(correct, `${id}${variant ? ` ${variant}` : ''} must end on the expected screen`).toBe(true);
    // A missing number is recorded as null by the harness, never zero: reject NaN/Infinity in what was measured.
    expect(JSON.stringify(collected), 'metrics must be finite').not.toMatch(/NaN|Infinity/);
  }
  const streamed = (kind: 'plain' | 'ansi' | 'redraw', size: number) => async () => {
    const prep = await page.evaluate(([k, s]) => window.terminalBench.prepare(k, s), [kind, size] as const);
    fixtures[kind] = { bytes: prep.bytes, chunks: prep.chunks, sha256: prep.sha256, description: prep.description };
    return () => page.evaluate(() => window.terminalBench.stream());
  };

  for (const blink of [true, false])
    await workload('W0', 'Idle, session open, no output', scale.idleRuns, () => page.evaluate(([duration, b]) => window.terminalBench.idle(duration, b), [scale.idleMs, blink] as const), blink ? 'cursor blink on, focused' : 'cursor blink off, focused');
  await workload('W1', 'Small shell output (prompt, short commands)', scale.runs, () => page.evaluate(n => window.terminalBench.shell(n), scale.shell));
  for (const [id, title, kind, size] of [['W2', 'Sustained plain text', 'plain', scale.plain], ['W3', 'ANSI color heavy output', 'ansi', scale.ansi], ['W4', 'Cursor movement and full-screen redraw', 'redraw', scale.frames]] as const) {
    const run = await streamed(kind, size)();
    await workload(id, title, scale.runs, run);
  }

  // W12: real keyboard events through the page's input path, with the remote echoing at once.
  // Seeded jitter keeps keystrokes from phase-locking to the 60 Hz frame clock, which would pin every sample to one point of the frame.
  const jitter = rng(12);
  const press = async (count: number, pace: 'echo' | 'repeat') => {
    await page.evaluate(() => window.terminalBench.inputBegin('keydown'));
    for (let i = 0; i < count; i++) {
      const key = 'abcdefghij'[i % 10];
      if (pace === 'repeat') { await page.keyboard.down(key); await page.waitForTimeout(25 + jitter() * 16); } else { await page.keyboard.press(key); await page.waitForFunction(n => window.terminalBench.progress().echoed > n, i, { polling: 2 }); await page.waitForTimeout(jitter() * 34); }
    }
    if (pace === 'repeat') await page.keyboard.up('j');
    return page.evaluate(n => window.terminalBench.inputEnd(n), count);
  };
  await workload('W12', 'Keyboard input, one key at a time', scale.runs, () => press(scale.keys, 'echo'), 'idle terminal');
  await workload('W12', 'Keyboard auto-repeat, about 30 Hz with jitter', scale.runs, () => press(scale.repeat, 'repeat'), 'idle terminal');
  await streamed('plain', scale.plain)();
  await workload('W12', 'Keyboard input during sustained output', scale.runs, async () => {
    await page.evaluate(() => window.terminalBench.startFlood());
    const metrics = await press(scale.keys, 'echo');
    const flood = await page.evaluate(() => window.terminalBench.stopFlood());
    return { ...metrics, floodBytes: flood.bytes };
  }, 'visible terminal flooded with W2 text; echo queues behind it', 'The echo shares the write queue with the flood: head-of-line delay of a remote that answers instantly.');

  // W12 composition: Chromium's IME protocol commits a composed word.
  await workload('W12', 'IME composition commit', scale.runs, async () => {
    await page.evaluate(() => window.terminalBench.inputBegin('composition'));
    const words = Array.from({ length: Math.max(3, Math.floor(scale.keys / 4)) }, (_, i) => `word${i}`);
    for (const word of words) {
      await cdp.send('Input.imeSetComposition', { text: word, selectionStart: word.length, selectionEnd: word.length });
      await cdp.send('Input.insertText', { text: word });
    }
    return page.evaluate(n => window.terminalBench.inputEnd(n), words.length);
  }, 'CDP imeSetComposition + insertText', 'Latency is compositionend timestamp to the render showing the commit; correct means one remote write per commit, none duplicated.');

  // W10: scrollback at the app default and at the configured maximum (20000).
  for (const scrollback of [scale.defaultScrollback, scale.scrollback])
    await workload('W10', 'Large scrollback', scale.runs, () => page.evaluate(([lines, limit]) => window.terminalBench.scrollCost(lines, limit), [scale.scrollLines, scrollback] as const), `scrollback ${scrollback} lines`);

  // W9: memory per session and typing in the visible one while the others stream.
  await streamed('plain', scale.plain)();
  for (const count of scale.sessions) {
    await page.evaluate(() => window.terminalBench.disposeSessions());
    await page.evaluate(() => window.terminalBench.sessions(1, 1)); // visible terminal cleared and settled
    const before = await snapshot(cdp, browserCdp);
    const filled = await page.evaluate(([n, lines]) => window.terminalBench.sessions(n, lines), [count, scale.fillLines] as const);
    const after = await snapshot(cdp, browserCdp);
    const perSessionHeapMiB = (after.metrics.JSHeapUsedSize - before.metrics.JSHeapUsedSize) / 1048576 / count;
    const perSessionRssMiB = before.rssKiB === null || after.rssKiB === null ? null : (after.rssKiB - before.rssKiB) / 1024 / count;
    await workload('W9', `${count} simultaneous sessions`, scale.runs, async () => {
      await page.evaluate(n => window.terminalBench.startBackground(n), count - 1);
      const typing = await press(scale.keys, 'echo');
      await page.evaluate(() => window.terminalBench.stopBackground());
      return { ...typing, sessions: filled.sessions, linesPerSession: filled.linesPerSession, perSessionHeapMiB, perSessionRssMiB, correct: typing.correct && filled.correct };
    }, `${count} sessions, ${scale.fillLines} lines each, others streaming`, 'Background sessions are opened xterm terminals in display:none panes, as App.tsx keeps inactive sessions; per-session figures are the JS-heap and resident-set growth after forced GC divided by sessions; xterm keeps its cell buffers in typed arrays, so RSS is the figure that includes them.');
  }
  await page.evaluate(() => window.terminalBench.disposeSessions());

  const loadAfter = os.loadavg();
  const environment = {
    schema: 1,
    candidate: 'xterm-dom',
    mode: full ? 'full' : 'smoke',
    host: { loadAverage: { atStart, atEnd: loadAfter }, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramGiB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}`, arch: os.arch(), cpuGovernor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor') },
    toolchain: { bun: (() => { try { return execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; } })(), node: process.versions.node, playwright: JSON.parse(readFileSync(require.resolve('@playwright/test/package.json'), 'utf8')).version, chromium: browser.version(), headless: true, xterm: JSON.parse(readFileSync(require.resolve('@xterm/xterm/package.json'), 'utf8')).version },
    source: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '').length > 0 },
    page: { project: info.project.name, ...geometry, refreshNominalMs: nominal },
    fixtures,
    limits: 'Headless Chromium on a desktop host: not an Android WebView. No GPU, battery or thermal counters.',
  };
  const document = { ...environment, results };
  const out = process.env.LAZYSH_BENCH_OUT ?? path.resolve(root, `apps/client/bench-results/${full ? 'terminal-baseline' : 'terminal-smoke'}-${info.project.name}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  await info.attach('terminal-benchmark.json', { path: out });
  expect(results.length).toBeGreaterThan(8);
});

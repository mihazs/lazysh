import { expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { androidDevice, androidFocused, androidSerial, benchUrl, cost, git, installBenchBridge, read, require, root, snapshot, test } from './fixtures/benchEnvironment';
import { selfTimeByFunction, type CpuProfile } from '../bench/cpuProfile';
import { summarize, type StyleFamily } from '../bench/workloads';

// What the first appearance of a glyph in a style costs, with the xterm.js DOM renderer and the WebGL addon (#1323,
// docs/architecture/terminal-benchmarks.md). The renderer shootout found that the first ANSI-heavy run on a page with the
// WebGL addon took seconds and later runs of the same bytes did not. Here the same bytes are streamed several times on a fresh
// page, with a chosen number of distinct styles of one family: the cold pass minus the warm passes, divided by the number of
// (style, character) pairs a glyph cache must draw once, says whether the stall follows the bytes or the pairs.
// Smoke mode (default, runs with the e2e suite) uses tiny workloads and asserts completion and correctness, never timing.
const full = process.env.LAZYSH_BENCH === 'full';
const renderers = ['dom', 'webgl'] as const;
/** `paced` waits for a frame after every 16 KiB chunk, so each chunk is rendered; unpaced, the page parses ahead and renders a few times per pass. For `w3` the second element is the size in MiB: the W3 workload of the baseline harness (a random SGR style per word, the families mixed), on a fresh page. */
type Row = readonly [family: StyleFamily | 'w3', styles: number, paced?: boolean];
const scale: { bytes: number; passes: number; rows: Row[] } = full
  ? { bytes: 1 << 20, passes: 3, rows: [['truecolor', 1], ['truecolor', 32], ['truecolor', 256], ['truecolor', 2048], ['indexed', 256], ['background', 256], ['background', 2048], ['attributes', 8], ['attributes', 256], ['palette16', 8], ['brightOnBackground', 64], ['truecolorOnBackground', 256], ['boldUnderline', 8],
    ['w3', 0.5], ['w3', 1], ['w3', 2], ['w3', 4], ['truecolor', 1, true], ['truecolor', 256, true], ['truecolor', 2048, true], ['w3', 1, true], ['w3', 2, true]] }
  : { bytes: 64 << 10, passes: 2, rows: [['truecolor', 1], ['attributes', 8], ['w3', 1 / 32], ['truecolor', 32, true]] };
// LAZYSH_BENCH_PROFILE=1 samples the page's main thread during the cold pass (Profiler domain, 1 ms) and records the largest self times next to it. Sampling slows that pass, so a profiled run is a separate invocation and its timings are not comparable with the unprofiled files.
const profiling = process.env.LAZYSH_BENCH_PROFILE === '1' && !androidSerial;
const launchArgs = (process.env.LAZYSH_BENCH_CHROMIUM_ARGS ?? '').split(/\s+/).filter(Boolean);
test.use({ launchOptions: { args: launchArgs } });
test.describe.configure({ mode: 'serial' });
test.skip(({ isMobile }) => !full && isMobile, 'The smoke run needs one viewport.');

const results: Array<Record<string, unknown>> = [];
test.beforeEach(async ({ page }) => {
  await installBenchBridge(page);
});

for (const renderer of renderers)
  for (const [family, styles, paced = false] of scale.rows)
    test(`${renderer}: ${family === 'w3' ? `the W3 workload, ${styles} MiB` : `${styles} ${family} styles`}${paced ? ', one frame per chunk' : ''}, cold pass against warm passes`, async ({ page, baseURL }, info) => {
      test.setTimeout(androidSerial ? 2 * 60_000 : full ? 10 * 60_000 : 60_000);
      await page.goto('about:blank');
      test.skip(renderer === 'webgl' && !(await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'))), 'The browser has no WebGL2.');
      await page.goto(benchUrl(baseURL, `renderer=${renderer}`));
      await page.waitForFunction(() => !!window.terminalBench);
      const cdp = await page.context().newCDPSession(page), browserCdp = androidSerial ? null : await page.context().browser()!.newBrowserCDPSession();
      await cdp.send('Performance.enable');
      const geometry = await page.evaluate(() => window.terminalBench.open());
      expect(geometry.canvases > 0, `renderer ${renderer} must be drawing`).toBe(renderer === 'webgl');
      const refreshNominalMs = await page.evaluate(() => window.terminalBench.calibrate());
      const fixture = family === 'w3'
        ? { ...(await page.evaluate(size => window.terminalBench.prepare('ansi', size), styles * (1 << 20))), distinctGlyphs: null }
        : await page.evaluate(([name, n, bytes]) => window.terminalBench.prepareStyled(name, n, bytes), [family, styles, scale.bytes] as const);

      const passes: Array<Record<string, unknown> & { wallMs: number; totalCpuMs: number | null }> = [];
      let coldProfile: ReturnType<typeof selfTimeByFunction> | null = null;
      if (profiling) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 1000 }); }
      for (let pass = 1; pass <= scale.passes; pass++) {
        const before = await snapshot(cdp, browserCdp);
        if (profiling && pass === 1) await cdp.send('Profiler.start');
        const run = await page.evaluate(wait => window.terminalBench.stream(wait), paced);
        if (profiling && pass === 1) { coldProfile = selfTimeByFunction((await cdp.send('Profiler.stop')).profile as CpuProfile); expect(coldProfile.top.length, 'the profiler must have sampled the cold pass').toBeGreaterThan(0); }
        const spent = cost(before, await snapshot(cdp, browserCdp));
        const cpus = Object.values(spent.processCpuMs), totalCpuMs = cpus.length ? cpus.reduce((a, b) => a + b, 0) : null;
        passes.push({ pass, renders: run.renders, wallMsPerRender: run.wallMs / Math.max(1, run.renders), wallMs: run.wallMs, throughputMiBs: run.throughputMiBs, totalCpuMs, mainThreadTaskMs: spent.mainThreadMs.task, rendererCpuMs: spent.processCpuMs.renderer ?? null, gpuCpuMs: spent.processCpuMs.GPU ?? null, droppedFrames: run.pacing.dropped, frameP99Ms: run.pacing.frameMs?.p99 ?? null, longTasks: run.longTasks, correct: run.correct });
        expect(run.correct, `pass ${pass} must end on the expected screen`).toBe(true);
        expect(androidFocused(), 'the WebView host lost the window focus: the run is disturbed').toBe(true);
      }
      expect(await page.evaluate(() => window.terminalBench.contextLosses()), 'a lost WebGL context falls back to the DOM renderer and invalidates the run').toBe(0);
      const warm = passes.slice(1), warmWall = summarize(warm.map(p => p.wallMs))!.p50, warmCpu = passes[0].totalCpuMs === null ? null : summarize(warm.map(p => p.totalCpuMs!))!.p50;
      const extraWallMs = passes[0].wallMs - warmWall, extraCpuMs = passes[0].totalCpuMs === null || warmCpu === null ? null : passes[0].totalCpuMs - warmCpu;
      results.push({ renderer, family, styles, paced, profiled: profiling, coldProfile, bytes: fixture.bytes, distinctGlyphs: fixture.distinctGlyphs, sha256: fixture.sha256, passes, warmWallMs: warmWall, coldExtraWallMs: extraWallMs, coldExtraCpuMs: extraCpuMs, coldExtraWallMsPerGlyph: fixture.distinctGlyphs && extraWallMs / fixture.distinctGlyphs, coldExtraCpuMsPerGlyph: fixture.distinctGlyphs && extraCpuMs !== null ? extraCpuMs / fixture.distinctGlyphs : null, refreshNominalMs, geometry: { cols: geometry.cols, rows: geometry.rows, gl: geometry.gl, devicePixelRatio: geometry.devicePixelRatio, viewport: geometry.viewport, userAgent: geometry.userAgent }, project: info.project.name });
    });

test.afterAll(async ({ browser }, info) => {
  if (results.length === 0) return;
  const out = process.env.LAZYSH_BENCH_OUT ?? path.resolve(root, `apps/client/bench-results/terminal-first-burst-${full ? 'full' : 'smoke'}-${androidSerial ? 'android' : info.project.name}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({
    schema: 1, run: 'first burst', mode: full ? 'full' : 'smoke',
    host: { loadAverageAtEnd: os.loadavg(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, os: `${os.type()} ${os.release()}`, cpuGovernor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor') },
    toolchain: { node: process.versions.node, chromium: androidSerial ? null : browser.version(), androidSerial, device: androidDevice(), xterm: JSON.parse(read(require.resolve('@xterm/xterm/package.json')) ?? '{}').version, webglAddon: JSON.parse(read(require.resolve('@xterm/addon-webgl/package.json')) ?? '{}').version },
    source: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '').length > 0 },
    launchArgs, results,
    limits: `${androidSerial ? 'The Android System WebView of the device with that adb serial, in a fresh process per row; no per-process CPU (the WebView has no process list).' : 'Headless Chromium on a desktop host: not an Android WebView.'} A fresh page per row; pass 1 is cold (nothing drawn yet), later passes replay the same bytes. Per-glyph figures divide the cold excess by the distinct (style, character) pairs of the stream, a count of what a glyph cache must draw, not of what the addon actually cached.`,
  }, null, 2) + '\n');
});

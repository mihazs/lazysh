import { expect } from '@playwright/test';
import os from 'node:os';
import { androidDevice, androidFocused, androidSerial, benchUrl, cost, git, read, require, setUpBenchSpec, snapshot, test, writeBenchResult } from './fixtures/benchEnvironment';
import { programWorkloads } from '../bench/programWorkloads';

// W5 to W8 and W11 of docs/architecture/terminal-benchmarks.md on the xterm.js pipeline: recorded vim, tmux, Zellij, Mosh and agent
// sessions replayed a step at a time (`terminalBench.replay`), and a hidden session that takes output, resumes and gets its surface
// recreated (`terminalBench.background`). The native core replays the same workloads in packages/terminal-runtime/examples/program_workloads.rs.
// Smoke mode (default, runs with the e2e suite) uses a few repetitions and asserts completion and correctness, never timing.
// With LAZYSH_BENCH_ANDROID the page is the benchmark page in that device's Android System WebView (the Waydroid lane, docs/architecture/waydroid-lane.md).
const full = process.env.LAZYSH_BENCH === 'full';
/** Fresh sessions per workload: 100 for a few steps, fewer for a long stream so that about 600 steps are replayed (each is paced to a frame). */
const repsFor = (steps: number) => full ? Math.max(5, Math.min(100, Math.floor(600 / steps))) : 2;
/** Deliveries of the W11 stream while its pane is hidden: about 2 MiB of Herdr redraws, a few minutes of an active multiplexer. */
const copies = full ? 40 : 2;
const candidate = process.env.LAZYSH_BENCH_RENDERER ?? 'dom';
const workloads = programWorkloads({ agentTokens: full ? 300 : 60 });
const launchArgs = setUpBenchSpec(full);

const results: Array<Record<string, unknown>> = [];

for (const workload of workloads)
  test(`${workload.id} ${workload.title}: ${workload.variant}`, async ({ page, baseURL }) => {
    test.setTimeout(androidSerial ? 5 * 60_000 : full ? 10 * 60_000 : 60_000);
    await page.goto('about:blank');
    await page.goto(benchUrl(baseURL, `renderer=${candidate}`));
    await page.waitForFunction(() => !!window.terminalBench);
    const cdp = await page.context().newCDPSession(page), browserCdp = androidSerial ? null : await page.context().browser()!.newBrowserCDPSession();
    await cdp.send('Performance.enable');
    const refreshNominalMs = await page.evaluate(() => window.terminalBench.calibrate());
    const before = await snapshot(cdp, browserCdp), started = performance.now();
    const reps = repsFor(workload.steps.length);
    const run = workload.id === 'W11'
      ? await page.evaluate(([replay, n, deliveries]) => window.terminalBench.background(replay, n, deliveries), [workload, reps, copies] as const)
      : await page.evaluate(([replay, n]) => window.terminalBench.replay(replay, n), [workload, reps] as const);
    const windowMs = performance.now() - started, spent = cost(before, await snapshot(cdp, browserCdp));
    expect(run.correct, 'every repetition must end on the recorded screen').toBe(true);
    // A missing number is recorded as null by the harness, never zero: reject NaN and Infinity in what was measured.
    expect(JSON.stringify(run), 'metrics must be finite').not.toMatch(/NaN|Infinity/);
    expect(androidFocused(), 'the WebView host lost the window focus: the run is disturbed').toBe(true);
    const { steps, checks: _checks, ...described } = workload;
    results.push({ ...described, steps: steps.length, refreshNominalMs, reps, copies: workload.id === 'W11' ? copies : 1, run, cost: { windowMs, ...spent } });
  });

test.afterAll(async ({ browser }, info) => {
  if (results.length === 0) return;
  writeBenchResult('terminal-programs', full, info.project.name, {
    schema: 1, run: 'program workloads', candidate: `xterm-${candidate}`, mode: full ? 'full' : 'smoke',
    host: { loadAverageAtEnd: os.loadavg(), cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, os: `${os.type()} ${os.release()}`, cpuGovernor: read('/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor') },
    toolchain: { node: process.versions.node, chromium: androidSerial ? null : browser.version(), androidSerial, device: androidDevice(), xterm: JSON.parse(read(require.resolve('@xterm/xterm/package.json')) ?? '{}').version },
    source: { commit: git('rev-parse', 'HEAD'), dirty: (git('status', '--porcelain') ?? '').length > 0 },
    launchArgs,
    limits: `${androidSerial ? 'The Android System WebView of the device with that adb serial, in a fresh process per workload; no per-process CPU (the WebView has no process list).' : 'Headless Chromium on a desktop host: not an Android WebView.'} Each repetition is a fresh session at the recorded geometry; its creation is not timed. Timestamps have 0.1 ms resolution. The recorded sessions are short first-run and scripted screens, not signed-in agent turns, and Neovim was not recorded. No battery or thermal counters.`,
    results,
  });
});

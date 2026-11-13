import {expect, test, type CDPSession, type Page} from '@playwright/test';
import {mkdirSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {medianOf} from '../bench/workloads';

// Agent view load benchmark (docs/reference/agent-view-performance.md): the real AgentView in a production build, a modelled SSH host,
// CDP CPU throttling. `bun run bench:agent-view` (LAZYSH_BENCH=agent-view) prints one JSON result per scenario and writes them when
// LAZYSH_BENCH_OUT is set. Smoke mode (default, runs with the e2e suite on the dev server) opens one scenario once and has no timing thresholds.
const full = process.env.LAZYSH_BENCH === 'agent-view';
test.describe.configure({mode: 'serial'});
test.skip(({isMobile}) => !full && isMobile, 'The smoke run needs one viewport.');
const runs = full ? Number(process.env.LAZYSH_BENCH_RUNS ?? 3) : 1;
/** One SSH exec costs about two round trips (measured against a private OpenSSH behind a delay proxy: 5, 67 and 168 ms at 0, 30 and 80 ms RTT). */
const links = {local: 8, lan: 70, mobile: 172} as const;
const throttles = {x1: 1, x4: 4} as const;

type Metrics = Record<string, number>;
const metrics = async (cdp: CDPSession): Promise<Metrics> => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
const ms = (after: Metrics, before: Metrics, name: string) => (after[name] - before[name]) * 1000;
const percentile = (values: number[], p: number) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))] : null;

type Scenario = {name: string; link: keyof typeof links; throttle: keyof typeof throttles; page: 'typical' | 'heavy'; stream: boolean; mode?: 'tmux' | 'herdr'; hostMs?: number; execs?: Record<string, number>};
const everyScenario: Scenario[] = [
  {name: 'tmux open, local link', link: 'local', throttle: 'x1', page: 'typical', stream: true},
  {name: 'tmux open, LAN (30 ms RTT)', link: 'lan', throttle: 'x1', page: 'typical', stream: true},
  {name: 'tmux open, mobile (80 ms RTT)', link: 'mobile', throttle: 'x1', page: 'typical', stream: true},
  {name: 'tmux open, LAN, 4x CPU', link: 'lan', throttle: 'x4', page: 'typical', stream: true},
  {name: 'tmux open, mobile, 4x CPU', link: 'mobile', throttle: 'x4', page: 'typical', stream: true},
  {name: 'tmux open, LAN, 4x CPU, heavy page', link: 'lan', throttle: 'x4', page: 'heavy', stream: true},
  {name: 'tmux open, LAN, old companion (polling)', link: 'lan', throttle: 'x1', page: 'typical', stream: false},
  {name: 'herdr open, local link', link: 'local', throttle: 'x1', page: 'typical', stream: true, mode: 'herdr'},
  {name: 'herdr open, LAN (30 ms RTT)', link: 'lan', throttle: 'x1', page: 'typical', stream: true, mode: 'herdr'},
  {name: 'herdr open, mobile (80 ms RTT)', link: 'mobile', throttle: 'x1', page: 'typical', stream: true, mode: 'herdr'},
  {name: 'herdr open, mobile, 4x CPU', link: 'mobile', throttle: 'x4', page: 'typical', stream: true, mode: 'herdr'},
];

const scenarios = full ? everyScenario : everyScenario.slice(0, 1);
const results: unknown[] = [];
test.afterAll(() => {
  const out = process.env.LAZYSH_BENCH_OUT;
  if (!out) return;
  mkdirSync(path.dirname(out), {recursive: true});
  writeFileSync(out, JSON.stringify({schema: 1, host: {cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, ramGiB: Math.round(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}`}, results}, null, 2));
});

async function run(page: Page, scenario: Scenario) {
  await page.goto('/bench/agent-view-bench.html');
  // The dev server may reload the page once while it optimises dependencies for the first time.
  await page.waitForLoadState('networkidle');
  await page.waitForFunction(() => !!window.agentBench);
  if (full) expect(await page.evaluate(() => window.agentBench.build), 'Release builds only: run through bun run bench:agent-view').toBe('production');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: throttles[scenario.throttle]});
  const before = await metrics(cdp);
  const profile = process.env.LAZYSH_BENCH_PROFILE;
  if (profile) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', {interval: 200}); await cdp.send('Profiler.start'); }
  const opened = await page.evaluate(model => window.agentBench.open(model), {execMs: links[scenario.link], page: scenario.page, stream: scenario.stream, mode: scenario.mode ?? 'tmux', ...(scenario.hostMs === undefined ? {} : {hostMs: scenario.hostMs})});
  const after = await metrics(cdp);
  if (profile) {
    const {profile: cpu} = await cdp.send('Profiler.stop');
    mkdirSync(profile, {recursive: true});
    writeFileSync(path.join(profile, `${scenario.name.replace(/\W+/g, '-')}.cpuprofile`), JSON.stringify(cpu));
  }
  const scrolled = await page.evaluate(() => window.agentBench.scroll());
  const streamed = scenario.stream ? await page.evaluate(() => window.agentBench.stream()) : undefined;
  await cdp.send('Emulation.setCPUThrottlingRate', {rate: 1});
  const tasks = opened.longTasks.map(task => task.duration);
  return {
    firstContentMs: opened.firstContentMs, bubbles: opened.bubbles, domNodes: opened.domNodes, domAtFirst: opened.domAtFirst,
    calls: opened.calls.map(call => `${call.command}@${call.start.toFixed(0)}-${call.end.toFixed(0)}`),
    callCounts: opened.calls.reduce<Record<string, number>>((all, call) => ({...all, [call.command]: (all[call.command] ?? 0) + 1}), {}),
    loadLongTasks: {n: tasks.length, maxMs: Math.max(0, ...tasks), totalMs: tasks.reduce((a, b) => a + b, 0)},
    loadCommits: {n: opened.commits.length, actualMs: opened.commits.reduce((sum, commit) => sum + commit.actual, 0), maxMs: Math.max(0, ...opened.commits.map(commit => commit.actual)),
      mounts: opened.commits.filter(commit => commit.phase === 'mount').length},
    loadMainThreadMs: {script: ms(after, before, 'ScriptDuration'), layout: ms(after, before, 'LayoutDuration'), style: ms(after, before, 'RecalcStyleDuration'), task: ms(after, before, 'TaskDuration')},
    scroll: {frameP50: percentile(scrolled.intervals, 0.5), frameP95: percentile(scrolled.intervals, 0.95), over33: scrolled.intervals.filter(value => value > 33.4).length, frames: scrolled.intervals.length, longTasksMax: Math.max(0, ...scrolled.longTasks), scrollHeight: scrolled.scrollHeight},
    stream: streamed && {deltaP50: percentile(streamed.latencies, 0.5), deltaP95: percentile(streamed.latencies, 0.95), commits: streamed.commits, commitActualP50: percentile(streamed.actualMs, 0.5), longTasksMax: Math.max(0, ...streamed.longTasks)},
  };
}

for (const scenario of scenarios) {
  test(scenario.name, async ({page, browserName}, info) => {
    test.skip(browserName !== 'chromium', 'CDP throttling needs Chromium.');
    const all = [];
    for (let index = 0; index < runs; index++) all.push(await run(page, scenario));
    const median = medianOf(all.map(item => item.firstContentMs)) as number;
    const result = {scenario: scenario.name, project: info.project.name, medianFirstContentMs: median, runs: all};
    console.log(JSON.stringify({scenario: scenario.name, project: info.project.name, medianFirstContentMs: Math.round(median), run0: {...all[0], calls: undefined}}));
    results.push(result);
  });
}

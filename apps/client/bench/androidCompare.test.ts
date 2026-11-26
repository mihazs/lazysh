import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { compareRecords, exitCode, RecordError, renderVerdict } from './androidCompare';
import { perRun, perRunSummaries, type Arm, type EvidenceRecord, type Measurement, type MetricId } from './androidEvidence';

type Spec = { workload?: string; variant?: string | null; metric: MetricId; values: number[]; p95?: number; correct?: boolean };
/** A measurement whose p50 is the median of `values`; a sampled metric takes `p95` as every run's own p95. */
function measure(adapter: string, { workload = 'W12', variant = null, metric, values, p95, correct = true }: Spec): Measurement {
  const base = { adapter, workload, variant, metric, correct };
  return (p95 === undefined ? perRun(base, values) : perRunSummaries(base, values.map(p50 => ({ p50, p95, n: 100 }))))!;
}
const stream = { cols: 49, rows: 15, fixtures: { W2: 'a'.repeat(64), W3: 'b'.repeat(64), W4: 'c'.repeat(64) } };
const arm = (adapter: string, host = 'bench host'): Arm => ({ adapter, engine: adapter, host, gpu: null, page: null, notes: '', stream });
const record = (arms: Arm[], measurements: Measurement[], overrides: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  schema: 1, kind: 'android-engine-comparison', runId: 'engine-20261122T200000Z', label: null, startedAt: '', finishedAt: '', source: { commit: null, dirty: null },
  environment: { device: { serial: '192.168.240.112:5555' } }, limits: '', acceptedRisk: [], arms, measurements, ...overrides,
});

/** Every metric of every target, at the same value for both engines unless `better` or `worse` names it: a tie everywhere. */
const FLOOD = 'keys-during-output';
const tie: Spec[] = [
  { workload: 'W12', variant: 'keys-idle', metric: 'inputLatencyMs', values: [10, 10, 10], p95: 20 },
  { workload: 'W12', variant: FLOOD, metric: 'inputLatencyMs', values: [30, 30, 30], p95: 60 },
  { workload: 'W2', variant: null, metric: 'throughputMiBs', values: [20, 20, 20] },
  { workload: 'W2', variant: null, metric: 'cpuMsPerMiB', values: [100, 100, 100] },
  { workload: 'W0', variant: 'blink-on', metric: 'idleCpuMsPerSecond', values: [50, 50, 50] },
  { workload: 'W9', variant: 'sessions-5', metric: 'pssGrowthMiB', values: [80, 80, 80] },
  { workload: 'W9', variant: 'sessions-10', metric: 'pssGrowthMiB', values: [160, 160, 160] },
  ...['repeat-idle', 'ime-commit'].map(variant => ({ workload: 'W12', variant, metric: 'inputLatencyMs' as const, values: [10, 10, 10], p95: 20 })),
  { workload: 'W12', variant: FLOOD, metric: 'jankyFramePercent', values: [1, 1, 1] },
  { workload: 'W1', metric: 'outputLatencyMs', values: [10, 10, 10], p95: 20 },
  ...['W3', 'W4'].flatMap(workload => [
    { workload, metric: 'throughputMiBs' as const, values: [20, 20, 20] },
    { workload, metric: 'cpuMsPerMiB' as const, values: [100, 100, 100] },
  ]),
  ...['blink-on', 'blink-off'].flatMap(variant => [
    { workload: 'W0', variant, metric: 'idleWakeupsPerSecond' as const, values: [10, 10, 10] },
    { workload: 'W0', variant, metric: 'idleFramesPerSecond' as const, values: [2, 2, 2] },
  ]),
  { workload: 'W0', variant: 'blink-off', metric: 'idleCpuMsPerSecond', values: [50, 50, 50] },
  ...['sessions-5', 'sessions-10'].flatMap(variant => [
    { workload: 'W9', variant, metric: 'inputLatencyMs' as const, values: [30, 30, 30], p95: 60 },
    { workload: 'W9', variant, metric: 'jankyFramePercent' as const, values: [1, 1, 1] },
    { workload: 'W9', variant, metric: 'pssMiB' as const, values: [300, 300, 300] },
  ]),
  { workload: 'W9', variant: 'churn', metric: 'pssChurnDriftMiB', values: [1] },
];
/** The xterm.js side is `tie`; native is `tie` with the given figures replaced (matched by workload, variant, metric). */
function run(changes: Array<Partial<Spec> & Pick<Spec, 'metric'>> = [], { natives = tie, extra = [] as Measurement[], hosts = ['bench host', 'bench host'] } = {}) {
  const swap = (spec: Spec) => ({ ...spec, ...changes.find(c => c.metric === spec.metric && (c.variant === undefined || c.variant === spec.variant) && (c.workload === undefined || c.workload === spec.workload)) });
  return compareRecords([
    record([arm('xterm-dom', hosts[0])], tie.map(spec => measure('xterm-dom', spec))),
    record([arm('native-wgpu', hosts[1])], [...natives.map(spec => measure('native-wgpu', swap(spec))), ...extra]),
  ]);
}
const target = (verdict: ReturnType<typeof run>, id: string) => verdict.targets.find(t => t.id === id)!;
const outcomes = (verdict: ReturnType<typeof run>) => Object.fromEntries(verdict.targets.map(t => [t.id, t.outcome]));

describe('deciding the provisional targets', () => {
  it('meets every target when native is 40% better on a key latency and no worse anywhere', () => {
    const verdict = run([{ metric: 'inputLatencyMs', variant: 'keys-idle', values: [6, 6, 6], p95: 12 }]);
    expect(verdict.status).toBe('targets met');
    expect(exitCode(verdict)).toBe(0);
    expect(outcomes(verdict)).toEqual({ 'no-correctness-regression': 'met', 'input-latency-under-heavy-output': 'met', 'no-material-regression': 'met', 'key-improvement': 'met', 'idle-near-zero': 'met', 'memory-not-worse': 'met' });
    expect(target(verdict, 'key-improvement').evidence[0]).toMatch(/W12 keys-idle inputLatencyMs p50: xterm-dom 10.00 ms, native 6.00 \(\+40% better/);
  });

  it('requires matching stream fixtures and terminal grids before comparing throughput', () => {
    const throughput: Spec = { workload: 'W2', metric: 'throughputMiBs', values: [20, 20, 20] };
    const xterm = record([arm('xterm-dom')], [measure('xterm-dom', throughput)]);
    const native = (metadata?: typeof stream) =>
      record([{ ...arm('native-wgpu'), stream: metadata }], [measure('native-wgpu', throughput)]);

    expect(compareRecords([xterm, native(stream)]).rows).toHaveLength(1);
    expect(() => compareRecords([xterm, native({ ...stream, rows: 26 })])).toThrow('different terminal grids');
    expect(() => compareRecords([xterm, native({ ...stream, fixtures: { W2: 'b'.repeat(64) } })])).toThrow('different fixture hashes');
    expect(() => compareRecords([xterm, native()])).toThrow('missing stream fixture metadata');
  });

  it('is a loss when typing under heavy output is slower, and names the figures', () => {
    const verdict = run([{ metric: 'inputLatencyMs', variant: FLOOD, values: [30, 30, 30], p95: 84 }, { metric: 'inputLatencyMs', variant: 'keys-idle', values: [6, 6, 6], p95: 12 }]);
    expect(verdict.status).toBe('targets not met');
    expect(exitCode(verdict)).toBe(1);
    expect(target(verdict, 'input-latency-under-heavy-output')).toMatchObject({ outcome: 'not met', evidence: [expect.stringMatching(/W12 keys-during-output inputLatencyMs p95: xterm-dom 60.00 ms, native 84.00 \(-40% better/)] });
    expect(renderVerdict(verdict)).toMatch(/G14 NOT MET: No input-latency regression under heavy output/);
  });

  it('treats a difference inside the noise as neither a win nor a regression', () => {
    // Native is 12% slower, above the 10% floor, but the xterm.js runs themselves spread 20%.
    const noisy = tie.map(spec => (spec.metric === 'throughputMiBs' ? { ...spec, values: [18, 20, 22] } : spec));
    const verdict = compareRecords([
      record([arm('xterm-dom')], noisy.map(spec => measure('xterm-dom', spec))),
      record([arm('native-wgpu')], tie.map(spec => measure('native-wgpu', spec.metric === 'throughputMiBs' ? { ...spec, values: [17.6, 17.6, 17.6] } : spec))),
    ]);
    expect(verdict.rows.find(row => row.metric === 'throughputMiBs')).toMatchObject({ outcome: 'equal', tolerance: expect.closeTo(0.2, 5) });
    expect(target(verdict, 'no-material-regression').outcome).toBe('met');
    // The same 12% against steady runs is a regression.
    expect(target(run([{ metric: 'throughputMiBs', values: [17.6, 17.6, 17.6] }]), 'no-material-regression').outcome).toBe('not met');
  });

  it('is not enough to tie: without 25% on a key metric the improvement target is not met, though nothing regressed', () => {
    const verdict = run([{ metric: 'cpuMsPerMiB', values: [85, 85, 85] }]);
    expect(outcomes(verdict)).toMatchObject({ 'no-material-regression': 'met', 'key-improvement': 'not met' });
    expect(verdict.status).toBe('targets not met');
  });

  it('counts a faster stream as nothing if it ends on another screen', () => {
    const verdict = run([{ workload: 'W2', metric: 'throughputMiBs', values: [40, 40, 40], correct: false }, { metric: 'cpuMsPerMiB', values: [40, 40, 40] }]);
    expect(target(verdict, 'no-correctness-regression')).toMatchObject({ outcome: 'not met', evidence: ['native-wgpu W2: ended on a different screen'] });
    expect(verdict.status).toBe('targets not met');
  });

  it('accepts idle activity under the near-zero floor even when xterm.js is lower, and refuses a real regression above it', () => {
    const idle = (values: number[]): Spec => ({ workload: 'W0', variant: 'blink-on', metric: 'idleCpuMsPerSecond', values });
    const verdict = (xterm: number, native: number) => compareRecords([record([arm('xterm-dom')], [measure('xterm-dom', idle([xterm, xterm, xterm]))]), record([arm('native-wgpu')], [measure('native-wgpu', idle([native, native, native]))])]);
    expect(target(verdict(1, 4), 'idle-near-zero').outcome).toBe('met');
    expect(target(verdict(40, 90), 'idle-near-zero').outcome).toBe('not met');
    expect(target(verdict(0, 0), 'idle-near-zero').outcome).toBe('met');
  });

  it('compares memory as growth over one session when the engines ran in different host apps, and says so', () => {
    const pss = (adapter: string, total: number): Measurement => measure(adapter, { workload: 'W9', variant: 'sessions-5', metric: 'pssMiB', values: [total, total, total] });
    const verdict = compareRecords([
      record([arm('xterm-dom', 'bench host')], [...tie.map(s => measure('xterm-dom', s)), pss('xterm-dom', 300)]),
      record([arm('native-wgpu', 'the real app')], [...tie.map(s => measure('native-wgpu', s)), pss('native-wgpu', 900)]),
    ]);
    expect(verdict.rows.some(row => row.metric === 'pssMiB')).toBe(false);
    expect(verdict.caveats).toEqual([expect.stringContaining('absolute PSS is not compared')]);
    // In the same host app the totals are compared and 900 against 300 MiB is a loss.
    const same = compareRecords([record([arm('xterm-dom')], [pss('xterm-dom', 300)]), record([arm('native-wgpu')], [pss('native-wgpu', 900)])]);
    expect(target(same, 'memory-not-worse').outcome).toBe('not met');
  });

  it('is a loss when native uses more memory per session growth or drifts across churn', () => {
    expect(target(run([{ metric: 'pssGrowthMiB', variant: 'sessions-10', values: [240, 240, 240] }]), 'memory-not-worse')).toMatchObject({ outcome: 'not met', evidence: [expect.stringMatching(/W9 sessions-10 pssGrowthMiB p50: xterm-dom 160.00 MiB, native 240.00 \(-50% better/)] });
  });

  it('is judged against every xterm.js arm: faster than the DOM renderer and slower than the WebGL one is a loss', () => {
    const dom = tie.map(spec => measure('xterm-dom', spec.metric === 'inputLatencyMs' ? { ...spec, values: [20, 20, 20] } : spec));
    const webgl = tie.map(spec => measure('xterm-webgl', spec.metric === 'inputLatencyMs' ? { ...spec, values: [5, 5, 5] } : spec));
    const native = tie.map(spec => measure('native-wgpu', spec));
    const verdict = compareRecords([record([arm('xterm-dom'), arm('xterm-webgl')], [...dom, ...webgl]), record([arm('native-wgpu')], native)]);
    expect(verdict.baselines).toEqual(['xterm-dom', 'xterm-webgl']);
    expect(target(verdict, 'input-latency-under-heavy-output').evidence.join('\n')).toMatch(/xterm-webgl/);
    expect(verdict.status).toBe('targets not met');
  });
});

describe('what the comparison refuses to say', () => {
  it('is incomplete, never a pass, without a native arm', () => {
    const verdict = compareRecords([record([arm('xterm-dom')], tie.map(spec => measure('xterm-dom', spec)))]);
    expect(verdict.status).toBe('incomplete');
    expect(exitCode(verdict)).toBe(3);
    expect(new Set(verdict.targets.map(t => t.outcome))).toEqual(new Set(['not measured']));
  });

  it('requires absolute PSS for a shared host but allows growth alone across host apps', () => {
    const faster = { metric: 'inputLatencyMs' as const, variant: 'keys-idle', values: [6, 6, 6], p95: 12 };
    const natives = tie.filter(spec => spec.metric !== 'pssMiB');
    const same = run([faster], { natives });
    expect(same.status).toBe('incomplete');
    expect(same.caveats).toContain('xterm-dom: missing paired W9 sessions-10 pssMiB');
    expect(run([faster], { natives, hosts: ['shell A', 'shell B'] }).status).toBe('targets met');
  });

  it('keeps the improvement target undecided if an unmeasured key metric could still meet it', () => {
    const verdict = run([], { natives: tie.filter(spec => spec.workload !== 'W1') });
    expect(target(verdict, 'key-improvement').outcome).toBe('not measured');
    expect(verdict.status).toBe('incomplete');
  });

  it('refuses to pass when a required heavy-output variant is missing', () => {
    const faster = { metric: 'inputLatencyMs' as const, variant: 'keys-idle', values: [6, 6, 6], p95: 12 };
    expect(run([faster], { natives: tie.filter(spec => spec.variant !== 'sessions-10' || spec.metric !== 'inputLatencyMs') }).status).toBe('incomplete');
  });

  it('reports a missing baseline workload and preserves a known regression', () => {
    const baseline = record([arm('xterm-dom')], tie.filter(spec => spec.workload !== 'W4').map(spec => measure('xterm-dom', spec)));
    const native = (idle: number) => record([arm('native-wgpu')], tie.map(spec => measure('native-wgpu',
      spec.metric === 'idleCpuMsPerSecond' ? { ...spec, values: [idle] } :
      spec.variant === 'keys-idle' ? { ...spec, values: [6], p95: 12 } : spec)));
    const incomplete = compareRecords([baseline, native(50)]);
    expect(incomplete.status).toBe('incomplete');
    expect(incomplete.caveats).toContain('xterm-dom: missing paired W4 throughputMiBs');
    expect(compareRecords([baseline, native(90)]).status).toBe('targets not met');
  });

  it('is incomplete when a target has no figure to judge it by, and a known loss still wins over it', () => {
    const noIdle = { natives: tie.filter(spec => spec.workload !== 'W0') }, faster = { metric: 'inputLatencyMs' as const, variant: 'keys-idle', values: [6, 6, 6], p95: 12 };
    const verdict = run([faster], noIdle);
    expect(target(verdict, 'idle-near-zero').outcome).toBe('not measured');
    expect(verdict.status).toBe('incomplete');
    expect(run([faster, { metric: 'throughputMiBs', values: [10, 10, 10] }], noIdle).status).toBe('targets not met');
  });

  it('refuses records of different lane runs or different guests: a comparison is only valid inside one run', () => {
    const xterm = record([arm('xterm-dom')], tie.map(spec => measure('xterm-dom', spec))), native = record([arm('native-wgpu')], tie.map(spec => measure('native-wgpu', spec)));
    expect(() => compareRecords([xterm, { ...native, runId: 'engine-20261122T210000Z' }])).toThrow(RecordError);
    expect(() => compareRecords([xterm, { ...native, runId: 'engine-20261122T210000Z' }])).toThrow(/not the same run/);
    expect(() => compareRecords([xterm, { ...native, environment: { device: { serial: 'emulator-5554' } } }])).toThrow(/not the same guest/);
    expect(() => compareRecords([])).toThrow(/no record given/);
  });

  it('refuses packaged arms captured from different APKs even with the same run id', () => {
    const packaged = (adapter: string, sha256: string) => record([arm(adapter)], [], {
      environment: { device: { serial: 'emulator-5554' }, installedApks: [{ name: 'base.apk', sha256 }] },
    });
    const xterm = packaged('xterm-dom', 'a'.repeat(64));
    expect(() => compareRecords([xterm, packaged('native-wgpu', 'a'.repeat(64))])).not.toThrow();
    expect(() => compareRecords([xterm, packaged('native-wgpu', 'b'.repeat(64))])).toThrow('not the same installed APKs');
  });
});

describe('the command', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'android-compare-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => { const file = path.join(dir, name); writeFileSync(file, JSON.stringify(value)); return file; };
  const compare = (...args: string[]) => spawnSync('bun', [path.join(import.meta.dirname, 'androidCompare.ts'), ...args], { encoding: 'utf8' });
  const xterm = write('xterm.json', record([arm('xterm-dom')], tie.map(spec => measure('xterm-dom', spec))));
  const native = (name: string, changes: Spec[]) => write(name, record([arm('native-wgpu')], tie.map(spec => measure('native-wgpu', changes.find(c => c.metric === spec.metric && c.variant === spec.variant) ?? spec))));

  it('exits 0 and prints the verdict when native meets every target', () => {
    const result = compare(xterm, native('win.json', [{ workload: 'W12', variant: 'keys-idle', metric: 'inputLatencyMs', values: [5, 5, 5], p95: 10 }]));
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^# native-wgpu against xterm-dom, run engine-20261122T200000Z: targets met/);
  });

  it('exits 1 with the verdict as JSON when native loses', () => {
    const result = compare('--json', xterm, native('loss.json', [{ workload: 'W2', variant: null, metric: 'throughputMiBs', values: [5, 5, 5] }]));
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'targets not met', native: 'native-wgpu', baselines: ['xterm-dom'] });
  });

  it('exits 3 for an xterm.js-only run and 2 for input it cannot use', () => {
    expect(compare(xterm).status).toBe(3);
    const other = write('other.json', record([arm('native-wgpu')], [], { runId: 'someone-else' }));
    expect(compare(xterm, other)).toMatchObject({ status: 2, stderr: expect.stringMatching(/not the same run/) });
    expect(compare(write('garbage.json', { hello: 'world' }))).toMatchObject({ status: 2, stderr: expect.stringMatching(/not an android-engine-comparison record/) });
    expect(compare()).toMatchObject({ status: 2, stderr: expect.stringMatching(/usage/) });
  });

  it('prints the measurements of a record as a table', () => {
    const result = compare('--measurements', xterm);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\| xterm-dom \| W12 \| keys-idle \| inputLatencyMs \(ms\) \| 3 \| 300 \| 10\.00 \| 20\.00 \| 10\.00 to 10\.00 \| yes \|/);
  });

  it('does not need the repository checked out beside it: it is one script', () => {
    expect(execFileSync('bun', ['-e', 'console.log(typeof (await import(process.argv[1])).compareRecords)', path.join(import.meta.dirname, 'androidCompare.ts')], { encoding: 'utf8' }).trim()).toBe('function');
  });
});

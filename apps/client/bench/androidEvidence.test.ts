import { describe, expect, it } from 'vitest';
import { fromBaseline, parseRecord, perRun, perRunSummaries, spread, type BaselineResult, type Measurement } from './androidEvidence';

const base = { adapter: 'xterm-dom', workload: 'W2', variant: null, metric: 'throughputMiBs', correct: true } as const;
const window = (windowMs: number, cpuMs: number, wakeups: number, frames: number, interval: { p50: number; p95: number } | null = null, jankyFramePercent: number | null = null) => ({ windowMs, cpuMs, wakeups, frames, frameIntervalMs: interval, jankyFramePercent, layers: [], processSetChanged: false });
const latency = (p50: number, p95: number, n = 200) => ({ p50, p95, p99: p95 + 1, n });
const find = (list: Measurement[], workload: string, variant: string | null, metric: string) => list.find(m => m.workload === workload && m.variant === variant && m.metric === metric);

describe('folding runs into a measurement', () => {
  it('takes the median of the runs for p50 and the 95th percentile of the runs for p95, and keeps the run values', () => {
    const m = perRun(base, [10, 12, 11, 40, 13])!;
    expect(m).toMatchObject({ runs: 5, samples: 5, p50: 12, min: 10, max: 40, values: [10, 12, 11, 40, 13], unit: 'MiB/s' });
    expect(m.p95).toBeCloseTo(34.6, 1);
  });

  it('drops a run that has no number instead of counting it as zero, and gives nothing when no run has one', () => {
    expect(perRun(base, [10, null, undefined, NaN, 14])).toMatchObject({ runs: 2, p50: 12, values: [10, 14] });
    expect(perRun(base, [null, undefined])).toBeNull();
  });

  it('takes the median of each run\'s own p50 and p95 for a sampled metric, and counts every sample', () => {
    const m = perRunSummaries({ ...base, metric: 'inputLatencyMs' }, [latency(10, 20), latency(14, 30, 100), latency(12, 26), null])!;
    expect(m).toMatchObject({ runs: 3, samples: 500, p50: 12, p95: 26, min: 10, max: 14 });
  });

  it('measures the noise of a number as its spread across runs, and cannot with one run', () => {
    expect(spread(perRun(base, [10, 12, 11])!)).toBeCloseTo(2 / 11);
    expect(spread(perRun(base, [10])!)).toBeNull();
  });
});

describe('the xterm.js arm from the baseline spec on Android', () => {
  const results: BaselineResult[] = [
    { workload: 'W0', title: 'Idle, session open, no output', variant: 'cursor blink on, focused', correct: true, runs: [{ android: window(30000, 300, 900, 60) }, { android: window(30000, 330, 960, 66) }, { android: window(30000, 270, 840, 54) }] },
    { workload: 'W0', title: 'Idle, session open, no output', variant: 'cursor blink off, focused', correct: true, runs: [{ android: window(30000, 30, 150, 0) }] },
    { workload: 'W1', title: 'Small shell output (prompt, short commands)', variant: null, correct: true, runs: [{ renderMs: latency(12, 13, 300) }, { renderMs: latency(13, 14, 300) }] },
    { workload: 'W2', title: 'Sustained plain text', variant: null, correct: true, runs: [{ throughputMiBs: 20, bytes: 4 * 1048576, android: window(200, 400, 50, 40, { p50: 4, p95: 5 }, 2) }, { throughputMiBs: 22, bytes: 4 * 1048576, android: window(180, 440, 55, 36, { p50: 4, p95: 6 }, 3) }] },
    { workload: 'W12', title: 'Keyboard input, one key at a time', variant: 'idle terminal', correct: true, runs: [{ latencyMs: latency(5, 9) }] },
    { workload: 'W12', title: 'Keyboard auto-repeat, about 30 Hz with jitter', variant: 'idle terminal', correct: true, runs: [{ latencyMs: latency(6, 10) }] },
    { workload: 'W12', title: 'Keyboard input during sustained output', variant: 'visible terminal flooded with W2 text; echo queues behind it', correct: false, runs: [{ latencyMs: latency(15, 31), android: window(6000, 6000, 900, 800, { p50: 4, p95: 33 }, 12) }] },
    { workload: 'W9', title: '5 simultaneous sessions', variant: '5 sessions, 5000 lines each, others streaming', correct: true, runs: [{ latencyMs: latency(11, 17), pss: { baselineKiB: 300 * 1024, kiB: 380 * 1024 }, android: window(7000, 7000, 900, 500, { p50: 5, p95: 40 }, 20) }, { latencyMs: latency(12, 18), pss: { baselineKiB: 300 * 1024, kiB: 384 * 1024 }, android: window(7000, 7000, 900, 500, { p50: 5, p95: 44 }, 30) }] },
    { workload: 'W9', title: 'Session churn: five sessions opened and closed five times', variant: 'churn', correct: true, runs: [{ churn: { pssKiB: [310 * 1024, 312 * 1024, 314 * 1024, 315 * 1024, 316 * 1024] } }] },
  ];
  const list = fromBaseline(results, 'xterm-dom');

  it('turns idle windows into rates per second and names the variants the same way every arm will', () => {
    expect(find(list, 'W0', 'blink-on', 'idleCpuMsPerSecond')).toMatchObject({ p50: 10, runs: 3, adapter: 'xterm-dom' });
    expect(find(list, 'W0', 'blink-on', 'idleWakeupsPerSecond')?.p50).toBe(30);
    expect(find(list, 'W0', 'blink-on', 'idleFramesPerSecond')?.p50).toBe(2);
    expect(find(list, 'W0', 'blink-off', 'idleFramesPerSecond')?.p50).toBe(0);
  });

  it('measures throughput and CPU per MiB of a stream, and the latency of W1 and W12 per variant', () => {
    expect(find(list, 'W2', null, 'throughputMiBs')?.p50).toBe(21);
    expect(find(list, 'W2', null, 'cpuMsPerMiB')?.values).toEqual([100, 110]);
    expect(find(list, 'W1', null, 'outputLatencyMs')).toMatchObject({ p50: 12.5, p95: 13.5 });
    expect(['keys-idle', 'repeat-idle', 'keys-during-output'].map(v => find(list, 'W12', v, 'inputLatencyMs')?.p50)).toEqual([5, 6, 15]);
  });

  it('reports frame pacing only for sustained output, where the window is long enough to be about the workload', () => {
    expect(find(list, 'W2', null, 'frameIntervalMs')).toBeUndefined();
    expect(find(list, 'W2', null, 'jankyFramePercent')).toBeUndefined();
    expect(find(list, 'W12', 'keys-during-output', 'frameIntervalMs')).toMatchObject({ p50: 4, p95: 33, samples: 800 });
    expect(find(list, 'W12', 'keys-during-output', 'jankyFramePercent')?.p50).toBe(12);
    expect(find(list, 'W9', 'sessions-5', 'jankyFramePercent')).toMatchObject({ p50: 25, runs: 2 });
    expect(find(list, 'W12', 'keys-idle', 'jankyFramePercent')).toBeUndefined();
  });

  it('carries a workload that ended on the wrong screen as incorrect', () => {
    expect(find(list, 'W12', 'keys-during-output', 'inputLatencyMs')?.correct).toBe(false);
    expect(find(list, 'W12', 'keys-idle', 'inputLatencyMs')?.correct).toBe(true);
  });

  it('measures the memory of N sessions as total and as growth over one session, and the drift across churn', () => {
    expect(find(list, 'W9', 'sessions-5', 'pssMiB')?.p50).toBe(382);
    expect(find(list, 'W9', 'sessions-5', 'pssGrowthMiB')?.p50).toBe(82);
    expect(find(list, 'W9', 'sessions-5', 'inputLatencyMs')?.p95).toBe(17.5);
    expect(find(list, 'W9', 'churn', 'pssChurnDriftMiB')?.p50).toBe(6);
  });

  it('excludes interrupted guest windows without dropping independent measurements', () => {
    const stable = window(1000, 20, 30, 1);
    const interrupted = { ...window(1000, 0, 0, 2, { p50: 1, p95: 2 }, 0), processSetChanged: true };
    const measured = fromBaseline([
      { workload: 'W0', title: 'Idle', variant: 'blink-off', correct: true, runs: [{ android: stable }, { android: interrupted }] },
      { workload: 'W2', title: 'Stream', variant: null, correct: true, runs: [{ bytes: 1048576, throughputMiBs: 20, android: interrupted }] },
      { workload: 'W12', title: 'Keyboard input during output', variant: null, correct: true, runs: [{ latencyMs: latency(7, 10), android: interrupted }] },
    ], 'xterm-dom');
    expect(measured.map(({ metric, values }) => [metric, values])).toEqual([
      ['idleCpuMsPerSecond', [20]],
      ['idleWakeupsPerSecond', [30]],
      ['idleFramesPerSecond', [1]],
      ['throughputMiBs', [20]],
      ['inputLatencyMs', [7]],
    ]);
  });

  it('records no figure at all for a workload whose guest counters are missing, never a zero', () => {
    const none = fromBaseline([{ workload: 'W2', title: 'Sustained plain text', variant: null, correct: true, runs: [{ throughputMiBs: 20, bytes: 1048576 }] }, { workload: 'W0', title: 'Idle', variant: 'cursor blink on, focused', correct: true, runs: [{}] }], 'xterm-dom');
    expect(none.map(m => m.metric)).toEqual(['throughputMiBs']);
  });
});

describe('reading a record back', () => {
  const record = { schema: 1, kind: 'android-engine-comparison', runId: 'r1', environment: { device: { serial: 'guest:5555' } }, arms: [], measurements: [perRun(base, [1, 2])] };

  it('accepts a record and refuses one that cannot be compared', () => {
    expect(parseRecord(record).runId).toBe('r1');
    expect(() => parseRecord({ ...record, schema: 2 }, 'a.json')).toThrow(/a.json: not an android-engine-comparison record/);
    expect(() => parseRecord({ ...record, runId: '' })).toThrow(/runId and environment.device.serial/);
    expect(() => parseRecord({ ...record, measurements: [{ ...perRun(base, [1])!, metric: 'madeUp' }] })).toThrow(/unknown metric madeUp/);
    expect(() => parseRecord({ ...record, measurements: [{ ...perRun(base, [1])!, p95: null }] })).toThrow(/missing or non-finite/);
  });
});

// The evidence record of a same-run engine comparison on the Waydroid lane (docs/architecture/terminal-benchmarks.md, "Same-run
// comparison on the Waydroid lane"): the metric catalogue both engines are measured against, how runs fold into p50 and p95, and
// the conversion of the xterm.js baseline spec's result file. The native engine's driver writes the same record, so
// `androidCompare.ts` can set the two side by side. A value that was not measured is absent, never zero.
import { percentile } from './workloads';
import type { Window } from './androidProbe';

export type Better = 'lower' | 'higher';
type MetricSpec = { unit: string; better: Better; /** The gate the metric decides; null: recorded and compared, but it decides nothing. */ gate: 'G14' | 'G15' | 'G16' | null; /** Whether p95 is compared as well as p50. */ tails: boolean; /** Counts toward "at least 25% better on one key latency or CPU metric". */ key: boolean; definition: string };

/** The metrics both engines report. A definition is engine-neutral: how an engine reaches it is the arm's `notes`. */
export const METRICS = {
  throughputMiBs: { unit: 'MiB/s', better: 'higher', gate: 'G14', tails: false, key: false, definition: 'Bytes delivered to the terminal per second until the end screen is shown (W2, W3, W4).' },
  cpuMsPerMiB: { unit: 'ms CPU per MiB', better: 'lower', gate: 'G14', tails: false, key: true, definition: 'CPU time of the app process and its WebView renderer processes (guest /proc utime plus stime) per MiB delivered (W2, W3, W4).' },
  // An engine that coalesces redraws presents less often without being slower, so the interval alone cannot say who loses: it is read beside the jank rate.
  frameIntervalMs: { unit: 'ms', better: 'lower', gate: null, tails: true, key: false, definition: 'Interval between frames SurfaceFlinger presented for the app\'s layers while sustained output ran (guest timestats, 1 ms buckets). Informational.' },
  jankyFramePercent: { unit: '%', better: 'lower', gate: 'G14', tails: false, key: false, definition: 'Share of the app\'s timeline frames that SurfaceFlinger counted as janky (missed their deadline) while sustained output ran (frame pacing; W12 under output and W9).' },
  inputLatencyMs: { unit: 'ms', better: 'lower', gate: 'G14', tails: true, key: true, definition: 'Key or composition commit to the frame that shows its echo (an estimate: the engine\'s own render or submit event, not a camera).' },
  outputLatencyMs: { unit: 'ms', better: 'lower', gate: 'G14', tails: true, key: true, definition: 'Remote burst written to the frame that shows it (W1; an estimate in the same sense).' },
  idleCpuMsPerSecond: { unit: 'ms CPU per s', better: 'lower', gate: 'G16', tails: false, key: false, definition: 'CPU time of the app and its renderer processes per second with a focused terminal and no output (W0).' },
  idleWakeupsPerSecond: { unit: '1/s', better: 'lower', gate: 'G16', tails: false, key: false, definition: 'Voluntary context switches of every thread of those processes per second at idle: how often a thread was woken (W0).' },
  idleFramesPerSecond: { unit: '1/s', better: 'lower', gate: 'G16', tails: false, key: false, definition: 'Frames SurfaceFlinger presented for the app\'s layers per second at idle (W0).' },
  pssMiB: { unit: 'MiB', better: 'lower', gate: 'G15', tails: false, key: false, definition: 'Total PSS of the app and its renderer processes with N sessions open (W9). Comparable across engines only when both ran in the same host app.' },
  pssGrowthMiB: { unit: 'MiB', better: 'lower', gate: 'G15', tails: false, key: false, definition: 'PSS with N sessions minus PSS with one session, same host app (W9): what the extra sessions cost.' },
  pssChurnDriftMiB: { unit: 'MiB', better: 'lower', gate: 'G15', tails: false, key: false, definition: 'PSS after the last of several open-five-sessions-then-close-them cycles minus PSS after the first (W9 churn): memory that closing sessions did not give back.' },
} as const satisfies Record<string, MetricSpec>;
export type MetricId = keyof typeof METRICS;

export type Measurement = {
  adapter: string; workload: string; variant: string | null; metric: MetricId; unit: string;
  /** Every run of this workload ended on the screen the workload expects. */
  correct: boolean;
  runs: number; samples: number;
  p50: number; p95: number; min: number; max: number;
  /** One value per run: the run's p50 for a sampled metric, the run's value otherwise. min, max and the noise spread come from these. */
  values: number[];
};
type Base = Pick<Measurement, 'adapter' | 'workload' | 'variant' | 'metric' | 'correct'>;
type Summary = { p50: number; p95: number; n: number };

export type Arm = { adapter: string; engine: string; host: string; gpu: unknown; page: unknown; notes: string };
export type EvidenceRecord = {
  schema: 1; kind: 'android-engine-comparison';
  /** The lane run this record belongs to: records are only compared when their ids and guests are the same. */
  runId: string; label: string | null; startedAt: string; finishedAt: string;
  source: { commit: string | null; dirty: boolean | null };
  environment: { device: { serial: string } & Record<string, unknown> } & Record<string, unknown>;
  limits: string;
  acceptedRisk: Array<{ id: string; gate: string; status: string; reason: string }>;
  arms: Arm[];
  measurements: Measurement[];
};

/** What Waydroid cannot establish, repeated in every record so evidence is never over-claimed (same ids as the lane's). */
export const ACCEPTED_RISK: EvidenceRecord['acceptedRisk'] = [
  { id: 'energy', gate: 'G16', status: 'accepted risk, not measured', reason: 'Waydroid has no phone battery to read, so energy cannot be compared between engines.' },
  { id: 'real-gpu-drivers', gate: 'G14', status: 'accepted risk, not measured', reason: 'The guest draws through the host GPU, not a phone GPU driver; frame times are not a device result.' },
  { id: 'thermal', gate: 'G14', status: 'accepted risk, not measured', reason: 'A workstation host does not throttle like a phone.' },
  { id: 'aarch64', gate: 'G12', status: 'accepted risk, not measured', reason: 'The guest is x86_64; the arm64 build that ships was not run.' },
  { id: 'vendor-webview-rom', gate: 'G14', status: 'accepted risk, not measured', reason: 'One WebView and one LineageOS-based image.' },
];

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const MiB = 1048576;

function assemble(base: Base, values: number[], p50: number, p95: number, samples: number): Measurement | null {
  if (values.length === 0) return null;
  return { ...base, unit: METRICS[base.metric].unit, runs: values.length, samples, p50, p95, min: Math.min(...values), max: Math.max(...values), values };
}
const ascending = (values: number[]) => [...values].sort((a, b) => a - b);

/** A metric with one value per run: p50 is the median of the runs and p95 their 95th percentile (the largest, with the five runs of a full run). Runs without a value are dropped. */
export function perRun(base: Base, values: Array<number | null | undefined>): Measurement | null {
  const kept = values.filter(finite), sorted = ascending(kept);
  return assemble(base, kept, percentile(sorted, 0.5), percentile(sorted, 0.95), kept.length);
}
/** A metric sampled many times in every run (latency, frame interval): each run gives its p50, p95 and sample count; the record holds their medians. */
export function perRunSummaries(base: Base, runs: Array<Summary | null | undefined>): Measurement | null {
  const kept = runs.filter((run): run is Summary => !!run && finite(run.p50) && finite(run.p95));
  const p50s = kept.map(run => run.p50);
  return assemble(base, p50s, percentile(ascending(p50s), 0.5), percentile(ascending(kept.map(run => run.p95)), 0.5), kept.reduce((sum, run) => sum + (finite(run.n) ? run.n : 0), 0));
}
/** Relative run-to-run spread of a measurement: the noise of the number, null when it has one run. */
export const spread = (m: Pick<Measurement, 'runs' | 'p50' | 'min' | 'max'>) => (m.runs < 2 || m.p50 === 0 ? null : (m.max - m.min) / Math.abs(m.p50));

type Run = Record<string, any>;
/** One workload of the baseline spec's result file (`apps/client/e2e/terminal-bench.spec.ts`), as written with LAZYSH_BENCH_ANDROID set. */
export type BaselineResult = { workload: string; title: string; variant: string | null; correct: boolean; runs: Run[] };
const idleVariants: Record<string, string> = { 'cursor blink on, focused': 'blink-on', 'cursor blink off, focused': 'blink-off' };
const keyVariants: Array<[titlePrefix: string, id: string]> = [['Keyboard input, one key', 'keys-idle'], ['Keyboard auto-repeat', 'repeat-idle'], ['Keyboard input during', 'keys-during-output'], ['IME composition', 'ime-commit']];
const perSecond = (value: number | undefined, window?: Window) => (finite(value) && window?.windowMs ? value / (window.windowMs / 1000) : null);
const frames = (window?: Window): Summary | null => (window?.frameIntervalMs ? { ...window.frameIntervalMs, n: window.frames } : null);

type Of = (metric: MetricId, name: string | null) => Base;
/** Frame pacing of the app's layers over a sustained window: interval and jank rate. */
const pacing = (of: Of, name: string, runs: Run[]) => [perRunSummaries(of('frameIntervalMs', name), runs.map(run => frames(run.android))), perRun(of('jankyFramePercent', name), runs.map(run => run.android?.jankyFramePercent))];

/** The measurements of the xterm.js arm: what the baseline spec recorded, folded into the catalogue's metrics. */
export function fromBaseline(results: BaselineResult[], adapter: string): Measurement[] {
  const found: Array<Measurement | null> = [];
  for (const { workload, title, variant, correct, runs: recordedRuns } of results) {
    const runs = recordedRuns.map(run => run.android?.processSetChanged ? { ...run, android: undefined } : run);
    const of: Of = (metric, name) => ({ adapter, workload, variant: name, metric, correct });
    if (workload === 'W0') {
      const name = idleVariants[variant ?? ''] ?? variant;
      found.push(perRun(of('idleCpuMsPerSecond', name), runs.map(run => perSecond(run.android?.cpuMs, run.android))), perRun(of('idleWakeupsPerSecond', name), runs.map(run => perSecond(run.android?.wakeups, run.android))), perRun(of('idleFramesPerSecond', name), runs.map(run => perSecond(run.android?.frames, run.android))));
    } else if (workload === 'W1') {
      if (runs.every(run => Number.isSafeInteger(run.bursts) && run.bursts > 0 && run.renderMs?.n === run.bursts
        && finite(run.renderMs.p50) && finite(run.renderMs.p95)))
        found.push(perRunSummaries(of('outputLatencyMs', null), runs.map(run => run.renderMs)));
    }
    else if (['W2', 'W3', 'W4'].includes(workload))
      // A stream takes a fraction of a second, shorter than the window the frame counters can isolate from idle time around it: only sustained workloads report frames.
      found.push(perRun(of('throughputMiBs', null), runs.map(run => run.renderThroughputMiBs)), perRun(of('cpuMsPerMiB', null), runs.map(run => (finite(run.android?.cpuMs) ? run.android.cpuMs / (run.bytes / MiB) : null))));
    else if (workload === 'W12') {
      const name = keyVariants.find(([prefix]) => title.startsWith(prefix))?.[1] ?? title;
      found.push(perRunSummaries(of('inputLatencyMs', name), runs.map(run => run.latencyMs)));
      if (name === 'keys-during-output') found.push(...pacing(of, name, runs));
    } else if (workload === 'W9' && title.startsWith('Session churn')) {
      const pss: number[] = runs[0]?.churn?.pssKiB ?? [];
      found.push(perRun(of('pssChurnDriftMiB', 'churn'), pss.length > 1 ? [(pss.at(-1)! - pss[0]) / 1024] : []));
    } else if (workload === 'W9') {
      const name = `sessions-${/^(\d+) /.exec(title)?.[1]}`;
      found.push(perRunSummaries(of('inputLatencyMs', name), runs.map(run => run.latencyMs)), perRun(of('pssMiB', name), runs.map(run => run.pss?.kiB / 1024)), perRun(of('pssGrowthMiB', name), runs.map(run => (run.pss?.kiB - run.pss?.baselineKiB) / 1024)), ...pacing(of, name, runs));
    }
  }
  return found.filter((m): m is Measurement => m !== null);
}

/** Checks a parsed JSON file is an evidence record this tooling can read; throws a message naming what is wrong. */
export function parseRecord(json: unknown, source = 'record'): EvidenceRecord {
  const record = json as Partial<EvidenceRecord> | null;
  if (record?.schema !== 1 || record.kind !== 'android-engine-comparison') throw new Error(`${source}: not an android-engine-comparison record (schema 1)`);
  if (!record.runId || typeof record.environment?.device?.serial !== 'string') throw new Error(`${source}: runId and environment.device.serial are required`);
  if (!Array.isArray(record.arms) || !Array.isArray(record.measurements)) throw new Error(`${source}: arms and measurements must be arrays`);
  for (const m of record.measurements) {
    if (!(m.metric in METRICS)) throw new Error(`${source}: unknown metric ${m.metric}`);
    if (![m.p50, m.p95, m.min, m.max].every(finite) || typeof m.correct !== 'boolean' || !m.adapter || !m.workload) throw new Error(`${source}: measurement ${m.adapter}/${m.workload}/${m.metric} has a missing or non-finite field`);
  }
  return record as EvidenceRecord;
}

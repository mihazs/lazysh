// Decides the provisional targets of the PRD (docs/architecture/terminal-performance-prd.md) for the native terminal engine against
// xterm.js from the evidence records of ONE Waydroid lane run. The rules and thresholds below were fixed, and documented in
// docs/architecture/terminal-benchmarks.md ("Same-run comparison on the Waydroid lane"), before any native number existed: when native
// loses, the answer is that Android keeps xterm.js, not a change here.
// Usage: bun bench/androidCompare.ts [--json] <record.json>...      (one record per arm is fine; they must share the run id and the guest)
//        bun bench/androidCompare.ts --measurements <record.json>...   (the measurement table of the records, no comparison)
// Exit: 0 every target met, 1 a target not met (native loses), 2 unusable input (not a record, different runs or guests), 3 incomplete (no native arm, or a target not measured).
import { readFileSync } from 'node:fs';
import { METRICS, parseRecord, spread, type Arm, type EvidenceRecord, type Measurement, type MetricId } from './androidEvidence';

export const RULES = {
  /** A difference smaller than this, or than the run-to-run spread of either number if larger, is noise: neither a win nor a regression. */
  toleranceFloor: 0.10,
  /** "At least 25% improvement in one key latency or CPU metric". */
  keyImprovement: 0.25,
  /** Idle activity at or below this counts as near zero whatever xterm.js does (it keeps a noisy near-zero from reading as a regression). */
  idleNearZero: { idleCpuMsPerSecond: 10, idleWakeupsPerSecond: 20, idleFramesPerSecond: 3 } as Partial<Record<MetricId, number>>,
};
const HEAVY_OUTPUT = ['keys-during-output', 'sessions-5', 'sessions-10'];

// The full Android baseline produces these decision metrics. Absolute PSS is
// optional because the two arms can use different host apps.
const requiredMetrics: Array<[string, string | null, MetricId]> = [
  ...['blink-on', 'blink-off'].flatMap(variant =>
    Object.keys(RULES.idleNearZero).map(metric => ['W0', variant, metric as MetricId] as [string, string, MetricId])),
  ['W1', null, 'outputLatencyMs'],
  ...['W2', 'W3', 'W4'].flatMap(workload => [
    [workload, null, 'throughputMiBs'], [workload, null, 'cpuMsPerMiB'],
  ] satisfies Array<[string, null, MetricId]>),
  ...['keys-idle', 'repeat-idle', 'keys-during-output', 'ime-commit'].map(variant =>
    ['W12', variant, 'inputLatencyMs'] satisfies [string, string, MetricId]),
  ['W12', 'keys-during-output', 'jankyFramePercent'],
  ...['sessions-5', 'sessions-10'].flatMap(variant => [
    ['W9', variant, 'inputLatencyMs'], ['W9', variant, 'jankyFramePercent'], ['W9', variant, 'pssGrowthMiB'],
  ] satisfies Array<[string, string, MetricId]>),
  ['W9', 'churn', 'pssChurnDriftMiB'],
];

export class RecordError extends Error {}

export type Row = {
  baseline: string; workload: string; variant: string | null; metric: MetricId; stat: 'p50' | 'p95'; unit: string; gate: string | null; key: boolean;
  baselineValue: number; nativeValue: number;
  /** Fraction by which native is better than the baseline (negative: worse); null when the baseline is 0. */
  delta: number | null; tolerance: number; outcome: 'better' | 'equal' | 'worse';
};
export type Target = { id: string; gate: string; statement: string; outcome: 'met' | 'not met' | 'not measured'; evidence: string[] };
export type Verdict = {
  runId: string; device: Record<string, unknown>; native: string | null; baselines: string[];
  status: 'targets met' | 'targets not met' | 'incomplete'; targets: Target[]; rows: Row[]; caveats: string[];
};

const label = (row: Pick<Row, 'workload' | 'variant' | 'metric' | 'stat'>) => `${row.workload}${row.variant ? ` ${row.variant}` : ''} ${row.metric} ${row.stat}`;
const percent = (fraction: number | null) => (fraction === null ? 'n/a' : `${fraction >= 0 ? '+' : ''}${(fraction * 100).toFixed(0)}%`);
const describe = (row: Row) => `${label(row)}: ${row.baseline} ${row.baselineValue.toFixed(2)} ${row.unit}, native ${row.nativeValue.toFixed(2)} (${percent(row.delta)} better, tolerance ${(row.tolerance * 100).toFixed(0)}%)`;

function mergeRecords(records: EvidenceRecord[]) {
  if (records.length === 0) throw new RecordError('no record given');
  const [first] = records;
  const packaged = records.find(record => record.environment.installedApks !== undefined);
  for (const record of records) {
    if (record.runId !== first.runId) throw new RecordError(`not the same run: ${first.runId} and ${record.runId}; a comparison is only valid for arms measured in one lane run`);
    if (record.environment.device.serial !== first.environment.device.serial) throw new RecordError(`not the same guest: ${first.environment.device.serial} and ${record.environment.device.serial}`);
    if (record.environment.installedApks !== undefined
      && JSON.stringify(record.environment.installedApks) !== JSON.stringify(packaged?.environment.installedApks))
      throw new RecordError('not the same installed APKs for the packaged benchmark arms');
  }
  return { runId: first.runId, device: first.environment.device, arms: records.flatMap(r => r.arms), measurements: records.flatMap(r => r.measurements) };
}

const streamWorkloads = new Set(['W2', 'W3', 'W4']);
function requireMatchingStream(workload: string, baseline: Arm | undefined, native: Arm | undefined) {
  const baselineStream = baseline?.stream, nativeStream = native?.stream;
  const baselineHash = baselineStream?.fixtures?.[workload], nativeHash = nativeStream?.fixtures?.[workload];
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (!baselineStream || !nativeStream || !digest(baselineHash) || !digest(nativeHash)
      || ![baselineStream.cols, baselineStream.rows, nativeStream.cols, nativeStream.rows].every(positive))
    throw new RecordError(`${workload}: missing stream fixture metadata`);
  if (baselineStream.cols !== nativeStream.cols || baselineStream.rows !== nativeStream.rows)
    throw new RecordError(`${workload}: different terminal grids (${baselineStream.cols}×${baselineStream.rows} and ${nativeStream.cols}×${nativeStream.rows})`);
  if (baselineHash !== nativeHash) throw new RecordError(`${workload}: different fixture hashes`);
}

function rowsAgainst(baseline: string, native: string, measurements: Measurement[], baselineArm: Arm | undefined, nativeArm: Arm | undefined): Row[] {
  const rows: Row[] = [];
  for (const n of measurements.filter(m => m.adapter === native)) {
    const x = measurements.find(m => m.adapter === baseline && m.workload === n.workload && m.variant === n.variant && m.metric === n.metric);
    // Absolute PSS says nothing about the engines when they ran in different host apps: only growth over one session is compared then.
    if (!x || (n.metric === 'pssMiB' && baselineArm?.host !== nativeArm?.host)) continue;
    if (streamWorkloads.has(n.workload)) requireMatchingStream(n.workload, baselineArm, nativeArm);
    const spec = METRICS[n.metric], tolerance = Math.max(RULES.toleranceFloor, spread(x) ?? 0, spread(n) ?? 0);
    for (const stat of spec.tails ? (['p50', 'p95'] as const) : (['p50'] as const)) {
      const gain = spec.better === 'lower' ? x[stat] - n[stat] : n[stat] - x[stat];
      const delta = x[stat] === 0 ? (gain === 0 ? 0 : null) : gain / Math.abs(x[stat]);
      const outcome = delta === null ? (gain > 0 ? 'better' : 'worse') : delta > tolerance ? 'better' : delta < -tolerance ? 'worse' : 'equal';
      rows.push({ baseline, workload: n.workload, variant: n.variant, metric: n.metric, stat, unit: spec.unit, gate: spec.gate, key: spec.key, baselineValue: x[stat], nativeValue: n[stat], delta, tolerance, outcome });
    }
  }
  return rows;
}

type Check = (rows: Row[]) => Pick<Target, 'outcome' | 'evidence'>;
/** met when no row is worse, not measured when there is none. `worse` decides per row (idle uses its floor). */
const noneWorse = (pick: (row: Row) => boolean, worse: (row: Row) => boolean = row => row.outcome === 'worse'): Check => rows => {
  const picked = rows.filter(pick), bad = picked.filter(worse);
  return picked.length === 0 ? { outcome: 'not measured', evidence: [] } : { outcome: bad.length ? 'not met' : 'met', evidence: (bad.length ? bad : picked).map(describe) };
};
const CHECKS: Array<{ id: string; gate: string; statement: string; check: Check }> = [
  { id: 'input-latency-under-heavy-output', gate: 'G14', statement: 'No input-latency regression under heavy output (typing while W2 floods the terminal, and with 5 and 10 sessions streaming): p50 and p95.',
    check: noneWorse(row => row.metric === 'inputLatencyMs' && HEAVY_OUTPUT.includes(row.variant ?? '')) },
  { id: 'no-material-regression', gate: 'G14', statement: 'No material regression elsewhere: no throughput, latency, CPU or frame-interval figure is worse than xterm.js beyond the tolerance.',
    check: noneWorse(row => row.gate === 'G14') },
  { id: 'key-improvement', gate: 'G14', statement: `At least ${RULES.keyImprovement * 100}% better on one key latency or CPU metric (and better beyond the noise).`,
    check: rows => {
      const keys = rows.filter(row => row.key), wins = keys.filter(row => row.delta !== null && row.delta >= RULES.keyImprovement && row.outcome === 'better');
      return keys.length === 0 ? { outcome: 'not measured', evidence: [] } : { outcome: wins.length ? 'met' : 'not met', evidence: (wins.length ? wins : keys).map(describe) };
    } },
  { id: 'idle-near-zero', gate: 'G16', statement: 'Near-zero idle activity: CPU, thread wakeups and presented frames at idle are under the near-zero floor or not worse than xterm.js.',
    check: noneWorse(row => row.gate === 'G16', row => row.outcome === 'worse' && row.nativeValue > (RULES.idleNearZero[row.metric] ?? 0)) },
  { id: 'memory-not-worse', gate: 'G15', statement: 'Memory not worse than xterm.js across 5 and 10 sessions and across session churn.',
    check: noneWorse(row => row.gate === 'G15') },
];

export function compareRecords(records: EvidenceRecord[]): Verdict {
  const { runId, device, arms, measurements } = mergeRecords(records);
  const adapters = [...new Set([...arms.map(a => a.adapter), ...measurements.map(m => m.adapter)])];
  const natives = adapters.filter(a => a.startsWith('native')), baselines = adapters.filter(a => a.startsWith('xterm'));
  if (natives.length > 1) throw new RecordError(`more than one native adapter in one run: ${natives.join(', ')}`);
  const native = natives[0] ?? null, caveats: string[] = [];
  const arm = (adapter: string) => arms.find(arm => arm.adapter === adapter);
  const host = (adapter: string) => arm(adapter)?.host;
  const rows = native ? baselines.flatMap(b => rowsAgainst(b, native, measurements, arm(b), arm(native))) : [];
  for (const b of baselines) if (native && host(b) !== host(native)) caveats.push(`${b} ran in "${host(b)}" and ${native} in "${host(native)}": absolute PSS is not compared, only growth over one session.`);
  const missing: string[] = [];
  const missingKeys = new Set<string>();
  for (const baseline of native ? baselines : []) {
    const sameHost = host(baseline) === host(native);
    const needs: typeof requiredMetrics = sameHost
      ? [...requiredMetrics, ['W9', 'sessions-5', 'pssMiB'], ['W9', 'sessions-10', 'pssMiB']]
      : requiredMetrics;
    for (const [workload, variant, metric] of needs) {
      if (rows.some(row => row.baseline === baseline && row.workload === workload && row.variant === variant && row.metric === metric)) continue;
      missing.push(`${baseline}: missing paired ${workload}${variant ? ` ${variant}` : ''} ${metric}`);
      if (METRICS[metric].key) missingKeys.add(baseline);
    }
  }
  caveats.push(...missing);
  const wrong = native ? measurements.filter(m => m.correct === false) : [];
  const targets: Target[] = [{
    id: 'no-correctness-regression', gate: 'G14', statement: 'No correctness regression: every workload of every arm ends on the screen it expects.',
    outcome: !native ? 'not measured' : wrong.length ? 'not met' : 'met', evidence: wrong.map(m => `${m.adapter} ${m.workload}${m.variant ? ` ${m.variant}` : ''}: ended on a different screen`),
  }];
  for (const { id, gate, statement, check } of CHECKS) {
    const per = baselines.map(b => {
      const result = check(rows.filter(row => row.baseline === b));
      return id === 'key-improvement' && result.outcome === 'not met' && missingKeys.has(b)
        ? { ...result, outcome: 'not measured' as const } : result;
    });
    targets.push({
      id, gate, statement, evidence: per.flatMap(r => r.evidence),
      outcome: per.some(r => r.outcome === 'not met') ? 'not met' : !native || per.length === 0 || per.some(r => r.outcome === 'not measured') ? 'not measured' : 'met',
    });
  }
  // A measured regression still fails when other comparisons are missing.
  const status = targets.some(t => t.outcome === 'not met') ? 'targets not met' : missing.length === 0 && targets.every(t => t.outcome === 'met') ? 'targets met' : 'incomplete';
  return { runId, device, native, baselines, status, targets, rows, caveats };
}
export const exitCode = (verdict: Verdict) => ({ 'targets met': 0, 'targets not met': 1, incomplete: 3 })[verdict.status];

export function renderVerdict(verdict: Verdict) {
  const mark = { met: 'met', 'not met': 'NOT MET', 'not measured': 'not measured' };
  return [
    `# ${verdict.native ?? 'no native arm'} against ${verdict.baselines.join(', ') || 'no xterm.js arm'}, run ${verdict.runId}: ${verdict.status}`,
    ...verdict.targets.flatMap(t => [`- ${t.gate} ${mark[t.outcome]}: ${t.statement}`, ...t.evidence.map(line => `    ${line}`)]),
    ...verdict.caveats.map(line => `caveat: ${line}`),
    '', '| Baseline | Workload | Variant | Metric | Stat | xterm.js | native | Better by | Tolerance | Outcome |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...verdict.rows.map(r => `| ${r.baseline} | ${r.workload} | ${r.variant ?? ''} | ${r.metric} (${r.unit}) | ${r.stat} | ${r.baselineValue.toFixed(2)} | ${r.nativeValue.toFixed(2)} | ${percent(r.delta)} | ${(r.tolerance * 100).toFixed(0)}% | ${r.outcome} |`),
  ].join('\n');
}

/** The measurements of the given records as a markdown table (what the documentation quotes). */
export function renderMeasurements(records: EvidenceRecord[]) {
  const fixed = (value: number) => (Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2));
  return ['| Adapter | Workload | Variant | Metric (unit) | Runs | Samples | p50 | p95 | Min to max of runs | Correct |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...records.flatMap(r => r.measurements).map(m => `| ${m.adapter} | ${m.workload} | ${m.variant ?? ''} | ${m.metric} (${m.unit}) | ${m.runs} | ${m.samples} | ${fixed(m.p50)} | ${fixed(m.p95)} | ${fixed(m.min)} to ${fixed(m.max)} | ${m.correct ? 'yes' : 'NO'} |`)].join('\n');
}

if (import.meta.main) {
  const args = process.argv.slice(2), json = args.includes('--json'), table = args.includes('--measurements'), files = args.filter(a => !a.startsWith('--'));
  try {
    if (files.length === 0) throw new RecordError('usage: androidCompare.ts [--json | --measurements] <record.json>...');
    const records = files.map(file => parseRecord(JSON.parse(readFileSync(file, 'utf8')), file));
    if (table) { console.log(renderMeasurements(records)); process.exit(0); }
    const verdict = compareRecords(records);
    console.log(json ? JSON.stringify(verdict, null, 2) : renderVerdict(verdict));
    process.exit(exitCode(verdict));
  } catch (error) {
    console.error(`androidCompare: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

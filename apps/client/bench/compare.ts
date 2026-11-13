// Side-by-side medians of benchmark result files (docs/architecture/terminal-benchmarks.md): one column per file,
// one row per metric, "n/a" where a file lacks the workload or the metric. Raw data stays in the JSON files.
// Usage: bun bench/compare.ts name=path.json [name=path.json ...]
import { readFileSync } from 'node:fs';

type Median = Record<string, any>;
export type Result = { workload: string; variant: string | null; median: Median };
export type Document = { results: Result[] };

const get = (path: string) => (m: Median) => path.split('.').reduce<any>((value, key) => value?.[key], m);
const busy = (m: Median) => (m.cost?.mainThreadMs?.task / m.cost?.windowMs) * 100;
const cpu = (type: string) => get(`cost.processCpuMs.${type}`);

const streaming = [
  ['MiB/s through xterm.write', get('throughputMiBs')],
  ['wall ms', get('wallMs')],
  ['main thread task ms', get('cost.mainThreadMs.task')],
  ['renderer process CPU ms', cpu('renderer')],
  ['GPU process CPU ms', cpu('GPU')],
  ['frame interval p99 ms', get('pacing.frameMs.p99')],
  ['dropped frames', get('pacing.dropped')],
] as const;
const latency = [
  ['p50 ms', get('latencyMs.p50')],
  ['p95 ms', get('latencyMs.p95')],
  ['p99 ms', get('latencyMs.p99')],
  ['main thread busy %', busy],
  ['renderer process CPU ms', cpu('renderer')],
  ['GPU process CPU ms', cpu('GPU')],
] as const;
const idle = [
  ['main thread task ms', get('cost.mainThreadMs.task')],
  ['style recalcs', get('cost.styleRecalcs')],
  ['renderer process CPU ms', cpu('renderer')],
  ['GPU process CPU ms', cpu('GPU')],
] as const;
const memory = [
  ['fill ms', get('fillMs')],
  ['scroll frame p99 ms', get('pacing.frameMs.p99')],
  ['JS heap MiB', get('cost.heapUsedMiB')],
  ['renderer RSS MiB', get('cost.rendererRssMiB')],
] as const;
const sessions = [...latency.slice(0, 3), ['JS heap per session MiB', get('perSessionHeapMiB')], ['renderer RSS per session MiB', get('perSessionRssMiB')]] as const;

type Section = { title: string; workload: string; variant?: string; metrics: ReadonlyArray<readonly [string, (m: Median) => unknown]> };
const sections: Section[] = [
  { title: 'W2 plain text, 4 MiB', workload: 'W2', metrics: streaming },
  { title: 'W3 ANSI color, 2 MiB', workload: 'W3', metrics: streaming },
  { title: 'W4 full-screen redraw', workload: 'W4', metrics: streaming },
  { title: 'W0 idle, cursor blink on, 10 s', workload: 'W0', variant: 'cursor blink on, focused', metrics: idle },
  { title: 'W0 idle, cursor blink off, 10 s', workload: 'W0', variant: 'cursor blink off, focused', metrics: idle },
  { title: 'W1 shell bursts, write to render', workload: 'W1', metrics: [['p50 ms', get('renderMs.p50')], ['p99 ms', get('renderMs.p99')]] },
  { title: 'W12 one key at a time, idle terminal', workload: 'W12', variant: 'idle terminal', metrics: latency },
  { title: 'W12 keys during sustained output', workload: 'W12', variant: 'visible terminal flooded with W2 text; echo queues behind it', metrics: latency },
  { title: 'W12 IME composition commit', workload: 'W12', variant: 'CDP imeSetComposition + insertText', metrics: latency },
  { title: 'W10 scrollback 5000 lines', workload: 'W10', variant: 'scrollback 5000 lines', metrics: memory },
  { title: 'W10 scrollback 20000 lines', workload: 'W10', variant: 'scrollback 20000 lines', metrics: memory },
  { title: 'W9 5 sessions, others streaming', workload: 'W9', variant: '5 sessions, 5000 lines each, others streaming', metrics: sessions },
  { title: 'W9 10 sessions, others streaming', workload: 'W9', variant: '10 sessions, 5000 lines each, others streaming', metrics: sessions },
];

const format = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return Math.abs(value) >= 1000 ? String(Math.round(value)) : value.toPrecision(3);
};

export function compare(documents: Record<string, Document>) {
  const names = Object.keys(documents);
  return sections.map(({ title, workload, variant, metrics }) => {
    const medians = names.map(name => documents[name].results.find(r => r.workload === workload && (variant === undefined || r.variant === variant))?.median);
    const rows = metrics.map(([label, pick]) => `| ${label} | ${medians.map(m => format(m && pick(m))).join(' | ')} |`);
    return [`**${title}**`, '', `| Metric | ${names.join(' | ')} |`, `| --- | ${names.map(() => '---').join(' | ')} |`, ...rows, ''].join('\n');
  }).join('\n');
}

if (import.meta.main) {
  const files = process.argv.slice(2).map(arg => arg.split('=') as [string, string]);
  if (!files.length || files.some(([name, path]) => !name || !path)) { console.error('usage: bun bench/compare.ts name=result.json ...'); process.exit(2); }
  console.log(compare(Object.fromEntries(files.map(([name, path]) => [name, JSON.parse(readFileSync(path, 'utf8')) as Document]))));
}

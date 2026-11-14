import { describe, expect, it } from 'vitest';
import { compare, type Document } from './compare';

const stream = (throughputMiBs: number, renderer: number, gpu: number): Document['results'][number] => ({
  workload: 'W2', variant: null,
  median: { throughputMiBs, wallMs: 100, pacing: { frameMs: { p99: 16.7 }, dropped: 0 }, cost: { mainThreadMs: { task: 90 }, processCpuMs: { renderer, GPU: gpu } } },
});

describe('benchmark comparison', () => {
  const docs = { dom: { results: [stream(40.08, 180, 10)] }, webgl: { results: [stream(61.5, 130, 240)] } };
  const table = compare(docs);

  it('puts one column per candidate and one row per metric', () => {
    expect(table).toContain('| Metric | dom | webgl |');
    expect(table).toContain('| MiB/s through xterm.write | 40.1 | 61.5 |');
    expect(table).toContain('| renderer process CPU ms | 180 | 130 |');
    expect(table).toContain('| GPU process CPU ms | 10.0 | 240 |');
  });

  it('shows n/a, never zero, for a workload or metric a candidate did not produce', () => {
    const partial = compare({ dom: docs.dom, other: { results: [] } });
    expect(partial).toContain('| MiB/s through xterm.write | 40.1 | n/a |');
    expect(partial).toContain('| p50 ms | n/a | n/a |');
    expect(compare({ dom: { results: [{ workload: 'W2', variant: null, median: { throughputMiBs: null } }] } })).toContain('| MiB/s through xterm.write | n/a |');
  });

  it('matches a variant by its exact name so blink on and off stay apart', () => {
    const idle = (variant: string, task: number): Document['results'][number] => ({ workload: 'W0', variant, median: { cost: { mainThreadMs: { task } } } });
    const out = compare({ dom: { results: [idle('cursor blink on, focused', 54), idle('cursor blink off, focused', 10)] } });
    expect(out).toMatch(/W0 idle, cursor blink on[^]*main thread task ms \| 54\.0 \|/);
    expect(out).toMatch(/W0 idle, cursor blink off[^]*main thread task ms \| 10\.0 \|/);
  });
});

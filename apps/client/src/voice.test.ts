import { expect, it } from 'vitest';
import { mono16k, validModelFile } from './voice';

it('downsamples finite multichannel audio to bounded mono16k samples', () => {
  const samples = mono16k([new Float32Array(4800).fill(0.8),new Float32Array(4800).fill(-0.2)],48000);
  expect(samples).toHaveLength(1600);
  expect(samples[0]).toBeCloseTo(0.3);
  expect(() => mono16k([new Float32Array(48000*31)],48000)).toThrow();
  expect(() => mono16k([new Float32Array(1600).fill(NaN)],16000)).toThrow();
  expect(() => mono16k([new Float32Array(1599)],16000)).toThrow();
});

it('rejects oversized models and traversal names before reading files', () => {
  expect(() => validModelFile({name:'ggml-tiny.en.bin',size:75*1024*1024})).not.toThrow();
  for (const name of ['../model.bin','model.txt','.hidden.bin']) expect(() => validModelFile({name,size:1024})).toThrow();
  expect(() => validModelFile({name:'model.bin',size:161*1024*1024})).toThrow();
});

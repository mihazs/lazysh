import { describe, expect, it } from 'vitest';
import { selfTimeByFunction, type CpuProfile } from './cpuProfile';

const frame = (id: number, functionName: string, url = '') => ({ id, callFrame: { functionName, url, lineNumber: 0 } });

describe('self time by function', () => {
  const profile: CpuProfile = {
    nodes: [frame(1, '(root)'), frame(2, 'scan', 'http://localhost/node_modules/.vite/deps/addon.js?v=1'), frame(3, 'scan', 'http://localhost/other.js'), frame(4, '')],
    samples: [2, 3, 2, 4, 2],
    timeDeltas: [1000, 500, 1000, 250, 1250],
  };

  it('sums the samples of one function across call-tree nodes, largest first, and reports the share of all sampled time', () => {
    const { totalMs, top } = selfTimeByFunction(profile);
    expect(totalMs).toBe(4);
    expect(top.map(entry => [entry.functionName, entry.file, entry.ms])).toEqual([['scan', 'addon.js', 3.25], ['scan', 'other.js', 0.5], ['(anonymous)', '', 0.25]]);
    expect(top[0].share).toBeCloseTo(3.25 / 4);
  });

  it('keeps only the requested number of functions and survives an empty profile', () => {
    expect(selfTimeByFunction(profile, 1).top).toHaveLength(1);
    expect(selfTimeByFunction({ nodes: [], samples: [], timeDeltas: [] })).toEqual({ totalMs: 0, top: [] });
  });
});

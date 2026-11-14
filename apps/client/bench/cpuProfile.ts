/** The part of a Chrome DevTools Protocol `Profiler.stop` result that the self-time summary reads. */
export interface CpuProfile {
  nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>;
  samples: number[];
  timeDeltas: number[];
}

export interface SelfTime { functionName: string; file: string; ms: number; share: number }

/** Where the main thread's time went: sampled self time summed per function (name and file), largest first. `share` is of all sampled time, idle and native frames included. */
export function selfTimeByFunction(profile: CpuProfile, top = 10): { totalMs: number; top: SelfTime[] } {
  const nodes = new Map(profile.nodes.map(node => [node.id, node.callFrame]));
  const byFunction = new Map<string, SelfTime>();
  let totalUs = 0;
  profile.samples.forEach((id, index) => {
    const frame = nodes.get(id)!, us = profile.timeDeltas[index] ?? 0;
    const functionName = frame.functionName || '(anonymous)', file = frame.url.split('/').pop()?.split('?')[0] ?? '';
    const key = `${functionName}\0${file}`, entry = byFunction.get(key) ?? { functionName, file, ms: 0, share: 0 };
    entry.ms += us / 1000;
    byFunction.set(key, entry);
    totalUs += us;
  });
  const totalMs = totalUs / 1000;
  return { totalMs, top: [...byFunction.values()].sort((a, b) => b.ms - a.ms).slice(0, top).map(entry => ({ ...entry, share: totalMs > 0 ? entry.ms / totalMs : 0 })) };
}

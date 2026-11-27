import { expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMoonLock } from './support/moon';

const support = join(import.meta.dir, 'support/moon.ts');

test('moon runs from concurrent test processes never overlap', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moon-lock-'));
  try {
    const log = join(directory, 'log');
    const lockDir = join(directory, 'lock');
    // Each process holds the lock for 150ms and appends a start and end mark; overlapping holders interleave the marks.
    const script = `import { appendFileSync } from 'node:fs'; import { withMoonLock } from ${JSON.stringify(support)};
      await withMoonLock(async () => { appendFileSync(${JSON.stringify(log)}, 'start\\n'); await Bun.sleep(150); appendFileSync(${JSON.stringify(log)}, 'end\\n'); }, undefined, ${JSON.stringify(lockDir)});`;
    const children = Array.from({ length: 5 }, () => Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' }));
    expect(await Promise.all(children.map(child => child.exited))).toEqual(children.map(() => 0));
    expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(Array.from({ length: 5 }, () => ['start', 'end']).flat());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a lock left behind by a dead process is taken over and released afterwards', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'moon-lock-'));
  try {
    const lockDir = join(directory, 'lock');
    const dead = Bun.spawn([process.execPath, '-e', '']);
    await dead.exited;
    await Bun.write(join(lockDir, 'pid'), String(dead.pid));
    expect(await withMoonLock(async () => 'ran', undefined, lockDir)).toBe('ran');
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

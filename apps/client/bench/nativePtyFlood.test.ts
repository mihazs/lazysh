import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const python = spawnSync('python3', ['--version']).status === 0;

it.skipIf(!python).each([true, false])('receipts each marked echo with foreground flood %s', async foregroundFlood => {
  const root = mkdtempSync(join(tmpdir(), 'lazysh-flood-test-'));
  const fixture = join(import.meta.dirname, 'nativePtyFlood.py');
  const gate = join(root, 'bench.go');
  const data = join(root, 'flood.bin');
  const markers = join(root, 'markers.json');
  const chunk = Buffer.alloc(16 * 1024, 'z');
  const marker = '\x1b[48;2;231;0;243m';
  writeFileSync(data, foregroundFlood ? chunk : Buffer.alloc(0));
  writeFileSync(markers, JSON.stringify([marker]));
  const process = spawn('python3', [fixture, gate, data, '1', markers]);
  const closed = once(process, 'close');
  try {
    writeFileSync(gate + '-0', '');
    const armed = join(root, 'bench.armed-0');
    const receipt = join(root, 'bench.echo-0');
    await expect.poll(() => existsSync(armed), { timeout: 1500, interval: 5 }).toBe(true);
    expect(existsSync(receipt)).toBe(false);
    process.stdin.end('a');
    const output: Buffer[] = [];
    for await (const block of process.stdout) output.push(block);
    expect(await closed).toEqual([0, null]);
    const bytes = Buffer.concat(output);
    const frame = Buffer.from('\x1b[2J\x1b[Ha' + marker);
    const floodSize = bytes.length - frame.length;
    if (foregroundFlood) expect(floodSize).toBeGreaterThanOrEqual(chunk.length);
    else expect(floodSize).toBe(0);
    expect(floodSize % chunk.length).toBe(0);
    expect(bytes.subarray(0, floodSize)).toEqual(Buffer.alloc(floodSize, 'z'));
    expect(bytes.subarray(floodSize)).toEqual(frame);
    expect(Number(readFileSync(receipt, 'ascii'))).toBe(bytes.length);
  } finally {
    if (process.exitCode === null) process.kill();
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
});

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function runBaseline(receiptPath?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lazysh-android-baseline-'));
  const out = join(dir, 'comparison.json');
  try {
    writeFileSync(join(dir, 'adb'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(dir, 'bun'), `#!/bin/sh
path=${'$'}{TEST_RECEIPT_PATH:-${'$'}LAZYSH_BENCH_WRITE}
writes=0
if [ "$path" = adapter ]; then writes=1; fi
printf '{"writePath":"%s","adapterWrites":%s,"toolchain":{"xterm":"5.5.0"},"page":{},"results":[]}' "$path" "$writes" > "$LAZYSH_BENCH_OUT"
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [join(import.meta.dirname, 'androidEngineBench.ts'), '--out', out, '--serial', 'emulator-5554'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, LAZYSH_BENCH_WRITE: 'direct', TEST_RECEIPT_PATH: receiptPath ?? '' },
    });
    return { status: result.status, stderr: result.stderr, record: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

it('requires the Android xterm baseline to write through the adapter', () => {
  expect(runBaseline()).toMatchObject({ status: 0, record: { arms: [{ page: { writePath: 'adapter', adapterWrites: 1 } }] } });
});

it('does not publish a comparison record from a direct-write baseline', () => {
  expect(runBaseline('direct')).toMatchObject({ status: 1, record: null, stderr: expect.stringMatching(/adapter write path/) });
});

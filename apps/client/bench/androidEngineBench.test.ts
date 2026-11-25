import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, test, vi } from 'vitest';
import { packagedSshEcho } from './androidEngineBench';

// Resolve the host Bun before the fixture shadows it for the nested runner.
const bun = execFileSync('bun', ['--eval', 'process.stdout.write(process.execPath)'], { encoding: 'utf8' });

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
    const result = spawnSync(bun, [join(import.meta.dirname, 'androidEngineBench.ts'), '--out', out, '--serial', 'emulator-5554'], {
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

const fixture = '/data/local/tmp/lazysh-ui-ssh-0123456789abcdef0123456789abcdef/fixture.json';
const packageName = 'app.lazysh.client';
const receipt = (values: number[] = Array<number>(200).fill(18)) =>
  'INSTRUMENTATION_STATUS: lazyshXtermSshEcho=' + JSON.stringify({
    engine: 'xterm', transport: 'ssh', inputSha256: 'a'.repeat(64), ptyColumns: 49, renderedRows: 12, ptyRowsAfterInput: 12, androidDispatchToFrameCommitMs: values, androidDispatchToDisplayCaptureMs: values,
  });
const success = 'OK (1 test)\nINSTRUMENTATION_CODE: -1';

describe('packaged Android SSH echo evidence', () => {
  test('invokes the live fixture and accepts a complete frame receipt', () => {
    const adb = vi.fn(() => [receipt(), success].join('\n'));
    expect(packagedSshEcho(adb, fixture, packageName).androidDispatchToFrameCommitMs).toHaveLength(200);
    expect(adb).toHaveBeenCalledWith('shell', 'am', 'instrument', '-w', '-r',
      '-e', 'waitForActivitiesToComplete', 'false', '-e', 'class', 'app.lazysh.client.NativeTerminalSessionTest',
      '-e', 'lazyshSshFixture', fixture, '-e', 'lazyshXtermSshEcho', 'true',
      'app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner');
  });

  test.each([
    success,
    [receipt(), receipt(), success].join('\n'),
    [receipt(), success, 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.'].join('\n'),
    [receipt([18]), success].join('\n'),
  ])('rejects incomplete, ambiguous, or failed evidence', output => {
    expect(() => packagedSshEcho(() => output, fixture, packageName)).toThrow();
  });
});

import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const temporary: string[] = [];
const workflow = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/checks.yml', import.meta.url)).text()) as {
  jobs: Record<string, { steps: { name?: string; run?: string; with?: { script?: string } }[] }>;
};
const decoded = workflow.jobs['native-android-runtime'].steps.find(step => step.name === 'Run native Android instrumentation')!.with!.script!;
// Match emulator-runner v2's parseScript: each retained line is a separate sh -c.
const commands = decoded.trim().split(/\r\n|\n|\r/).map(line => line.trim()).filter(line => !line.startsWith('#') && line.length > 0);

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

test('Android SSH admission requires its user namespace and private NSS bind without Linux GUI network isolation', () => {
  const steps = workflow.jobs['native-android-runtime'].steps;
  const admission = steps.findIndex(step => step.name === 'Verify native SSH namespace prerequisites');
  expect(admission).toBeGreaterThan(0);
  expect(steps[admission - 1].run).toContain('bubblewrap');
  const run = steps[admission].run!;
  expect(run).toContain('/usr/bin/bwrap --die-with-parent --unshare-user --dev-bind / / --ro-bind "$namespace_group" /etc/group -- /usr/bin/true');
  expect(run).toContain('trap');
  expect(run).not.toMatch(/--unshare-(?:net|pid)|sudo|sysctl/);
  const linux = workflow.jobs['native-linux'].steps.find(step => step.name === 'Verify native GUI namespace prerequisites')!.run!;
  expect(linux).toContain('bwrap --unshare-user --unshare-net --dev-bind / / -- bwrap --unshare-user --unshare-net --unshare-pid');
});

test.each([
  { mosh: 0, instrumentation: 0, qr: 0, fdroid: 0, sdk: 0, diagnosticFailure: false, overflow: false },
  { mosh: 37, instrumentation: 0, qr: 0, fdroid: 0, sdk: 0, diagnosticFailure: true, overflow: false },
  { mosh: 0, instrumentation: 23, qr: 0, fdroid: 0, sdk: 0, diagnosticFailure: true, overflow: false },
  { mosh: 0, instrumentation: 23, qr: 0, fdroid: 0, sdk: 0, diagnosticFailure: false, overflow: true },
  { mosh: 37, instrumentation: 23, qr: 0, fdroid: 41, sdk: 0, diagnosticFailure: false, overflow: false },
  { mosh: 0, instrumentation: 23, qr: 0, fdroid: 41, sdk: 0, diagnosticFailure: true, overflow: false },
  { mosh: 0, instrumentation: 0, qr: 29, fdroid: 0, sdk: 0, diagnosticFailure: true, overflow: false },
  { mosh: 0, instrumentation: 0, qr: 0, fdroid: 41, sdk: 0, diagnosticFailure: true, overflow: false },
  { mosh: 0, instrumentation: 0, qr: 0, fdroid: 0, sdk: 31, diagnosticFailure: true, overflow: false },
])('emulator script preserves exits and reaps collector: %j', async ({ mosh, instrumentation, qr, fdroid, sdk, diagnosticFailure, overflow }) => {
  expect(commands).toHaveLength(1);
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-android-diagnostics-'));
  temporary.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const marker = join(directory, 'collector.pid');
  const invocations = join(directory, 'invocations.txt');
  const fakeBun = join(bin, 'bun');
  const fakeAdb = join(bin, 'adb');
  const fakeCargo = join(bin, 'cargo');
  const sdkSerial = join(directory, 'sdk-serial.txt');
  const sdkArguments = join(directory, 'sdk-arguments.bin');
  const qrPidFile = join(directory, 'qr-pid-file.txt');
  await writeFile(fakeBun, `#!/bin/bash
for ((attempt=0; attempt<100; attempt++)); do
  test -f "$COLLECTOR_PID" && break
  sleep 0.01
done
test -f "$COLLECTOR_PID" || exit 88
printf '%s\\n' "$*" >> "$INVOCATIONS"
if [[ "$2" == test:android-mosh ]]; then exit "$MOSH_EXIT"; fi
if [[ "$2" == test:android-fdroid ]]; then exit "$FDROID_EXIT"; fi
if [[ "$2" == test:android-qr ]]; then
  printf '%s\\n' "$LAZYSH_ANDROID_QR_EMULATOR_PID_FILE" > "$QR_PID_FILE"
  exit "$QR_EXIT"
fi
exit "$INSTRUMENTATION_EXIT"
`);
  await writeFile(fakeAdb, `#!/bin/bash
if [[ "$1" == logcat ]]; then
  printf '%s\\n' "$$" > "$COLLECTOR_PID"
  printf 'ActivityManager: bounded fixture collector\\n'
  exec sleep 1800
fi
if [[ "$DIAGNOSTIC_FAILURE" == 1 ]]; then exit 79; fi
if [[ "$DIAGNOSTIC_OVERFLOW" == 1 && "$*" == *lastanr-traces ]]; then exec yes native-frame; fi
printf 'native diagnostic fixture\\n'
`);
  await writeFile(fakeCargo, `#!/bin/bash
printf 'cargo %s\\n' "$*" >> "$INVOCATIONS"
printf '%s\\n' "$LAZYSH_TEST_ANDROID_SERIAL" > "$SDK_SERIAL"
printf '%s\\0' "$@" > "$SDK_ARGUMENTS"
exit "$SDK_EXIT"
`);
  await Promise.all([fakeBun, fakeAdb, fakeCargo].map(path => chmod(path, 0o755)));
  const child = Bun.spawn(['sh', '-c', commands[0]], {
    cwd: directory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, COLLECTOR_PID: marker, INVOCATIONS: invocations,
      MOSH_EXIT: String(mosh), INSTRUMENTATION_EXIT: String(instrumentation), QR_EXIT: String(qr), FDROID_EXIT: String(fdroid), SDK_EXIT: String(sdk),
      ANDROID_SERIAL: 'emulator-5580', SDK_SERIAL: sdkSerial, SDK_ARGUMENTS: sdkArguments,
      RUNNER_TEMP: directory, QR_PID_FILE: qrPidFile,
      DIAGNOSTIC_FAILURE: diagnosticFailure ? '1' : '0',
      DIAGNOSTIC_OVERFLOW: overflow ? '1' : '0' },
    stdout: 'pipe', stderr: 'pipe',
  });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const expectedExit = mosh || instrumentation || fdroid || qr || sdk;
  expect(exit).toBe(expectedExit);
  expect(stdout).toBe('');
  if (!overflow) expect(stderr).toBe('');
  const qrExpected = mosh === 0 && instrumentation === 0 && fdroid === 0;
  const sdkExpected = qrExpected && qr === 0;
  expect(await Bun.file(qrPidFile).exists()).toBe(qrExpected);
  if (qrExpected) expect(await readFile(qrPidFile, 'utf8')).toBe(`${directory}/lazysh-qr-emulator.pid\n`);
  expect((await readFile(invocations, 'utf8')).trim().split('\n')).toEqual([
    'run test:android-mosh',
    ...(mosh === 0 ? ['run test:android-ssh'] : []),
    'run test:android-fdroid',
    ...(qrExpected ? ['run test:android-qr'] : []),
    ...(sdkExpected ? ['cargo test --locked -p lazysh-agent --lib devices::tests::android_owned_emulator_inventory_and_screenshot -- --ignored --exact --nocapture'] : []),
  ]);
  expect(await Bun.file(sdkSerial).exists()).toBe(sdkExpected);
  expect(await Bun.file(sdkArguments).exists()).toBe(sdkExpected);
  if (sdkExpected) {
    expect(await readFile(sdkSerial, 'utf8')).toBe('emulator-5580\n');
    expect((await readFile(sdkArguments, 'utf8')).split('\0')).toEqual([
      'test', '--locked', '-p', 'lazysh-agent', '--lib',
      'devices::tests::android_owned_emulator_inventory_and_screenshot',
      '--', '--ignored', '--exact', '--nocapture', '',
    ]);
  }
  const pid = Number((await readFile(marker, 'utf8')).trim());
  expect(pid).toBeGreaterThan(1);
  expect(() => process.kill(pid, 0)).toThrow();
  const diagnostics = join(directory, 'apps/client/src-tauri/gen/android/app/build/outputs/androidTest-results/system-diagnostics');
  const files = await readdir(diagnostics);
  expect(files.length).toBe(expectedExit ? 8 : 4);
  const status = await readFile(join(diagnostics, 'status.txt'), 'utf8');
  for (const name of files) expect((await stat(join(diagnostics, name))).size).toBeLessThanOrEqual(1024 * 1024);
  expect(status).toContain(`test exit=${expectedExit}`);
  expect(status).toContain('collector exit=143');
  if (diagnosticFailure) {
    for (const name of ['start-load', 'lastanr', 'lastanr-traces', 'cpu-load', 'kernel-load']) {
      expect(status).toContain(`${name} exit=79`);
    }
  }
  if (overflow) {
    expect((await stat(join(diagnostics, 'lastanr-traces.txt'))).size).toBe(1024 * 1024);
    expect(status).toContain('lastanr-traces exit=153');
  }
});

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { project } from './support/gitFixture';

// The lane script is driven against stub waydroid, adb and systemctl executables on a PATH of its own, so the real Waydroid of the machine
// is never touched. What it cannot show is the real container and guest: that is the runbook's job (docs/architecture/waydroid-lane.md).
const script = join(project, 'apps', 'client', 'bench', 'waydroid-lane.sh');
const SERIAL = '192.168.240.112:5555';
const utilities = ['sh', 'dirname', 'basename', 'mktemp', 'id', 'sed', 'grep', 'jq', 'tr', 'cut', 'head', 'tail', 'date', 'sleep', 'find', 'git', 'sha256sum', 'nproc', 'uname', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'cat', 'kill', 'touch', 'awk'];
const stubs: Record<string, string> = {
  waydroid: `echo "waydroid $*" >> "$STUB/calls"
case "$1" in
  --version) echo 'waydroid 1.6.3' ;;
  status) state=$(cat "$STUB/session"); printf 'Session:\\t%s\\n' "$state"; [ "$state" != RUNNING ] || printf 'Container:\\tRUNNING\\n'; printf 'Vendor type:\\tMAINLINE\\n' ;;
  session) case "$2" in
    start) if [ -f "$STUB/start-fails" ]; then cat "$STUB/start-fails" >&2; exit 1; fi
      echo RUNNING > "$STUB/session"; while [ "$(cat "$STUB/session")" = RUNNING ]; do sleep 0.05; done ;;
    stop) echo STOPPED > "$STUB/session" ;;
  esac ;;
esac`,
  systemctl: `[ ! -f "$STUB/container-down" ]`,
  adb: `echo "adb $*" >> "$STUB/calls"
[ "$1" != -s ] || shift 2
case "$1" in
  version) echo 'Android Debug Bridge version 1.0.41' ;;
  devices) echo 'List of devices attached'; [ ! -f "$STUB/listed" ] || printf '%s\\tdevice\\n' "$STUB_SERIAL" ;;
  connect) touch "$STUB/listed"; echo "connected to $2" ;;
  disconnect) rm -f "$STUB/listed" ;;
  install) if [ -f "$STUB/install-fails" ]; then echo 'Failure [INSTALL_FAILED_OLDER_SDK]'; exit 1; fi; echo 'Performing Streamed Install'; echo 'Success' ;;
  uninstall) if [ -f "$STUB/not-installed" ]; then echo 'Failure [DELETE_FAILED_INTERNAL_ERROR] Unknown package'; exit 1; fi; echo Success ;;
  pull) cp -R "$STUB/device-evidence/." "$3" 2>/dev/null || exit 1 ;;
  shell) shift; case "$*" in
    'getprop sys.boot_completed') [ -f "$STUB/not-booted" ] || echo 1 ;;
    'getprop '*) cat "$STUB/props/$2" 2>/dev/null ;;
    'wm size') printf 'Physical size: 1920x1080\\nOverride size: 1080x2400\\n' ;;
    'wm density') printf 'Physical density: 180\\n' ;;
    'dumpsys SurfaceFlinger | grep -m1 GLES') cat "$STUB/gles" 2>/dev/null ;;
    'dumpsys package '*) printf '    versionCode=1078 minSdk=31 targetSdk=33\\n    versionName=1.78.1\\n' ;;
    'pm list packages') cat "$STUB/packages" ;;
    'settings get secure default_input_method') echo 'com.android.inputmethod.latin/.LatinIME' ;;
    'ime list -s') printf 'com.android.inputmethod.latin/.LatinIME\\ncom.example.ime/.Service\\n' ;;
    'am instrument '*) cat "$STUB/instrument/$(printf '%s' "$*" | sed "s/.*-e class '\\([^']*\\)'.*/\\1/")" 2>/dev/null || echo 'INSTRUMENTATION_FAILED: no such runner' ;;
  esac ;;
esac`,
};
const props: Record<string, string> = {
  'ro.build.fingerprint': 'waydroid/lineage_waydroid_x86_64/waydroid_x86_64:13/TQ3A.230901.001/eng:userdebug/test-keys', 'ro.build.display.id': 'lineage_waydroid_x86_64-userdebug 13',
  'ro.build.flavor': 'lineage_waydroid_x86_64-userdebug', 'ro.lineage.version': '20.0-waydroid', 'ro.build.version.release': '13', 'ro.build.version.sdk': '33',
  'ro.product.model': 'WayDroid x86_64 Device', 'ro.product.cpu.abi': 'x86_64', 'ro.hardware.egl': 'mesa', 'ro.hardware.gralloc': 'gbm',
};

/** `am instrument -r` output: one start and one end status per code (0 passed, -1 error, -2 failure, -3 ignored, -4 assumption), then how the run ended. */
const instrumentation = (codes: number[], ending = 'INSTRUMENTATION_CODE: -1') =>
  codes.map((code, i) => `INSTRUMENTATION_STATUS: test=t${i}\nINSTRUMENTATION_STATUS_CODE: 1\nINSTRUMENTATION_STATUS: test=t${i}\nINSTRUMENTATION_STATUS_CODE: ${code}`).join('\n') + `\n${ending}\n`;
const crashed = 'INSTRUMENTATION_RESULT: shortMsg=Process crashed.\nINSTRUMENTATION_CODE: 0';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

const root = await mkdtemp(join(tmpdir(), 'lw-'));
const runtime = join(root, 'run');
const wayland = 'wayland-test';
let listener: ReturnType<typeof Bun.listen>;
beforeAll(async () => { await mkdir(runtime); listener = Bun.listen({ unix: join(runtime, wayland), socket: { data() {} } }); });
afterAll(async () => { listener.stop(true); await rm(root, { recursive: true, force: true }); });

type Options = {
  session?: 'RUNNING' | 'STOPPED'; compositor?: boolean; without?: string[]; files?: Record<string, string>; props?: Record<string, string>; env?: Record<string, string>; instrumentation?: Record<string, string>;
  lock?: 'held' | 'stale'; listed?: boolean; fixture?: 'ok' | 'dies';
};
let runs = 0;
/** One lane run in a fresh sandbox: the stub state, a PATH holding only the stubs and the utilities the script needs, and the evidence it wrote. */
async function lane(args: string[], options: Options = {}) {
  const dir = join(root, `case-${runs++}`), stub = join(dir, 'stub'), bin = join(dir, 'bin'), lock = join(dir, 'lock');
  await mkdir(join(stub, 'props'), { recursive: true });
  await mkdir(join(stub, 'instrument'));
  await mkdir(bin);
  for (const name of utilities) await symlink(Bun.which(name)!, join(bin, name));
  for (const [name, body] of Object.entries(stubs)) if (!options.without?.includes(name)) { await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`); await chmod(join(bin, name), 0o755); }
  const files: Record<string, string> = { session: `${options.session ?? 'STOPPED'}\n`, packages: 'package:app.lazysh.client\npackage:com.touchtype.swiftkey\n', gles: 'GLES: AMD, AMD Radeon Graphics (radeonsi, navi14, ACO), OpenGL ES 3.2 Mesa 26.0.8\n', ...options.files };
  for (const [name, text] of Object.entries(files)) { await mkdir(dirname(join(stub, name)), { recursive: true }); await writeFile(join(stub, name), text); }
  for (const [name, text] of Object.entries({ ...props, ...options.props })) await writeFile(join(stub, 'props', name), `${text}\n`);
  for (const [name, text] of Object.entries(options.instrumentation ?? {})) await writeFile(join(stub, 'instrument', name), text);
  if (options.listed) await writeFile(join(stub, 'listed'), '');
  if (options.lock) { await mkdir(lock); if (options.lock === 'stale') await utimes(lock, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000)); }
  const out = join(dir, 'evidence', 'lane.json');
  const helper = join(dir, 'fixture-helper.sh');
  // A stand-in for tests/support/waydroidSshFixture.ts: prints the ready line, then keeps running until SIGTERM, like the real helper.
  if (options.fixture) await writeFile(helper, options.fixture === 'dies' ? 'echo "sshd is missing" >&2; exit 1\n'
    : `printf '{"x":1}' > "$1/fixture.json"; printf '{"port":4242,"nonce":"${NONCE}","file":"%s"}\\n' "$1/fixture.json"; trap 'echo stopped >> "$STUB/fixture-stopped"; exit 0' TERM; while :; do sleep 0.05; done\n`);
  const env: Record<string, string> = { PATH: bin, STUB: stub, STUB_SERIAL: SERIAL, XDG_RUNTIME_DIR: runtime, HOME: dir, LAZYSH_WAYDROID_LOCK: lock, LAZYSH_WAYDROID_LOCK_WAIT_S: '1', LAZYSH_WAYDROID_LOCK_POLL_S: '0.1',
    LAZYSH_WAYDROID_BOOT_WAIT_S: '5', LAZYSH_WAYDROID_POLL_S: '0.05', ...(options.compositor === false ? {} : { WAYLAND_DISPLAY: wayland }), ...(options.fixture ? { LAZYSH_WAYDROID_FIXTURE_CMD: `exec sh ${helper} "$1"` } : {}), ...options.env };
  const child = Bun.spawn(['/bin/sh', script, '--out', out, ...args], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  const calls = (await readFile(join(stub, 'calls'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { code, stderr, calls, dir, lock, session: (await readFile(join(stub, 'session'), 'utf8')).trim(), evidence: existsSync(out) ? JSON.parse(await readFile(out, 'utf8')) : undefined };
}
const apk = async (name = 'app.apk', body = 'apk bytes') => { const path = join(root, name); await writeFile(path, body); return path; };
const NONCE = '0123456789abcdef0123456789abcdef';
const RUNNER = 'app.lazysh.client.test/androidx.test.runner.AndroidJUnitRunner', CLASS = 'app.lazysh.client.NativeTerminalSurfaceTest';

describe('refuses to run without what it needs, and says what is missing', () => {
  test.each([
    ['waydroid is not installed', { without: ['waydroid'] }, 3, /waydroid is not installed/],
    ['adb is not installed', { without: ['adb'] }, 3, /adb is not installed/],
    ['the container is not active', { files: { 'container-down': '' } }, 4, /container is not active/],
    ['there is no Wayland compositor', { compositor: false }, 5, /no Wayland compositor: WAYLAND_DISPLAY=unset/],
    ['the Wayland socket is gone', { env: { WAYLAND_DISPLAY: 'wayland-gone' } }, 5, /WAYLAND_DISPLAY=wayland-gone has no socket/],
    ['the session cannot start', { files: { 'start-fails': 'waydroid-net.sh start failed\n' } }, 7, /session start failed: waydroid-net.sh start failed/],
    ['the guest never finishes booting', { files: { 'not-booted': '' }, env: { LAZYSH_WAYDROID_BOOT_WAIT_S: '1' } }, 7, /did not finish booting/],
  ] as [string, Options, number, RegExp][])('%s', async (_name, options, code, message) => {
    const result = await lane(['--apk', await apk()], options);
    expect({ code: result.code, evidence: result.evidence, lockReleased: !existsSync(result.lock) }).toEqual({ code, evidence: undefined, lockReleased: true });
    expect(result.stderr).toMatch(message);
    expect(result.calls.filter(call => call.includes(' install '))).toEqual([]);
  });

  test.each([
    ['no --out', [], /--out is required|nothing to run/],
    ['a class that could be a shell command', ['--instrument', RUNNER, "Evil'; reboot; '"], /bad runner or class/],
    ['a benchmark name with a path', ['--bench', '../x', 'true'], /bad benchmark name/],
    ['an unknown flag', ['--skip-everything'], /unknown argument/],
  ] as [string, string[], RegExp][])('usage error: %s', async (_name, args, message) => {
    const child = Bun.spawn(['/bin/sh', script, ...args], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    expect(await child.exited).toBe(2);
    expect(await new Response(child.stderr).text()).toMatch(message);
  });
});

describe('the lane lock', () => {
  test('a held lock fails the run after the wait and is left to its holder', async () => {
    const result = await lane(['--apk', await apk()], { lock: 'held' });
    expect(result.code).toBe(6);
    expect(result.stderr).toMatch(/lock .* is held by another run/);
    expect(existsSync(result.lock)).toBe(true);
    expect(result.calls.some(call => call.startsWith('waydroid session'))).toBe(false);
  });

  test('a stale lock is taken over and released at the end', async () => {
    const result = await lane(['--apk', await apk()], { lock: 'stale' });
    expect(result.code).toBe(0);
    expect(result.stderr).toMatch(/removed a stale lock/);
    expect(existsSync(result.lock)).toBe(false);
  });

  test('a caller that already holds the lock is not blocked by it', async () => {
    const result = await lane(['--apk', await apk()], { lock: 'held', env: { LAZYSH_WAYDROID_LOCK_HELD: '1' } });
    expect({ code: result.code, left: existsSync(result.lock) }).toEqual({ code: 0, left: true });
  });
});

describe('a run that passes', () => {
  test('starts a headless session, installs, runs the class and the benchmark, tears down and writes the evidence', async () => {
    const file = await apk('lane.apk', 'built apk');
    const result = await lane(
      ['--label', 'unit', '--apk', file, '--instrument', RUNNER, CLASS, '--bench', 'frame', 'printf "{\\"frames\\":3}" > "$LAZYSH_LANE_OUT/frames.json"; test "$LAZYSH_BENCH_ANDROID" = ' + SERIAL],
      { instrumentation: { [CLASS]: instrumentation([0, 0, 0]) } });
    expect(result.code).toBe(0);
    expect(result.calls).toContain('waydroid session start');
    expect(result.calls).not.toContain('waydroid show-full-ui');
    expect(result.calls.filter(call => call.includes('am instrument'))).toEqual([`adb -s ${SERIAL} shell am instrument -w -r -e class '${CLASS}' -e lazyshRunId '${result.evidence.runId}' '${RUNNER}'`]);
    // Torn down in the order the lane needs: the app stopped, the connection it opened closed, the session it started stopped.
    expect(result.calls.slice(-3)).toEqual([`adb -s ${SERIAL} shell am force-stop app.lazysh.client`, `adb disconnect ${SERIAL}`, 'waydroid session stop']);
    expect({ session: result.session, lockReleased: !existsSync(result.lock) }).toEqual({ session: 'STOPPED', lockReleased: true });

    const { evidence } = result;
    expect(evidence).toMatchObject({ schema: 1, run: 'waydroid lane', label: 'unit', status: 'passed', failures: [], host: { os: expect.any(String) }, source: { dirty: expect.any(Boolean) } });
    expect(evidence.results).toEqual([
      { kind: 'install', apk: file, sha256: sha('built apk'), ok: true, output: expect.stringContaining('Success') },
      { kind: 'instrumentation', runner: RUNNER, class: CLASS, passed: 3, failed: 0, skipped: 0, ok: true, reason: null },
      { kind: 'benchmark', name: 'frame', command: expect.any(String), exitCode: 0, ok: true, files: [{ path: 'lane-frame-frames.json', sha256: sha('{"frames":3}') }] },
    ]);
    expect(await readFile(join(result.dir, 'evidence', 'lane-frame-frames.json'), 'utf8')).toBe('{"frames":3}');
    expect(evidence.environment).toEqual({
      device: { serial: SERIAL, model: 'WayDroid x86_64 Device', abi: 'x86_64', wmSize: 'Physical size: 1920x1080\nOverride size: 1080x2400', wmDensity: 'Physical density: 180' },
      waydroidImage: { waydroid: 'waydroid 1.6.3', fingerprint: props['ro.build.fingerprint'], display: props['ro.build.display.id'], flavor: props['ro.build.flavor'], lineageVersion: '20.0-waydroid', sessionStartedByLane: true },
      androidVersion: { release: '13', sdk: '33' },
      gpuPath: { path: 'host-gl', egl: 'mesa', gralloc: 'gbm', glesRenderer: 'AMD, AMD Radeon Graphics (radeonsi, navi14, ACO), OpenGL ES 3.2 Mesa 26.0.8' },
      appRevision: { commit: expect.stringMatching(/^[0-9a-f]{40}$/), dirty: expect.any(Boolean), package: 'app.lazysh.client', versionName: '1.78.1', versionCode: '1078' },
      guestIme: { default: 'com.android.inputmethod.latin/.LatinIME', enabled: ['com.android.inputmethod.latin/.LatinIME', 'com.example.ime/.Service'] },
      vendorImesInstalled: ['com.touchtype.swiftkey'],
    });
    // What Waydroid cannot establish is in every result, never "met".
    expect(evidence.acceptedRisk.map((risk: { id: string }) => risk.id)).toEqual(['energy', 'vendor-ime', 'real-gpu-drivers', 'touch', 'thermal', 'aarch64', 'vendor-webview-rom']);
    expect(new Set(evidence.acceptedRisk.map((risk: { status: string }) => risk.status))).toEqual(new Set(['accepted risk, not measured']));
    expect(evidence.limits).toMatch(/not a device result/);
  });

  test('names the run once: the evidence and every benchmark command see the same id', async () => {
    const result = await lane(['--label', 'engine xterm', '--bench', 'one', 'printf %s "$LAZYSH_LANE_RUN_ID" > "$LAZYSH_LANE_OUT/id.txt"', '--bench', 'two', 'printf %s "$LAZYSH_LANE_RUN_ID" > "$LAZYSH_LANE_OUT/id.txt"']);
    const id = result.evidence.runId;
    expect(id).toMatch(/^engine-xterm-\d{8}T\d{6}Z$/);
    for (const name of ['one', 'two']) expect(await readFile(join(result.dir, 'evidence', `lane-${name}-id.txt`), 'utf8')).toBe(id);
  });

  test('removes a package before the install that follows, and a package that is not there is no error', async () => {
    const file = await apk();
    const result = await lane(['--uninstall', 'app.lazysh.client', '--uninstall', 'app.lazysh.client.test', '--apk', file], { files: { 'not-installed': '' } });
    expect(result.code).toBe(0);
    expect(result.evidence.results.map((entry: { kind: string }) => entry.kind)).toEqual(['uninstall', 'uninstall', 'install']);
    expect(result.calls.filter(call => /uninstall|install -r/.test(call))).toEqual([`adb -s ${SERIAL} uninstall app.lazysh.client`, `adb -s ${SERIAL} uninstall app.lazysh.client.test`, `adb -s ${SERIAL} install -r -t ${file}`]);
    expect((await lane(['--uninstall', 'x; reboot', '--apk', file])).code).toBe(2);
  });

  test('keeps the evidence a class leaves on the guest beside its own, listed with a hash', async () => {
    const result = await lane(['--apk', await apk(), '--instrument', RUNNER, CLASS], { instrumentation: { [CLASS]: instrumentation([0]) }, files: { 'device-evidence/native-acceptance.json': '{"cases":[]}' } });
    expect(result.evidence.results.at(-1).files).toEqual([{ path: `lane-${CLASS.split('.').pop()}-native-acceptance.json`, sha256: sha('{"cases":[]}') }]);
    expect(await readFile(join(result.dir, 'evidence', `lane-${CLASS.split('.').pop()}-native-acceptance.json`), 'utf8')).toBe('{"cases":[]}');
    expect(result.calls).toContain(`adb -s ${SERIAL} shell rm -rf /data/local/tmp/lazysh-evidence`);
  });

  test('attaches to a running session without a compositor, and leaves the session and an existing connection as it found them', async () => {
    const result = await lane(['--apk', await apk()], { session: 'RUNNING', compositor: false, listed: true });
    expect(result.code).toBe(0);
    expect(result.calls.filter(call => call.startsWith('waydroid session'))).toEqual([]);
    expect(result.calls).not.toContain(`adb disconnect ${SERIAL}`);
    expect(result.session).toBe('RUNNING');
    expect(result.evidence.environment.waydroidImage.sessionStartedByLane).toBe(false);
  });

  test.each([
    ['a software rasterizer', { gles: 'GLES: Google (SwiftShader), Vulkan 1.3 (SwiftShader Device)\n' }, {}, 'software'],
    ['nothing readable', { gles: '' }, { 'ro.hardware.egl': '' }, 'unknown'],
  ] as [string, Record<string, string>, Record<string, string>, string][])('names the GPU path: %s', async (_name, files, guest, path) => {
    const result = await lane(['--apk', await apk()], { files, props: guest });
    expect(result.evidence.environment.gpuPath.path).toBe(path);
  });
});

describe('a run that cannot be trusted fails and says why', () => {
  test.each([
    ['a test failed', instrumentation([0, -2]), /1 test\(s\) failed/, { passed: 1, failed: 1, skipped: 0 }],
    ['a test erred', instrumentation([-1]), /1 test\(s\) failed/, { passed: 0, failed: 1, skipped: 0 }],
    ['a test was skipped by an assumption', instrumentation([0, -4]), /1 test\(s\) skipped: the lane does not skip/, { passed: 1, failed: 0, skipped: 1 }],
    ['a test was ignored', instrumentation([-3]), /skipped/, { passed: 0, failed: 0, skipped: 1 }],
    ['no test ran', instrumentation([]), /no test ran for this class/, { passed: 0, failed: 0, skipped: 0 }],
    ['the process crashed', instrumentation([0], crashed), /did not finish/, { passed: 1, failed: 0, skipped: 0 }],
    ['the runner is not installed', 'INSTRUMENTATION_FAILED: app.lazysh.client.test/x', /did not finish/, { passed: 0, failed: 0, skipped: 0 }],
  ] as [string, string, RegExp, object][])('instrumentation: %s', async (_name, output, reason, counts) => {
    const result = await lane(['--apk', await apk(), '--instrument', RUNNER, CLASS], { instrumentation: { [CLASS]: output } });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/FAILED: instrument /);
    expect(result.evidence.status).toBe('failed');
    expect(result.evidence.results.at(-1)).toMatchObject({ kind: 'instrumentation', ok: false, reason: expect.stringMatching(reason), ...counts });
  });

  test('a failing class does not hide the next one', async () => {
    const other = 'app.lazysh.client.OtherTest';
    const result = await lane(['--apk', await apk(), '--instrument', RUNNER, CLASS, '--instrument', RUNNER, other], { instrumentation: { [CLASS]: instrumentation([-2]), [other]: instrumentation([0]) } });
    expect(result.code).toBe(1);
    expect(result.evidence.results.slice(1).map((entry: { class: string; ok: boolean }) => [entry.class, entry.ok])).toEqual([[CLASS, false], [other, true]]);
  });

  test('an install that fails stops the run before any test, and the evidence says the rest did not run', async () => {
    const result = await lane(['--apk', await apk(), '--instrument', RUNNER, CLASS], { files: { 'install-fails': '' }, instrumentation: { [CLASS]: instrumentation([0]) } });
    expect(result.code).toBe(1);
    expect(result.calls.some(call => call.includes('am instrument'))).toBe(false);
    expect(result.evidence.failures).toEqual([expect.stringMatching(/was not installed: Failure \[INSTALL_FAILED_OLDER_SDK\]/), 'the steps after the failed setup step did not run']);
  });

  test('a missing APK fails before anything is installed', async () => {
    const result = await lane(['--apk', join(root, 'missing.apk')]);
    expect(result.code).toBe(1);
    expect(result.evidence.failures).toEqual([expect.stringMatching(/missing.apk does not exist/), expect.any(String)]);
  });

  test('a benchmark that exits non-zero fails the lane and records its exit code', async () => {
    const result = await lane(['--apk', await apk(), '--bench', 'bad', 'exit 3']);
    expect(result.code).toBe(1);
    expect(result.evidence.results.at(-1)).toMatchObject({ kind: 'benchmark', name: 'bad', exitCode: 3, ok: false, files: [] });
  });

  test('a benchmark that exits zero but leaves no result file measured nothing and fails', async () => {
    const result = await lane(['--apk', await apk(), '--bench', 'quiet', 'true']);
    expect(result.code).toBe(1);
    expect(result.evidence.failures).toEqual([expect.stringMatching(/bench quiet wrote no result file .* nothing was measured/)]);
    expect(result.evidence.results.at(-1)).toMatchObject({ name: 'quiet', exitCode: 0, ok: false });
  });
});

describe('building with the existing android-apk.sh entry points', () => {
  test('passes the SDK, the JDK, an output path and the assets directory to the build script, then installs what it built', async () => {
    const build = join(root, 'build.sh');
    await writeFile(build, 'printf "%s\\n" "$1" "$2" "$4" > "$0.args"; printf built > "$3"\n');
    const result = await lane(['--build', build], { env: { ANDROID_HOME: '/sdk', JAVA_HOME: '/jdk', LAZYSH_WAYDROID_BUILD_ASSETS: '/assets' } });
    expect(result.code).toBe(0);
    const installed = result.evidence.results[0];
    expect(installed).toMatchObject({ kind: 'install', ok: true, sha256: sha('built') });
    expect(installed.apk).toMatch(/\.apk$/);
    expect((await readFile(`${build}.args`, 'utf8')).trim().split('\n')).toEqual(['/sdk', '/jdk', '/assets']);
  });

  test('without an SDK and a JDK the build fails with a message instead of building with nothing', async () => {
    const result = await lane(['--build', join(root, 'build.sh')], { env: { ANDROID_HOME: '', JAVA_HOME: '' } });
    expect(result.code).toBe(1);
    expect(result.evidence.failures[0]).toMatch(/needs ANDROID_HOME .* and JAVA_HOME/);
  });
});

describe('the owned SSH fixture', () => {
  const remote = `/data/local/tmp/lazysh-ui-ssh-${NONCE}`;

  test('is started, reversed to the guest, pushed, handed to the instrumentation and torn down afterwards', async () => {
    const result = await lane(['--owned-ssh-fixture', '--apk', await apk(), '--instrument', RUNNER, CLASS], { fixture: 'ok', instrumentation: { [CLASS]: instrumentation([0]) } });
    expect(result.code).toBe(0);
    const adb = result.calls.filter(call => /^adb -s \S+ (reverse|push|shell (mkdir|chmod|rm|am instrument))/.test(call)).map(call => call.replace(`adb -s ${SERIAL} `, ''));
    expect(adb).toEqual([
      'reverse --no-rebind tcp:4242 tcp:4242', `shell mkdir -m 700 ${remote}`, expect.stringMatching(new RegExp(`^push \\S+/fixture/fixture.json ${remote}/fixture.json$`)),
      `shell chmod 600 ${remote}/fixture.json`, 'shell rm -rf /data/local/tmp/lazysh-evidence', `shell am instrument -w -r -e class '${CLASS}' -e lazyshRunId '${result.evidence.runId}' -e lazyshSshFixture '${remote}/fixture.json' '${RUNNER}'`,
      'reverse --remove tcp:4242', `shell rm -rf ${remote}`,
    ]);
    expect(await readFile(join(result.dir, 'stub', 'fixture-stopped'), 'utf8')).toBe('stopped\n');
    expect(result.evidence.status).toBe('passed');
  });

  test('is torn down when the instrumentation fails', async () => {
    const result = await lane(['--owned-ssh-fixture', '--apk', await apk(), '--instrument', RUNNER, CLASS], { fixture: 'ok', instrumentation: { [CLASS]: instrumentation([-2]) } });
    expect(result.code).toBe(1);
    expect(result.calls).toContain(`adb -s ${SERIAL} reverse --remove tcp:4242`);
    expect(result.calls).toContain(`adb -s ${SERIAL} shell rm -rf ${remote}`);
    expect(existsSync(join(result.dir, 'stub', 'fixture-stopped'))).toBe(true);
  });

  test('a helper that cannot start the server fails the run before any test, with its message', async () => {
    const result = await lane(['--owned-ssh-fixture', '--apk', await apk(), '--instrument', RUNNER, CLASS], { fixture: 'dies', instrumentation: { [CLASS]: instrumentation([0]) } });
    expect(result.code).toBe(1);
    expect(result.evidence.failures[0]).toMatch(/owned SSH fixture did not start: sshd is missing/);
    expect(result.calls.some(call => call.includes('am instrument') || call.includes(' reverse '))).toBe(false);
  });

  test('without the option nothing is started and no fixture argument is passed', async () => {
    const result = await lane(['--apk', await apk(), '--instrument', RUNNER, CLASS], { instrumentation: { [CLASS]: instrumentation([0]) } });
    expect(result.calls.filter(call => call.includes(' reverse ') || call.includes('lazyshSshFixture'))).toEqual([]);
  });

  test('the real helper serves an sshd, writes the fixture and retires the server on SIGTERM', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lw-helper-'));
    const child = Bun.spawn(['bun', join(project, 'tests', 'support', 'waydroidSshFixture.ts'), dir], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    const reader = child.stdout.getReader();
    const ready = JSON.parse(new TextDecoder().decode((await reader.read()).value));
    const fixture = JSON.parse(await readFile(ready.file, 'utf8'));
    const reachable = (port: number) => new Promise<boolean>(resolve => { Bun.connect({ hostname: '127.0.0.1', port, socket: { open(socket) { socket.end(); resolve(true); }, data() {}, error() { resolve(false); }, connectError() { resolve(false); } } }).catch(() => resolve(false)); });
    expect({ nonce: ready.nonce === fixture.nonce && /^[a-f0-9]{32}$/.test(ready.nonce), port: fixture.port === ready.port, privateKey: fixture.privateKey.includes('PRIVATE KEY'), listening: await reachable(ready.port) })
      .toEqual({ nonce: true, port: true, privateKey: true, listening: true });
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(await reachable(ready.port)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('thawing the guest', () => {
  test('launches the app before the first adb command and before stopping it, since Waydroid freezes an idle container', async () => {
    const result = await lane(['--apk', await apk()]);
    const launch = 'waydroid app launch app.lazysh.client';
    const firstShell = result.calls.findIndex(call => call.startsWith('adb -s') && call.includes(' shell '));
    expect(result.calls.indexOf(launch)).toBeGreaterThanOrEqual(0);
    expect(result.calls.indexOf(launch)).toBeLessThan(firstShell);
    expect(result.calls.at(-4)).toBe(launch);
    expect(result.calls.at(-3)).toBe(`adb -s ${SERIAL} shell am force-stop app.lazysh.client`);
  });
});

describe('failure details in the evidence', () => {
  test('a failed test carries its class, name, message and stack', async () => {
    const failure = [
      'INSTRUMENTATION_STATUS: class=app.lazysh.client.NativeTerminalCoreTest', 'INSTRUMENTATION_STATUS: test=theCore', 'INSTRUMENTATION_STATUS_CODE: 1',
      'INSTRUMENTATION_STATUS: class=app.lazysh.client.NativeTerminalCoreTest', 'INSTRUMENTATION_STATUS: test=theCore',
      'INSTRUMENTATION_STATUS: stack=java.lang.IllegalArgumentException: An owned SSH fixture path is required', '\tat app.lazysh.client.OwnedSshFixtureKt.ownedSshFixture(OwnedSshFixture.kt:9)', '\tat org.junit.Foo.bar(Foo.java:1)',
      'INSTRUMENTATION_STATUS_CODE: -2', 'INSTRUMENTATION_STATUS: class=other', 'INSTRUMENTATION_STATUS: test=fine', 'INSTRUMENTATION_STATUS_CODE: 0', 'INSTRUMENTATION_CODE: -1', ''].join('\n');
    const result = await lane(['--apk', await apk(), '--instrument', RUNNER, CLASS], { instrumentation: { [CLASS]: failure } });
    expect(result.code).toBe(1);
    const entry = result.evidence.results.at(-1);
    expect(entry.failedTests).toEqual([{
      class: 'app.lazysh.client.NativeTerminalCoreTest', test: 'theCore', message: 'java.lang.IllegalArgumentException: An owned SSH fixture path is required',
      stack: 'java.lang.IllegalArgumentException: An owned SSH fixture path is required\n\tat app.lazysh.client.OwnedSshFixtureKt.ownedSshFixture(OwnedSshFixture.kt:9)\n\tat org.junit.Foo.bar(Foo.java:1)',
    }]);
    expect(entry.reason).toBe('1 test(s) failed: theCore: java.lang.IllegalArgumentException: An owned SSH fixture path is required');
    expect(result.evidence.failures[0]).toContain('An owned SSH fixture path is required');
  });
});

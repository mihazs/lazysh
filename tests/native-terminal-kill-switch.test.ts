import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { document, evaluate, executedSteps, interpolate } from './support/workflowGraph';
import { project, spawnText } from './support/gitFixture';

const temporary: string[] = [];
afterAll(() => Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))));
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'lazysh-kill-switch-test-')); temporary.push(path); return path; };

const resolver = join(project, '.github', 'scripts', 'native-terminal-switch.sh');
test.each([
  ['', '', 'on'], ['default', '', 'on'], ['', 'on', 'on'], ['', 'off', 'off'], ['default', 'off', 'off'],
  ['off', '', 'off'], ['off', 'on', 'off'], ['on', 'off', 'on'], ['on', '', 'on'],
])('input "%s" and repository variable "%s" build with the switch %s', async (input, variable, expected) => {
  expect(await spawnText(project, ['sh', resolver, input, variable])).toEqual({ code: 0, stdout: `${expected}\n`, stderr: '' });
});

test.each([['maybe', '', 'native-terminal must be default, on or off, not "maybe"'], ['', 'OFF', 'LAZYSH_NATIVE_TERMINAL must be on or off, not "OFF"'],
  ['default', 'false', 'not "false"']])('input "%s" and repository variable "%s" stop the release before it builds', async (input, variable, message) => {
  const result = await spawnText(project, ['sh', resolver, input, variable]);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(message);
});

// The step the release builds run, executed as Actions would: its env from the called workflow's input default and the repository variable.
test('every release build resolves the switch into the environment before its build, from the input or the repository variable', async () => {
  const workflow = await document('.github/workflows/release-artifacts.yml');
  expect(workflow.on.workflow_call.inputs['native-terminal'].default).toBe('default');
  expect(workflow.on.workflow_dispatch.inputs['native-terminal'].options).toEqual(['default', 'on', 'off']);
  // GitHub validates a dispatched value against the options read as YAML 1.1, where a bare on or off is a boolean and `-f native-terminal=off` is refused (HTTP 422): the quotes are part of the contract.
  expect(await Bun.file(join(project, '.github/workflows/release-artifacts.yml')).text()).toContain('options: [default, "on", "off"]');
  for (const [job, build] of [['desktop', 'tauri build'], ['android', 'tauri android build'], ['ios', 'tauri ios build']] as const) {
    const steps = workflow.jobs[job].steps as any[];
    const resolve = steps.findIndex(step => step.name === 'Resolve the native terminal kill switch');
    expect(resolve, job).toBeGreaterThan(0);
    // The step is POSIX shell: a job with a Windows runner runs its steps in PowerShell unless the step names bash (the v1.97.7 publish failed there).
    const runners = (workflow.jobs[job].strategy?.matrix?.include ?? []).map((entry: any) => entry.os).concat(workflow.jobs[job]['runs-on']);
    if (runners.some((runner: string) => String(runner).startsWith('windows'))) expect(steps[resolve].shell, job).toBe('bash');
    expect(resolve, job).toBeLessThan(steps.findIndex(step => step.run?.includes(build)));
    for (const [input, variable, expected] of [['default', undefined, 'on'], ['default', 'off', 'off'], ['on', 'off', 'on'], ['off', undefined, 'off']] as const) {
      const root = await directory();
      const env = join(root, 'github-env');
      await writeFile(env, '');
      const context = { inputs: { 'native-terminal': input }, vars: { LAZYSH_NATIVE_TERMINAL: variable } };
      const step = steps[resolve];
      const stepEnv = Object.fromEntries(Object.entries<any>(step.env).map(([key, value]) => [key, String(interpolate(value, context) ?? '')]));
      const result = await spawnText(project, ['bash', '-e', '-c', step.run], { ...process.env, ...stepEnv, GITHUB_ENV: env });
      expect(result.code, `${job} ${input} ${variable}`).toBe(0);
      expect(await Bun.file(env).text(), `${job} ${input} ${variable}`).toBe(`LAZYSH_NATIVE_TERMINAL=${expected}\n`);
    }
  }
});

const engine = join(project, '.github', 'scripts', 'apk-engine.ts');
const jni = 'Java_app_lazysh_client_JniSurface_nativeReady', renderer = 'wgpu_core::device::resource';
/** An APK whose arm64 library holds the given bytes, built with Python's zipfile (a real ZIP, read back by `unzip`). */
async function apk(library: string | null) {
  const root = await directory();
  const path = join(root, 'app.apk');
  const script = 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],"w")\nz.writestr("classes.dex","dex")\nif sys.argv[2]!="-":z.writestr("lib/arm64-v8a/liblazysh_lib.so",sys.argv[2])\nz.close()';
  const built = await spawnText(root, ['python3', '-I', '-c', script, path, library ?? '-']);
  expect(built.code, built.stderr).toBe(0);
  return path;
}
const check = (path: string, flavor: string, killSwitch?: string) => spawnText(project, ['bun', engine, path, flavor, ...(killSwitch ? [killSwitch] : [])], { ...process.env, GITHUB_STEP_SUMMARY: '' });
const withEngine = `\n${jni}\nabc\n${renderer}\n${renderer}\n`, withoutEngine = '\nJava_app_lazysh_client_Other_native\nabc\n', half = `\n${jni}\nabc\n`;

test.each([
  ['google', 'on', withEngine, 0], ['google', undefined, withEngine, 0], ['google', 'on', withoutEngine, 1], ['google', 'on', half, 1],
  ['google', 'off', withoutEngine, 0], ['google', 'off', withEngine, 1], ['google', 'off', half, 1],
  ['foss', 'on', withoutEngine, 0], ['foss', 'off', withoutEngine, 0], ['foss', undefined, withEngine, 1], ['foss', 'on', half, 1],
] as const)('the %s APK built with the kill switch %s and a library %#: exit %i', async (flavor, killSwitch, library, code) => {
  const result = await check(await apk(library), flavor, killSwitch);
  expect(result.code, result.stdout + result.stderr).toBe(code);
  expect(result.stdout).toContain(`${library.includes(jni) ? 1 : 0} surface host entry points and ${(library.match(/wgpu/g) ?? []).length} wgpu strings`);
});

test('the verdict is added to the job summary', async () => {
  const summary = join(await directory(), 'summary.md');
  const result = await spawnText(project, ['bun', engine, await apk(withEngine), 'google', 'on'], { ...process.env, GITHUB_STEP_SUMMARY: summary });
  expect(result.code).toBe(0);
  expect(await Bun.file(summary).text()).toBe(`- ${result.stdout}`);
});

test.each([['a missing arm64 library', () => apk(null), 'google', 'on'], ['a file that is no APK', async () => join(project, 'package.json'), 'google', 'on'],
  ['an APK that does not exist', async () => '/nonexistent/app.apk', 'foss', 'on'], ['an unknown flavor', () => apk(withEngine), 'huawei', 'on'], ['an unknown switch', () => apk(withEngine), 'google', 'maybe']])
('%s is a usage or input error, never a verdict', async (_, path, flavor, killSwitch) => {
  const result = await check(await path(), flavor, killSwitch);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
});

test('macOS bundle rehearsal isolates the native and rollback build profiles', async () => {
  const {jobs} = await document('.github/workflows/terminal-macos-surface.yml');
  for (const mode of ['surface', 'on', 'off']) {
    const context = {github: {event_name: 'workflow_dispatch'}, inputs: {package_engine: mode}};
    expect(evaluate(jobs['terminal-macos-surface'].if, context)).toBe(mode === 'surface');
    const entries = await executedSteps(jobs['terminal-macos-app-host'].steps, context);
    const named = (name: string) => entries.find(({step}) => step.name === name);
    expect(Boolean(named('Read the running Lazysh window'))).toBe(mode === 'surface');
    expect(entries.some(({step}) => step.uses === './.github/actions/ghostty-zig')).toBe(mode !== 'off');
    const bundle = named('Build and verify an ad-hoc macOS release app');
    expect(Boolean(bundle)).toBe(mode !== 'surface');
    if (!bundle) continue;
    const script = bundle.step.run.split('\napp=')[0];
    const run = await spawnText(project, ['bash', '-e', '-c', ['bun() { printf "%s\\n" "$@"; }', script].join('\n')], {
      ...process.env, LAZYSH_NATIVE_TERMINAL: mode,
    });
    expect(run.code).toBe(0);
    const args = run.stdout.trim().split('\n');
    expect(args.includes('native-terminal')).toBe(mode === 'on');
    expect(args.at(-1)).toBe('--locked');
    expect(interpolate(named('Retain the signed rehearsal bundle and receipt')!.step.with.name, context))
      .toBe('lazysh-macos-native-package-' + mode);
  }
});

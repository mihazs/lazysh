import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../', import.meta.url).pathname;
const workflow = Bun.YAML.parse(await Bun.file(join(root, '.github/workflows/checks.yml')).text()) as {
  jobs: Record<string, { steps: { id?: string; name?: string; if?: string; run?: string; with?: { path?: string } }[] }>;
};
const steps = workflow.jobs['native-ios-simulator'].steps;
const capture = steps.find(step => step.name === 'Capture failed workspace filesystem metadata')!;
const uuid = 'EB74BECE-E495-447F-94D4-1A3AF75F6ADF';
const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

function project(settings: Record<string, unknown> = {}) {
  return { rootObject: 'project', objects: {
    project: { isa: 'PBXProject', targets: ['workspace', 'other'], buildConfigurationList: 'list' },
    workspace: { isa: 'PBXNativeTarget', name: 'LazyshWorkspaceUITests', productType: 'com.apple.product-type.bundle.ui-testing', buildConfigurationList: 'list' },
    other: { isa: 'PBXNativeTarget', name: 'PRIVATE-TARGET', buildConfigurationList: 'secret-list' },
    list: { isa: 'XCConfigurationList', buildConfigurations: ['config'] },
    config: { isa: 'XCBuildConfiguration', name: 'debug', buildSettings: {
      SDKROOT: 'iphoneos', IPHONEOS_DEPLOYMENT_TARGET: '16.2', ARCHS: ['arm64'], TEST_HOST: '',
      CODE_SIGN_IDENTITY: 'PRIVATE-SIGNING', CUSTOM_TOKEN: 'PRIVATE-TOKEN', ...settings,
    } },
  } };
}

async function fixture(data: unknown, outcome = 'failure', conversionFailure = false) {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-ios-metadata-'));
  temporary.push(directory);
  const bin = join(directory, 'bin');
  const runnerTemp = join(directory, 'runner');
  const projectDir = join(directory, 'apps/client/src-tauri/gen/apple/lazysh.xcodeproj');
  await Promise.all([mkdir(bin), mkdir(runnerTemp), mkdir(projectDir, { recursive: true }), mkdir(join(directory, '.github'))]);
  await writeFile(join(projectDir, 'project.pbxproj'), JSON.stringify(data));
  await writeFile(join(directory, '.github/ios-workspace-metadata.jq'), await Bun.file(join(root, '.github/ios-workspace-metadata.jq')).text());
  const invocationFile = join(directory, 'calls');
  for (const command of ['plutil', 'xcodebuild', 'xcrun', 'simctl']) {
    const path = join(bin, command);
    await writeFile(path, `#!/bin/bash\nprintf '%s\\n' '${command}' >> "$CALLS"\n${command === 'plutil' ? 'test "$CONVERSION_FAILURE" != 1 || exit 9\ncp "$5" "$4"' : 'exit 97'}\n`);
    await chmod(path, 0o755);
  }
  const child = Bun.spawn(['bash', '-e', '-c', capture.run!], { cwd: directory,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp,
      APPLE_STATUS_SIMULATOR_ID: uuid, WORKSPACE_OUTCOME: outcome, CALLS: invocationFile,
      CONVERSION_FAILURE: conversionFailure ? '1' : '0' }, stdout: 'pipe', stderr: 'pipe' });
  const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(exit).toBe(0);
  expect(stdout).toBe('');
  expect(stderr).toBe('');
  const calls = await Bun.file(invocationFile).exists() ? await readFile(invocationFile, 'utf8') : '';
  expect(calls.split('\n').filter(Boolean).every(call => call === 'plutil')).toBe(true);
  expect((await readdir(runnerTemp)).filter(name => name.includes('private'))).toEqual([]);
  return { directory, output: join(runnerTemp, 'lazysh-ios-workspace-metadata'), calls };
}

test('failure-only capture leaves the original workspace step and outcome intact', async () => {
  expect(capture.if).toBe("${{ !cancelled() && steps.ios-workspace.outcome == 'failure' }}");
  const original = steps.find(step => step.id === 'ios-workspace')!;
  expect(original.run).toBe('bun run test:ios-workspace');
  expect(original).not.toHaveProperty('continue-on-error');
  for (const outcome of ['success', 'skipped', 'cancelled']) {
    const result = await fixture(project(), outcome);
    expect(await Bun.file(join(result.output, 'status.txt')).exists()).toBe(false);
    expect(result.calls).toBe('');
  }
  expect(steps.find(step => step.name === 'Upload iOS app acceptance results')!.with!.path)
    .toContain('${{ runner.temp }}/lazysh-ios-workspace-metadata');
});

test('retains only bounded project/configuration fields and a path-free SHA', async () => {
  const result = await fixture(project({ TEST_HOST: 'x'.repeat(500) }));
  const output = await readFile(join(result.output, 'project.json'), 'utf8');
  expect(output).not.toContain('PRIVATE');
  const decoded = JSON.parse(output);
  expect(decoded.workspaceTarget.configurations.values[0].settings.TEST_HOST).toBe('x'.repeat(125) + '...');
  expect(decoded.project.values[0].settings.IPHONEOS_DEPLOYMENT_TARGET).toBe('16.2');
  expect(await readFile(join(result.output, 'project.sha256'), 'utf8')).toMatch(/^[a-f0-9]{64}\n$/);
  for (const file of await readdir(result.output)) expect((await stat(join(result.output, file))).size).toBeLessThanOrEqual(32768);
});

test.each([
  { data: { unexpected: 'PRIVATE-DATA' }, conversionFailure: false },
  { data: project(), conversionFailure: true },
  { data: { oversized: 'x'.repeat(2097152) }, conversionFailure: false },
])('unknown, failed or oversized conversion remains unavailable', async ({ data, conversionFailure }) => {
  const result = await fixture(data, 'failure', conversionFailure);
  expect(await readFile(join(result.output, 'status.txt'), 'utf8')).toContain('project=unavailable');
  expect(await Bun.file(join(result.output, 'project.json')).exists()).toBe(false);
});

test('device filter retains persisted identity/state only and rejects mismatched or unknown schemas', async () => {
  for (const valid of [true, false]) {
    const child = Bun.spawn(['jq', '--arg', 'kind', 'device', '--arg', 'device', uuid, '-f', join(root, '.github/ios-workspace-metadata.jq')],
      { stdin: new TextEncoder().encode(JSON.stringify({ UDID: valid ? uuid : 'other', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
        deviceType: 'com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro', state: 3, name: 'PRIVATE-NAME', account: 'PRIVATE-ACCOUNT' })), stdout: 'pipe', stderr: 'pipe' });
    const [exit, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(exit === 0).toBe(valid);
    if (valid) {
      expect(Object.keys(JSON.parse(output)).sort()).toEqual(['UDID', 'availability', 'deviceType', 'persistedState', 'runtime']);
      expect(output).toContain('unknown (filesystem metadata only)');
      expect(output).not.toContain('PRIVATE');
    }
  }
});

test('configuration lists and architecture arrays retain explicit truncation markers', async () => {
  const data = project({ ARCHS: Array.from({ length: 12 }, (_, index) => `arch${index}`) });
  data.objects.list.buildConfigurations = Array(40).fill('config');
  const result = await fixture(data);
  const decoded = JSON.parse(await readFile(join(result.output, 'project.json'), 'utf8'));
  expect(decoded.project.truncated).toBe(true);
  expect(decoded.project.values).toHaveLength(32);
  expect(decoded.project.values[0].settings.ARCHS).toEqual(['arch0', 'arch1', 'arch2', 'arch3', 'arch4', 'arch5', 'arch6', '[truncated]']);
});

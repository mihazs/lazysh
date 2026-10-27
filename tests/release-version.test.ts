import { afterEach, expect, test } from 'bun:test';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { synchronizeWorkspaceVersions } from '../.changeset/bun-lock';

const source = new URL('../', import.meta.url).pathname;
const tauriCli = join(source, 'node_modules/@tauri-apps/cli/tauri.js');
const json = (directory: string, path: string) => Bun.file(join(directory, path)).json();
const temporary: string[] = [];
const platformSources = [
  'apps/client/src-tauri/apple/project.yml.hbs',
  'apps/client/src-tauri/Info.plist',
  'apps/client/src-tauri/gen/android/app/build.gradle.kts',
  'apps/client/src-tauri/gen/android/app/src/main/AndroidManifest.xml',
];
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

type CommandOptions = { cwd?: string; stdin?: Uint8Array; env?: Record<string, string> };
async function command(directory: string, args: string[], options: CommandOptions = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...options.env,
    CARGO_TARGET_DIR: join(directory, 'target'), GIT_CONFIG_GLOBAL: join(directory, 'empty.gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key];
  const child = Bun.spawn(args, { cwd: options.cwd ?? directory, stdout: 'pipe', stderr: 'pipe',
    stdin: options.stdin,
    env });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

async function successful(directory: string, args: string[], options: CommandOptions = {}) {
  const result = await command(directory, args, options);
  expect(result, args.join(' ')).toMatchObject({ code: 0 });
  return result;
}

async function debianVersion(directory: string, archive: string) {
  const child = Bun.spawn(['ar', 'p', archive, 'control.tar.gz'], { cwd: directory, stdout: 'pipe', stderr: 'pipe' });
  const [code, control] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()]);
  expect(code).toBe(0);
  const extracted = await command(directory, ['tar', '-xzO'], { stdin: new Uint8Array(control) });
  expect(extracted.code).toBe(0);
  return [...extracted.stdout.matchAll(/^Version: (.+)$/gm)].map(match => match[1]);
}

async function fixture(fragment?: string, sourceVersion?: string) {
  const parent = join(homedir(), 'dev', '.worktrees');
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'lazysh-release-'));
  temporary.push(directory);
  await writeFile(join(directory, 'empty.gitconfig'), '');
  const tooling = await json(source, 'package.json');
  if (sourceVersion !== undefined) tooling.version = sourceVersion;
  tooling.version = '0.1.0';
  tooling.devDependencies = { '@changesets/cli': '3.0.3', jscpd: '5.4.2' };
  const members = (Bun.TOML.parse(await Bun.file(join(source, 'Cargo.toml')).text()) as any).workspace.members as string[];
  await writeFile(join(directory, 'package.json'), JSON.stringify(tooling, null, 2));
  await writeFile(join(directory, 'Cargo.toml'), `[workspace]\nmembers = ${JSON.stringify(members)}\nexclude = ["packages/portable-pty-vendor", "packages/deep-link-vendor"]\nresolver = "2"\n[workspace.package]\nversion = "0.1.0"\n`);
  for (const path of members) {
    await mkdir(join(directory, path, 'src'), { recursive: true });
    const native = (Bun.TOML.parse(await Bun.file(join(source, path, 'Cargo.toml')).text()) as any).package;
    await writeFile(join(directory, path, 'Cargo.toml'), `[package]\nname = "${native.name}"\nversion.workspace = true\nedition = "2021"\n`);
    const client = path === 'apps/client/src-tauri';
    await writeFile(join(directory, path, 'src', client ? 'main.rs' : 'lib.rs'), client ? 'fn main() {}\n' : '');
    const jsPath = client ? 'apps/client' : path;
    const pkg = await json(source, `${jsPath}/package.json`);
    await writeFile(join(directory, jsPath, 'package.json'), JSON.stringify({ name: pkg.name, version: '0.1.0', private: true }));
  }
  for (const [name, version] of [['portable-pty-vendor', '0.9.0'], ['deep-link-vendor', '2.6.2']]) {
    await mkdir(join(directory, 'packages', name), { recursive: true });
    await writeFile(join(directory, 'packages', name, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "${version}"\n`);
  }
  await mkdir(join(directory, '.changeset'));
  await mkdir(join(directory, 'tests'));
  for (const path of ['.changeset/config.json', '.changeset/bun-lock.ts', 'tests/release-consistency.test.ts', 'CHANGELOG.md']) {
    await copyFile(join(source, path), join(directory, path));
  }
  if (fragment !== undefined) await writeFile(join(directory, '.changeset', 'owned-test.md'), fragment);
  await writeFile(join(directory, 'apps/client/src-tauri/tauri.conf.json'), JSON.stringify({
    version: (await json(source, 'apps/client/src-tauri/tauri.conf.json')).version,
    productName: 'lazysh', identifier: 'app.lazysh.client', bundle: { active: true, targets: ['deb'], icon: ['icon.png'] },
  }));
  await copyFile(join(source, 'apps/client/src-tauri/icons/32x32.png'), join(directory, 'apps/client/src-tauri/icon.png'));
  for (const path of platformSources) {
    await mkdir(join(directory, path, '..'), { recursive: true });
    await copyFile(join(source, path), join(directory, path));
  }
  await successful(directory, ['git', 'init', '--initial-branch=main']);
  await successful(directory, ['git', '-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Owned fixture']);
  await successful(directory, ['cargo', 'generate-lockfile', '--offline']);
  await successful(directory, ['bun', 'install', '--ignore-scripts']);
  return directory;
}

const fragment = (impact: string) => `---\n"@lazysh/client": ${impact}\n---\n\nOwned release fixture entry.\n`;

test('real multi-package release preparation scopes generated history but rejects handwritten clones', async () => {
  const directory = await fixture('---\n"@lazysh/agent": minor\n"@lazysh/client": minor\n---\n\nReport bounded session history through explicit companion queries without changing existing reads or defaults. Keep observations associated with their original timestamps and exact selected session. The feature exposes reported metadata only after a deliberate choice and leaves transcript reads behind their existing confirmation boundary. A missing report remains unavailable, and a recorded report does not establish that the process is still running. Native diagnostics remain literal throughout the selected interface language.\n');
  await copyFile(join(source, '.jscpd.json'), join(directory, '.jscpd.json'));
  const manifests = [...new Bun.Glob('{apps,packages}/*/package.json').scanSync({ cwd: directory })];
  const generated = manifests.map(path => path.replace('package.json', 'CHANGELOG.md')).sort();
  expect(generated).toHaveLength(15);
  for (const path of generated) await copyFile(join(source, path), join(directory, path));
  const result = await successful(directory, ['bun', 'run', 'release:prepare']);
  expect(result.stdout + result.stderr).toContain('Found 0 clones.');
  expect((await json(directory, 'package.json')).version).toBe('0.2.0');
  for (const path of ['apps/agent/CHANGELOG.md', 'apps/client/CHANGELOG.md']) {
    expect(await Bun.file(join(directory, path)).text()).toContain('Report bounded session history');
  }
  const config = await json(directory, '.jscpd.json');
  expect(config.ignore.filter((path: string) => path.endsWith('/CHANGELOG.md')).sort()).toEqual(generated);
  expect(config).toMatchObject({ minTokens: 50, minLines: 5, mode: 'mild', maxSize: '1mb' });
  expect((await json(directory, 'package.json')).scripts['duplicates:check']).toBe('jscpd --config .jscpd.json --threshold 0 --fail-on-empty .');
  const handwritten = `export function assessRecordedSample(values: number[]) {
  let aggregate = 731;
  const accepted = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value)) throw new Error('Only owned integer samples are accepted');
    const normalized = Math.max(-139, Math.min(283, value));
    aggregate = (aggregate * 17 + normalized) % 104729;
    if (normalized > 23) accepted.push(normalized + aggregate);
  }
  return { aggregate, accepted, count: values.length };
}\n`;
  for (const path of ['owned-first.ts', 'owned-second.ts']) await writeFile(join(directory, path), handwritten);
  const code = await command(directory, ['bun', 'run', 'duplicates:check']);
  expect(code.code).not.toBe(0);
  expect(code.stdout + code.stderr).toContain('Clone found (typescript)');
  for (const path of ['owned-first.ts', 'owned-second.ts']) await rm(join(directory, path));
  const manual = `# An independently maintained operational note
This handwritten document describes the procedure for inspecting a bounded local report.
Read the recorded identifiers before selecting the matching session from the current list.
Keep the original timestamps and distinguish unavailable values from measured observations.
Ask for an explicit review before applying any proposed configuration to a connected host.
Retain the original failure when cleanup also reports a separate unsuccessful operation.
Document the actual checks performed and leave unavailable platform behavior unverified.
\n`;
  await writeFile(join(directory, 'CHANGELOG.md'), manual);
  await mkdir(join(directory, 'docs'));
  await writeFile(join(directory, 'docs/owned-note.md'), manual);
  const markdown = await command(directory, ['bun', 'run', 'duplicates:check']);
  expect(markdown.code).not.toBe(0);
  expect(markdown.stdout + markdown.stderr).toContain('Clone found (markdown)');
  expect(markdown.stdout).toContain('CHANGELOG.md');
  expect(markdown.stdout).toContain('docs/owned-note.md');
}, 60_000);

test('actual locked Tauri CLI receipt identifies the native version under test', async () => {
  expect((await json(source, 'node_modules/@tauri-apps/cli/package.json')).version).toBe('2.12.4');
  const receipt = await successful(source, [process.execPath, tauriCli, '--version']);
  expect(receipt.stdout.trim()).toBe('tauri-cli 2.12.4');
  console.info(receipt.stdout.trim());
});

const androidSdkReady = process.platform === 'linux' && process.env.ANDROID_HOME
  && (process.env.NDK_HOME || process.env.ANDROID_NDK_HOME) && process.env.JAVA_HOME;
test.skipIf(!androidSdkReady)('actual Android generator resolves client JSON version before the deliberate precompile stop', async () => {
  const directory = await fixture();
  const manifest = await json(directory, 'apps/client/package.json');
  manifest.version = '9.4.2'; // Deliberately differs from Cargo: prove this reader uses the client JSON.
  await writeFile(join(directory, 'apps/client/package.json'), JSON.stringify(manifest));
  const path = 'apps/client/src-tauri/tauri.conf.json';
  const config = await json(directory, path);
  config.build = { beforeBuildCommand: 'false' };
  await writeFile(join(directory, path), JSON.stringify(config));
  const project = join(directory, 'apps/client/src-tauri/gen/android');
  await mkdir(join(project, 'app/src/main/java/app/lazysh/client'), { recursive: true });
  await copyFile(join(source, 'apps/client/src-tauri/gen/android/gradlew'), join(project, 'gradlew'));
  const propertiesPath = join(project, 'app/tauri.properties');
  await expect(stat(propertiesPath)).rejects.toMatchObject({ code: 'ENOENT' });
  const result = await command(directory, [process.execPath, tauriCli, 'android', 'build', '--target', 'aarch64', '--debug', '--apk', '--ci'], { cwd: join(directory, 'apps/client') });
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain('beforeBuildCommand `false` failed with exit code 1');
  expect((await stat(propertiesPath)).isFile()).toBe(true);
  const properties = await readFile(propertiesPath, 'utf8');
  expect(properties).toContain('tauri.android.versionName=9.4.2');
  expect(properties).toContain('tauri.android.versionCode=9004002');
}, 60_000);

test.each(['0.1.1', '2.3.4'])('owned fixture seed stays independent of source tooling version %s', async sourceVersion => {
  const directory = await fixture(fragment('patch'), sourceVersion);
  const initial = (await json(directory, 'package.json')).version;
  await successful(directory, ['bun', 'run', 'release:version']);
  expect(initial).toBe('0.1.0');
  expect((await json(directory, 'package.json')).version).toBe('0.1.1');
}, 60_000);

test.each([['patch', '0.1.1'], ['minor', '0.2.0'], ['major', '1.0.0']])(
  'real Changesets + Bun + cargo-edit synchronize a %s release', async (impact, expected) => {
    const directory = await fixture(fragment(impact));
    const history = await readFile(join(directory, 'CHANGELOG.md'));
    const previousLock = await Bun.file(join(directory, 'bun.lock')).text();
    const vendors = await Promise.all(['portable-pty-vendor', 'deep-link-vendor'].map(name => readFile(join(directory, 'packages', name, 'Cargo.toml'))));
    const platformBefore = await Promise.all(platformSources.map(path => readFile(join(directory, path))));
    await successful(directory, ['bun', 'run', 'release:version']);
    // No dependency re-resolution or whole-file formatting is hidden in the glue.
    const updatedLock = await Bun.file(join(directory, 'bun.lock')).text();
    expect(updatedLock).toBe(previousLock.replace(/^(      "version": ")0\.1\.0(",?)$/gm, `$1${expected}$2`));
    await synchronizeWorkspaceVersions(directory);
    expect(await Bun.file(join(directory, 'bun.lock')).text()).toBe(updatedLock);
    expect((await json(directory, 'package.json')).version).toBe(expected);
    expect(await readFile(join(directory, 'CHANGELOG.md'))).toEqual(history);
    expect(await Promise.all(platformSources.map(path => readFile(join(directory, path))))).toEqual(platformBefore);
    expect((await json(directory, 'apps/client/src-tauri/tauri.conf.json')).identifier).toBe('app.lazysh.client');
    for (const [index, name] of ['portable-pty-vendor', 'deep-link-vendor'].entries()) {
      expect(await readFile(join(directory, 'packages', name, 'Cargo.toml'))).toEqual(vendors[index]);
    }
    const workspaceFiles = [...new Bun.Glob('{apps,packages}/*/CHANGELOG.md').scanSync({ cwd: directory })];
    expect(workspaceFiles).toHaveLength(15);
    for (const path of workspaceFiles) expect(await Bun.file(join(directory, path)).text()).toContain(`## ${expected}`);
    expect((await readdir(join(directory, '.changeset'))).sort()).toEqual(['bun-lock.ts', 'config.json']);
    await successful(directory, ['cargo', 'metadata', '--no-deps', '--locked', '--offline', '--format-version', '1']);
    await successful(directory, ['bun', 'install', '--frozen-lockfile', '--ignore-scripts']);
    expect((await successful(directory, ['git', 'tag', '--list'])).stdout).toBe('');
    // A second invocation must not bump anything again when no fragments remain.
    const unchanged = await readFile(join(directory, 'Cargo.lock'));
    expect((await command(directory, ['bun', 'run', 'release:version'])).code).not.toBe(0);
    expect(await readFile(join(directory, 'Cargo.lock'))).toEqual(unchanged);
    if (impact === 'patch') {
      // Exercise the installed Tauri CLI's managed client-JSON version and real bundler.
      await successful(directory, ['cargo', 'build', '--offline', '-p', 'lazysh']);
      await successful(directory, [process.execPath, tauriCli, 'bundle', '--debug', '--bundles', 'deb', '--ci'], { cwd: join(directory, 'apps/client') });
      const debs = [...new Bun.Glob('target/debug/bundle/deb/*.deb').scanSync({ cwd: directory })];
      expect(debs).toHaveLength(1);
      expect(await debianVersion(directory, join(directory, debs[0]))).toEqual([expected]);
    }
  }, 60_000,
);

test('malformed fragments and mismatched native/JS versions fail without native mutation', async () => {
  const directory = await fixture(fragment('invalid-impact'));
  const native = await readFile(join(directory, 'Cargo.toml'));
  expect((await command(directory, ['bun', 'run', 'release:version'])).code).not.toBe(0);
  expect(await readFile(join(directory, 'Cargo.toml'))).toEqual(native);
  await writeFile(join(directory, '.changeset/owned-test.md'), fragment('patch'));
  const client = await json(directory, 'apps/client/package.json');
  client.version = '0.9.0';
  await writeFile(join(directory, 'apps/client/package.json'), JSON.stringify(client));
  expect((await command(directory, ['bun', 'run', 'release:version'])).code).not.toBe(0);
  expect(await readFile(join(directory, 'Cargo.toml'))).toEqual(native);
  expect(await Bun.file(join(directory, '.changeset/owned-test.md')).text()).toBe(fragment('patch'));
}, 60_000);

test('version automation is main-only, version-only, pinned, and retains review sections', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(join(source, '.github/workflows/version.yml')).text()) as any;
  expect(workflow.on.push.branches).toEqual(['main']);
  expect(workflow.permissions).toEqual({ contents: 'read' });
  const job = workflow.jobs['version-pr'];
  expect(job.permissions).toEqual({ contents: 'write', 'pull-requests': 'write' });
  expect(job.if).toBe("github.event_name != 'pull_request' && github.ref == 'refs/heads/main'");
  const step = job.steps.find((item: any) => item.id === 'version');
  expect(step.uses).toBe('changesets/action/version@ae32849d5ba541f9ae29e40e22a623bc13562f51');
  expect(step.with.script).toBe('bun run release:prepare');
  expect((await json(source, 'package.json')).scripts['release:prepare']).toBe('bun run release:version && bun run duplicates:check');
  expect(step.with['github-token']).toBe('${{ github.token }}');
  expect(step.with['pr-base-branch']).toBe('main');
  const body = await Bun.file(join(source, '.github/release_pull_request_template.md')).text();
  const template = await Bun.file(join(source, '.github/pull_request_template.md')).text();
  expect(body.match(/^## .+$/gm)).toEqual(template.match(/^## .+$/gm));
  expect(job.steps.at(-1).run).toBe('gh pr edit "$RELEASE_PR" --body-file .github/release_pull_request_template.md');
  expect(JSON.stringify(workflow)).not.toMatch(/changesets\/action(?:\/publish)?@|NODE_AUTH_TOKEN|pull_request_target|skip ci|createGithubReleases/);
});

test('the real pending-plan workflow gate skips empty-only fragments without consuming them', async () => {
  const directory = await fixture();
  await successful(directory, ['bun', 'run', 'changeset', '--empty']);
  const files = (await readdir(join(directory, '.changeset'))).filter(path => path.endsWith('.md'));
  expect(files).toHaveLength(1);
  const before = await readFile(join(directory, '.changeset', files[0]));
  const workflow = Bun.YAML.parse(await Bun.file(join(source, '.github/workflows/version.yml')).text()) as any;
  const pending = workflow.jobs['version-pr'].steps.find((step: any) => step.id === 'pending');
  const output = join(directory, 'workflow-output');
  await successful(directory, ['bash', '-e', '-c', pending.run], { env: { RUNNER_TEMP: directory, GITHUB_OUTPUT: output } });
  expect(await Bun.file(output).text()).toBe('count=0\n');
  const plan = await json(directory, 'release-plan.json');
  expect(plan.changesets).toHaveLength(1);
  expect(plan.releases).toEqual([]);
  expect(await readFile(join(directory, '.changeset', files[0]))).toEqual(before);
  expect(workflow.jobs['version-pr'].steps.find((step: any) => step.id === 'version').if).toBe("steps.pending.outputs.count != '0'");
}, 60_000);

test('lock compatibility rejects unknown schema, corrupt membership and malformed metadata without writes', async () => {
  const directory = await fixture();
  const original = await Bun.file(join(directory, 'bun.lock')).text();
  const invalid: ((lock: any) => void)[] = [
    lock => { lock.lockfileVersion = 99; },
    lock => { lock.configVersion = 99; },
    lock => { delete lock.workspaces['apps/client']; },
    lock => { lock.workspaces['apps/client'].name = '@unowned/client'; },
    lock => { lock.workspaces['apps/client'].version = 'invalid'; },
    lock => { lock.workspaces['apps/client'].version = '9.0.0'; },
    lock => { lock.workspaces['unowned/package'] = { name: '@unowned/package', version: '0.1.0' }; },
  ];
  for (const mutate of invalid) {
    const lock = Bun.JSONC.parse(original);
    mutate(lock);
    const bytes = JSON.stringify(lock, null, 2);
    await writeFile(join(directory, 'bun.lock'), bytes);
    await expect(synchronizeWorkspaceVersions(directory)).rejects.toThrow('Release consistency:');
    expect(await Bun.file(join(directory, 'bun.lock')).text()).toBe(bytes);
  }
  const duplicate = original.replace('      "version": "0.1.0",', '      "version": "0.1.0",\n      "version": "0.1.0",');
  await writeFile(join(directory, 'bun.lock'), duplicate);
  await expect(synchronizeWorkspaceVersions(directory)).rejects.toThrow('unsupported workspace version text');
  expect(await Bun.file(join(directory, 'bun.lock')).text()).toBe(duplicate);
  const crlf = original.replaceAll('\n', '\r\n');
  await writeFile(join(directory, 'bun.lock'), crlf);
  await synchronizeWorkspaceVersions(directory);
  expect(await Bun.file(join(directory, 'bun.lock')).text()).toBe(crlf);
}, 60_000);

test('release validation permits only the exact client manifest path and rejects platform overrides before writes', async () => {
  const directory = await fixture();
  const base = 'apps/client/src-tauri/tauri.conf.json';
  const config = await json(directory, base);
  const original = await Bun.file(join(directory, 'bun.lock')).text();
  for (const version of [undefined, '0.1.0', '../../package.json', 'https://example.invalid/package.json']) {
    await writeFile(join(directory, base), JSON.stringify({ ...config, version }));
    await expect(synchronizeWorkspaceVersions(directory)).rejects.toThrow('Tauri version must use the client manifest path');
    expect(await Bun.file(join(directory, 'bun.lock')).text()).toBe(original);
  }
  await writeFile(join(directory, base), JSON.stringify(config));
  for (const version of [null, '../package.json', '0.1.0']) {
    await writeFile(join(directory, 'apps/client/src-tauri/tauri.android.conf.json'), JSON.stringify({ version }));
    await expect(synchronizeWorkspaceVersions(directory)).rejects.toThrow('platform Tauri version overrides are not allowed');
    expect(await Bun.file(join(directory, 'bun.lock')).text()).toBe(original);
  }
}, 60_000);

test('canonical Apple and Android sources inherit product versions without changing app IDs', async () => {
  const apple = await Bun.file(join(source, platformSources[0])).text();
  const short = [...apple.matchAll(/^\s*CFBundleShortVersionString: (.+)$/gm)].map(match => match[1]);
  const build = [...apple.matchAll(/^\s*CFBundleVersion: (.+)$/gm)].map(match => match[1]);
  expect(short).toEqual(Array(6).fill('{{apple.bundle-version-short}}'));
  expect(build).toEqual(Array(6).fill('"{{apple.bundle-version}}"'));
  for (const target of ['LazyshLiveActivity', 'LazyshWatch', 'LazyshWatchWidget']) expect(apple).toContain(target);
  expect(apple).toContain('PRODUCT_BUNDLE_IDENTIFIER: {{app.identifier}}');
  const gradle = await Bun.file(join(source, platformSources[2])).text();
  expect(gradle).toContain('versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")');
  expect(gradle).toContain('versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()');
  expect(gradle).toContain('applicationId = "app.lazysh.client"');
  expect(await Bun.file(join(source, platformSources[3])).text()).not.toMatch(/android:version(?:Name|Code)=/);
});

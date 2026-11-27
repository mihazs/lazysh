import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const script = join(root, '.github/scripts/herdr-release-receipt.sh');
const manifest = join(root, 'packages/herdr-upstream/SOURCE-MANIFEST.sha256');
const upstreamCommit = '2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01', checkout = 'a'.repeat(40);

let fixture = '';
const sha256 = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
const exists = (path: string) => Bun.file(path).exists();

/** Link `source` into a real x86-64 glibc executable that needs exactly the symbol versions it names. */
async function compile(name: string, source: string, ...flags: string[]) {
  await writeFile(join(fixture, `${name}.c`), source);
  const child = Bun.spawn(['cc', '-fno-builtin', ...flags, '-o', join(fixture, name), join(fixture, `${name}.c`)], { stderr: 'pipe' });
  expect(await child.exited, await new Response(child.stderr).text()).toBe(0);
  return join(fixture, name);
}
let versioned = '', unversioned = '';

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'lazysh-herdr-release-'));
  // GLIBC_2.9 sorts after GLIBC_2.14 as text and before it as a version.
  versioned = await compile('versioned', `
    extern void *memcpy(void *, const void *, unsigned long);
    extern int pipe2(int *, int);
    __asm__(".symver memcpy,memcpy@GLIBC_2.14");
    __asm__(".symver pipe2,pipe2@GLIBC_2.9");
    void _start(void) { char a[1], b[1]; int p[2]; memcpy(a, b, 0); pipe2(p, 0); for (;;) ; }`, '-nostartfiles');
  unversioned = await compile('unversioned', 'void _start(void) { for (;;) ; }', '-nostdlib', '-static');
  const tools = join(fixture, 'tools');
  await mkdir(tools);
  for (const [name, output] of [['rustc', 'rustc 1.96.1 (fixture)'], ['cargo', 'cargo 1.96.1 (fixture)'], ['zig', '0.16.0']]) {
    await writeFile(join(tools, name), `#!/bin/sh\n[ "$1" = +1.96.1 ] && shift\nexit_code=\${FAIL_${name.toUpperCase()}:-0}\n[ "$exit_code" = 0 ] && echo '${output}'\nexit "$exit_code"\n`, { mode: 0o755 });
  }
});
afterAll(() => rm(fixture, { recursive: true, force: true }));

/** Run the script on `executable` with the fixture toolchains; the receipt path is fresh for every call. */
async function measure(executable: string, env: Record<string, string> = {}) {
  const receipt = join(await mkdtemp(join(fixture, 'run-')), 'receipt.json');
  const child = Bun.spawn(['sh', script, executable, manifest, receipt], {
    stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, PATH: `${join(fixture, 'tools')}:${process.env.PATH}`, ZIG: join(fixture, 'tools/zig'), GITHUB_SHA: checkout,
      HERDR_SOURCE_COMMIT: upstreamCommit, HERDR_FEATURES: 'lazysh-managed', ...env } });
  const [stderr, exit] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exit, stderr, receipt, written: await exists(receipt) ? JSON.parse(await readFile(receipt, 'utf8')) : undefined, leftovers: await exists(receipt + '.partial') };
}

test('a release executable at or below the floor gets a receipt binding its bytes, source, features and toolchains', async () => {
  const result = await measure(versioned, { HERDR_GLIBC_FLOOR: '2.14', HERDR_FEATURES: 'lazysh-managed another-feature' });
  expect(result).toMatchObject({ exit: 0, leftovers: false });
  expect(result.written).toEqual({
    schemaVersion: 1, target: 'x86_64-unknown-linux-gnu', profile: 'release', features: ['lazysh-managed', 'another-feature'],
    sourceCommit: upstreamCommit, manifestSha256: await sha256(manifest), checkout,
    toolchains: { rustc: 'rustc 1.96.1 (fixture)', cargo: 'cargo 1.96.1 (fixture)', zig: '0.16.0', buildLibc: expect.stringMatching(/^glibc 2\.\d+/) },
    libc: { floor: '2.14', maximum: '2.14' }, binarySha256: await sha256(versioned),
  });
});

test('an executable needing a glibc above the documented floor fails and leaves no receipt', async () => {
  const result = await measure(versioned, { HERDR_GLIBC_FLOOR: '2.13' });
  expect(result).toMatchObject({ exit: 1, written: undefined, leftovers: false });
  expect(result.stderr).toContain('needs GLIBC_2.14, above the documented floor GLIBC_2.13');
});

test('the default floor is glibc 2.35', async () => {
  expect((await measure(versioned)).written.libc).toEqual({ floor: '2.35', maximum: '2.14' });
});

test('an executable with no glibc symbol version cannot be measured and is refused', async () => {
  const result = await measure(unversioned);
  expect(result).toMatchObject({ exit: 1, written: undefined });
  expect(result.stderr).toContain('needs no glibc symbol version');
});

test('a file that is not an x86-64 ELF executable is refused', async () => {
  const text = join(fixture, 'text'), arm = join(fixture, 'arm');
  await writeFile(text, 'not an executable');
  const bytes = await readFile(versioned);
  bytes.writeUInt16LE(0xb7, 18); // e_machine: AArch64
  await writeFile(arm, bytes);
  expect(await measure(text)).toMatchObject({ exit: 1, written: undefined, stderr: expect.stringContaining('is not an ELF executable') });
  expect(await measure(arm)).toMatchObject({ exit: 1, written: undefined, stderr: expect.stringContaining('is not an x86-64 executable') });
});

test.each(['RUSTC', 'CARGO', 'ZIG'])('a toolchain that cannot report its version fails the receipt (%s)', async tool => {
  const result = await measure(versioned, { [`FAIL_${tool}`]: '3' });
  expect(result.exit).not.toBe(0);
  expect(result).toMatchObject({ written: undefined, leftovers: false });
});

// The workflow steps around the script, executed with a fake Cargo standing in for the real build.
const managedStep = async (id: string) => {
  const workflow = Bun.YAML.parse(await readFile(join(root, '.github/workflows/checks.yml'), 'utf8')) as any;
  return workflow.jobs['herdr-native'].steps.find((step: any) => step.id === id);
};
/** A runner temp directory whose Cargo target holds a release and a different debug executable, and a fake `cargo` that records its argv and runs `CARGO_ACTION`. */
async function managedRunner(releaseBytes: Uint8Array) {
  const temp = await mkdtemp(join(fixture, 'runner-')), target = join(temp, 'target'), bin = join(temp, 'bin');
  await mkdir(join(target, 'release'), { recursive: true });
  await mkdir(join(target, 'debug'));
  await mkdir(bin);
  await writeFile(join(target, 'release/herdr'), releaseBytes);
  await writeFile(join(target, 'debug/herdr'), 'the debug executable is never the managed release');
  await writeFile(join(bin, 'cargo'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CARGO_CALLS"\neval "$CARGO_ACTION"\n', { mode: 0o755 });
  const run = async (step: any, env: Record<string, string> = {}) => {
    const output = join(temp, `${step.id}.output`), calls = join(temp, 'calls');
    await writeFile(output, '');
    const child = Bun.spawn(['bash', '-e', '-c', step.run], { cwd: root, stdout: 'pipe', stderr: 'pipe', env: {
      ...process.env, PATH: `${bin}:${join(fixture, 'tools')}:${process.env.PATH}`, ZIG: join(fixture, 'tools/zig'), GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: output, GITHUB_SHA: checkout, HERDR_CI_ROOT: temp, CARGO_TARGET_DIR: target, CARGO_CALLS: calls, HERDR_FEATURES: 'lazysh-managed', CARGO_ACTION: ':', ...step.env, ...env } });
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { exit, stdout, output: await readFile(output, 'utf8'), calls: (await Bun.file(calls).text().catch(() => '')).trim().split('\n').filter(Boolean) };
  };
  return { temp, target, run };
}

test('the managed build compiles the release profile with the managed feature', async () => {
  const bytes = await readFile(versioned), runner = await managedRunner(bytes);
  const result = await runner.run(await managedStep('managed-build'));
  expect(result).toMatchObject({ exit: 0, calls: ['+1.96.1 build --locked --release --features lazysh-managed --bin herdr'] });
});

/** A runner whose sealed managed artifact came from the receipt step, and a fake `cargo` that records the managed executable and stock server each call was given. */
async function sealedRunner(cargoAction: string) {
  const runner = await managedRunner(await readFile(versioned));
  expect(await runner.run(await managedStep('managed-receipt'))).toMatchObject({ exit: 0 });
  const env = { CARGO_ACTION: cargoAction, STOCK_TARGET: join(runner.temp, 'stock-target') };
  return { ...runner, sealed: join(runner.temp, 'managed-artifact'), run: async () => {
    const result = await runner.run(await managedStep('managed-acceptance'), env);
    // The receipt step's `cargo --version` calls share the log.
    return { ...result, calls: result.calls.filter(call => call.includes('guarded_input')) };
  } };
}
const recordEnv = 'printf "%s %s %s\\n" "$LAZYSH_TEST_HERDR_MANAGED" "$LAZYSH_TEST_HERDR_STOCK" "$LAZYSH_TEST_HERDR_STOCK_NAMESPACE" >> "$CARGO_CALLS.env"; case "$*" in *--list*) echo "a: test" ;; esac';

test('the acceptance runs on the sealed executable, and the coexistence case beside both the debug and the release stock', async () => {
  const runner = await sealedRunner(recordEnv), result = await runner.run(), stock = join(runner.temp, 'stock-target');
  const test = '+1.96.1 test --locked --release --features lazysh-managed --test guarded_input';
  expect(result.exit).toBe(0);
  expect(result.calls).toEqual([`${test} acceptance::`, `${test} managed_and_stock -- --list --ignored`,
    `${test} managed_and_stock -- --ignored`, `${test} managed_and_stock -- --ignored`]);
  const seen = (await readFile(join(runner.temp, 'calls.env'), 'utf8')).trim().split('\n');
  expect(seen.map(line => line.split(' ')[0])).toEqual(Array(4).fill(join(runner.sealed, 'herdr')));
  expect(seen.slice(2)).toEqual([`${join(runner.sealed, 'herdr')} ${stock}/debug/herdr herdr-dev`, `${join(runner.sealed, 'herdr')} ${stock}/release/herdr herdr`]);
});

test.each([
  ['before the first case when the sealed bytes already differ from the receipt', 'printf changed >> "$HERDR_CI_ROOT/managed-artifact/herdr"', true],
  ['when a case changed the sealed bytes', 'case "$*" in *acceptance::*) printf changed >> "$LAZYSH_TEST_HERDR_MANAGED" ;; esac', false],
] as const)('the sealed acceptance fails %s', async (_, action, tamperBefore) => {
  const runner = await sealedRunner(tamperBefore ? ':' : `${action}; ${recordEnv}`);
  if (tamperBefore) await writeFile(join(runner.sealed, 'herdr'), 'tampered');
  const result = await runner.run();
  expect(result.exit).not.toBe(0);
  if (tamperBefore) expect(result.calls).toEqual([]);
});

test('the sealed acceptance fails when the coexistence case is renamed and lists no test', async () => {
  const runner = await sealedRunner(':'), result = await runner.run();
  expect(result.exit).not.toBe(0);
  expect(result.calls).toHaveLength(2);
});

test('the receipt step seals the release executable, never the debug one, beside a receipt for those bytes', async () => {
  const runner = await managedRunner(await readFile(versioned));
  expect(await runner.run(await managedStep('managed-receipt'))).toMatchObject({ exit: 0 });
  const sealed = join(runner.temp, 'managed-artifact');
  expect(await sha256(join(sealed, 'herdr'))).toBe(await sha256(versioned));
  expect(JSON.parse(await readFile(join(sealed, 'receipt.json'), 'utf8'))).toMatchObject({
    binarySha256: await sha256(versioned), features: ['lazysh-managed'], sourceCommit: upstreamCommit, libc: { floor: '2.35', maximum: '2.14' } });
});

test('the receipt step fails, and seals no receipt, for an executable above the floor', async () => {
  const runner = await managedRunner(await readFile(versioned));
  expect(await runner.run(await managedStep('managed-receipt'), { HERDR_GLIBC_FLOOR: '2.13' })).toMatchObject({ exit: 1 });
  expect(await exists(join(runner.temp, 'managed-artifact/receipt.json'))).toBe(false);
});

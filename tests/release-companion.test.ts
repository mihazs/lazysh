import { expect, spyOn, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidateCompanion, checkCompanionCopy, companionFormat } from '../.changeset/release-companion';
import { artifactName, companionMaximumBytes, companionTargets, digestFile, releaseTargets, validateReceipt,
  type CompanionTarget } from '../.changeset/release-artifacts';
import * as platform from '../.changeset/release-platform';

const identity = { sha: 'a'.repeat(40), version: '0.23.0' };
async function owned(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-companion-test-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function header(target: CompanionTarget) {
  const result = Buffer.alloc(128), spec = companionTargets[target];
  if (spec.os === 'linux') {
    Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(result); result.writeUInt16LE(3, 16);
    result.writeUInt16LE(spec.arch === 'x64' ? 62 : 183, 18);
  } else if (spec.os === 'darwin') {
    result.writeUInt32LE(0xfeedfacf); result.writeUInt32LE(spec.arch === 'x64' ? 0x01000007 : 0x0100000c, 4);
    result.writeUInt32LE(2, 12);
  } else {
    result.writeUInt16LE(0x5a4d); result.writeUInt32LE(64, 60); result.writeUInt32LE(0x4550, 64);
    result.writeUInt16LE(0x8664, 68); result.writeUInt16LE(2, 86); result.writeUInt16LE(0x20b, 88);
  }
  return result;
}
test('all five executable formats reject truncation, target substitution and invalid headers', () => {
  for (const target of Object.keys(companionTargets) as CompanionTarget[]) {
    const valid = header(target); companionFormat(target, valid);
    for (const bad of [Buffer.alloc(128), valid.subarray(0, 63)]) expect(() => companionFormat(target, bad)).toThrow();
    for (const other of Object.keys(companionTargets) as CompanionTarget[])
      if (other !== target) expect(() => companionFormat(other, valid)).toThrow();
    expect(releaseTargets).toContain(target);
    const file = { name: artifactName(identity, target, target.startsWith('windows-') ? 'exe' : 'bin'), bytes: 100, sha256: 'b'.repeat(64) };
    const receipt = { ...identity, schema: 1, target, signing: target.startsWith('macos-') ? 'ad-hoc' : 'unsigned', files: [file] };
    validateReceipt(receipt, identity);
    expect(() => validateReceipt({ ...receipt, files: [{ ...file, bytes: companionMaximumBytes + 1 }] }, identity)).toThrow();
  }
  const outOfRange = header('windows-agent-x64'); outOfRange.writeUInt32LE(0xfffffff0, 60);
  expect(() => companionFormat('windows-agent-x64', outOfRange)).toThrow('PE architecture');
});
test('native matrix is complete and candidates cannot upload publication receipts', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/companion-artifacts.yml', import.meta.url)).text()) as any;
  const rows = workflow.jobs.binary.strategy.matrix.include;
  expect(rows.map((row: any) => row.target).sort()).toEqual(Object.keys(companionTargets).sort());
  const runners = ['ubuntu-24.04', 'ubuntu-24.04-arm', 'macos-15-intel', 'macos-15', 'windows-2025'];
  for (const [index, target] of (Object.keys(companionTargets) as CompanionTarget[]).entries())
    expect(rows[index]).toMatchObject({ target, triple: companionTargets[target].triple, os: runners[index] });
  const steps = workflow.jobs.binary.steps;
  expect(steps.find((step: any) => step.uses === 'actions/upload-artifact@v4').if).toBe('inputs.stage');
  expect(workflow.on.workflow_call.inputs.stage.default).toBe(false);
  const harness = steps.find((step: any) => step.name?.startsWith('Native host harness'));
  expect(harness.env.LAZYSH_TEST_COMPANION_BINARY).toBe('${{ steps.prepare.outputs.binary }}');
  const verify = steps.find((step: any) => step.name?.startsWith('Revalidate exact'));
  expect(verify.env.EXPECTED_COMPANION_SHA).toBe('${{ steps.prepare.outputs.sha256 }}');
  expect(verify.env.EXPECTED_COMPANION_BYTES).toBe('${{ steps.prepare.outputs.bytes }}');
  const checks = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/checks.yml', import.meta.url)).text()) as any;
  expect(checks.jobs['companion-candidates']).toEqual({ uses: './.github/workflows/companion-artifacts.yml' });
  const release = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/release-artifacts.yml', import.meta.url)).text()) as any;
  expect(release.jobs.companion.with.stage).toBe(true);
  expect(release.jobs.aggregate.needs).toContain('companion');
});
test('candidate CLI refuses a publication directory and non-main staging fails before touching output', () => owned(async root => {
  for (const [mode, message] of [['check', 'candidate checks do not accept'], ['stage', 'trusted main build required']]) {
    const output = join(root, mode);
    const child = Bun.spawn([process.execPath, '.changeset/release-companion.ts', mode, 'linux-agent-x64', output], {
      cwd: new URL('../', import.meta.url).pathname,
      env: { ...process.env, GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request', GITHUB_SHA: identity.sha },
      stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(status).not.toBe(0); expect(stderr).toContain(message);
    await expect(lstat(output)).rejects.toMatchObject({ code: 'ENOENT' });
  }
}));

test.skipIf(process.platform !== 'linux' || process.arch !== 'x64')('source or staged mutation during native acceptance cannot preserve a passing digest', () => owned(async root => {
  for (const mutate of ['source', 'staged']) {
    const source = join(root, mutate); await writeFile(source, header('linux-agent-x64')); await chmod(source, 0o700);
    let revision = 0, events = 0;
    const mocked = spyOn(platform, 'native').mockImplementation(async (binary, args, env) => {
      if (args[0] === '--version') return `lazysh-agent ${identity.version}`;
      if (args[0] === 'settings') {
        if (args[1] === 'update') { if (Number(args[3]) !== revision) throw new Error('Owned stale revision'); revision++; }
        return JSON.stringify({ revision, transcriptDiscoveryEnabled: false, recordedUsageEnabled: false, deviceToolsEnabled: false });
      }
      if (args[0] === 'ingest') {
        events++; await mkdir(env!.LAZYSH_STATE_DIR!, { mode: 0o700, recursive: true });
        await writeFile(join(env!.LAZYSH_STATE_DIR!, 'events.sqlite3'), 'owned mock storage', { mode: 0o600 });
      }
      if (args[0] === 'snapshot') {
        await writeFile(mutate === 'source' ? source : binary, Buffer.concat([await readFile(source), Buffer.from('changed')]));
        return JSON.stringify({ schemaVersion: 1, sessions: [{ sessionId: 'release-owned', agent: 'Release fixture',
          state: events === 1 ? 'working' : 'done', summary: 'Owned companion acceptance', paneId: '%1', eventCount: events }] });
      }
      return '';
    });
    try { await expect(checkCompanionCopy('linux-agent-x64', source, identity.version)).rejects.toThrow('changed'); }
    finally { mocked.mockRestore(); }
  }
}));
test('native tool stdin failure remains bounded and redacts input', async () => {
  await expect(platform.native(process.execPath, ['-e', 'process.exit(70)'], process.env, 1000, 'private-fixture-input'))
    .rejects.toThrow('Release validation failed:');
});
test.skipIf(!process.env.LAZYSH_TEST_COMPANION_BINARY)('actual final companion copy executes without a publication receipt or operator profile', async () => {
  const target = process.env.LAZYSH_TEST_COMPANION_TARGET as CompanionTarget;
  const binary = process.env.LAZYSH_TEST_COMPANION_BINARY!;
  const version = (await Bun.file(new URL('../package.json', import.meta.url)).json()).version;
  const before = await digestFile(binary);
  const verified = await checkCompanionCopy(target, binary, version);
  expect(verified).toEqual(before);
  expect(Object.keys(verified).sort()).toEqual(['bytes', 'sha256']);
  expect(await digestFile(binary)).toEqual(before);
  await owned(async root => {
    const prepared = await candidateCompanion(target, binary, version, root);
    expect(await readdir(root)).toEqual([process.platform === 'win32' ? 'lazysh-agent.exe' : 'lazysh-agent']);
    expect(await digestFile(prepared.binary)).toEqual(before);
    const rejected = Bun.spawn([process.execPath, '.changeset/release-companion.ts', 'verify', target, prepared.binary,
      'b'.repeat(64), String(before.bytes)], {
      cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe', timeout: 10_000,
    });
    const [status, stderr] = await Promise.all([rejected.exited, new Response(rejected.stderr).text()]);
    expect(status).not.toBe(0); expect(stderr).toContain('staged bytes changed across native owner tests');
  });
});

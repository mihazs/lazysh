import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { candidate, candidateRecipe, createStableTag, releaseEnabled, requireCleanSourceScan,
  type ReleasePolicy } from '../.changeset/release-tag';

const sha = 'a'.repeat(40);
const policy: ReleasePolicy = await Bun.file(new URL('../.changeset/release-policy.json', import.meta.url)).json();
const active = { ...policy, enabled: true, fossPushAccepted: true, officialSubmissionPrerequisitesAccepted: true };
const input = { sha, ref: 'refs/heads/main', event: 'push', version: '0.14.0', parentVersion: '0.13.0', pending: [] as string[] };
const next = candidate(input);
const template = await Bun.file(new URL('../fdroid/metadata/app.lazysh.client.yml', import.meta.url)).text();
const ref = (target = sha, type = 'commit') => ({ ref: `refs/tags/${next.tag}`, object: { sha: target, type } });
const response = (data: unknown, status = 200) => Response.json(data, { status });
function requests(replies: Response[]) {
  const calls: { path: string; body?: unknown }[] = [];
  return { calls, request: async (path: string, body?: unknown) => {
    calls.push({ path, body });
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected request');
    return reply;
  } };
}
const main = () => response({ object: { sha } });

test('checked-in policy cannot activate tags or expensive builds', async () => {
  expect(releaseEnabled(policy)).toBe(false);
  for (const field of ['enabled', 'fossPushAccepted', 'officialSubmissionPrerequisitesAccepted'] as const) {
    expect(releaseEnabled({ ...active, [field]: false })).toBe(false);
  }
  const api = requests([]);
  await expect(createStableTag(next, policy, 'success', api.request)).rejects.toThrow('disabled');
  expect(api.calls).toEqual([]);
});

test('real disabled CLI only reports blocked admission and rejects the tag command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-tag-disabled-'));
  try {
    const output = join(directory, 'output');
    const run = (mode: string) => Bun.spawnSync(['bun', '.changeset/release-tag.ts', mode], {
      cwd: new URL('../', import.meta.url).pathname, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, GITHUB_OUTPUT: output, LAZYSH_RELEASE_DIRECTORY: join(directory, 'candidate') },
    });
    expect(run('prepare').exitCode).toBe(0);
    expect(await Bun.file(output).text()).toBe('enabled=false\n');
    expect(await Bun.file(join(directory, 'candidate/metadata/app.lazysh.client.yml')).exists()).toBe(false);
    expect(run('tag').exitCode).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([
  { ref: 'refs/heads/feature' }, { event: 'pull_request' }, { sha: 'main' },
  { version: '0.14.0-beta.1' }, { parentVersion: '0.14.0' }, { parentVersion: '0.15.0' },
  { pending: ['pending.md'] }, { version: '0.13.1000' },
])('rejects candidate that lacks the exact stable main transition: %j', invalid => {
  expect(() => candidate({ ...input, ...invalid })).toThrow();
});

test('candidate-only recipe substitution preserves every build input and scan rule', () => {
  const text = candidateRecipe(template, policy, next);
  const data = Bun.YAML.parse(text) as any;
  expect(data.Builds[0]).toMatchObject({ commit: sha, versionName: '0.14.0', versionCode: 14000 });
  expect(data).toMatchObject({ CurrentVersion: '0.14.0', CurrentVersionCode: 14000,
    AutoUpdateMode: 'None', UpdateCheckMode: 'None' });
  expect(() => candidateRecipe(text, policy, next)).toThrow('unreviewed');
});

test('unreviewed recipe changes cannot enter the candidate build', () => {
  for (const text of [template + '\n', template.replace('--locked', '--force'),
    template.replace('    build:', '    novcheck: true\n    build:')]) {
    expect(() => candidateRecipe(text, policy, next)).toThrow('unreviewed');
  }
});

test.each([{}, { 'app.lazysh.client': {} }, { 'app.lazysh.client': { '14000': {} } },
  { 'app.lazysh.client': { '14000': { errors: [['static library', 'input.a']] } } }])(
  'scanner exit success without a clean exact-version receipt is rejected: %j', data => {
    expect(() => requireCleanSourceScan(data, '14000')).toThrow('source scan');
  });
test('clean exact-version scan retains warnings without hiding errors', () => {
  requireCleanSourceScan({ 'app.lazysh.client': { '14000': { errors: [], warnings: [['font', 'retained.ttf']] } } }, '14000');
});

test.each(['failure', 'cancelled', 'skipped', ''])('failed or absent build never accesses refs: %s', async result => {
  const api = requests([]);
  await expect(createStableTag(next, active, result, api.request)).rejects.toThrow('successful source build');
  expect(api.calls).toEqual([]);
});

test('create-only tag uses the exact validated source SHA', async () => {
  const api = requests([main(), response({}, 404), response(ref(), 201)]);
  expect(await createStableTag(next, active, 'success', api.request)).toBe('created');
  expect(api.calls).toEqual([
    { path: 'git/ref/heads/main', body: undefined }, { path: `git/ref/tags/${next.tag}`, body: undefined },
    { path: 'git/refs', body: { ref: `refs/tags/${next.tag}`, sha } },
  ]);
});
test.each([false, true])('same-commit retry is idempotent, including concurrent create: %s', async race => {
  const api = requests([main(), ...(race ? [response({}, 404), response({}, 422)] : []), response(ref())]);
  expect(await createStableTag(next, active, 'success', api.request)).toBe('existing');
  expect(api.calls.filter(call => call.body).length).toBe(Number(race));
});
test.each([ref('b'.repeat(40)), ref(sha, 'tag')])('different or annotated target is a collision: %j', async collision => {
  const api = requests([main(), response(collision)]);
  await expect(createStableTag(next, active, 'success', api.request)).rejects.toThrow('collision');
  expect(api.calls.every(call => !call.body)).toBe(true);
});
test('advanced main, inaccessible refs and failed writes cannot be treated as success', async () => {
  for (const replies of [[response({ object: { sha: 'b'.repeat(40) } })],
    [main(), response({}, 403)], [main(), response({}, 404), response({}, 500)],
    [main(), response({}, 404), response({}, 422), response(ref('b'.repeat(40)))]]) {
    const api = requests(replies);
    await expect(createStableTag(next, active, 'success', api.request)).rejects.toThrow();
    expect(api.calls.filter(call => call.body).length).toBeLessThanOrEqual(1);
  }
});

test('workflow isolates write token after successful source and binary acceptance', async () => {
  const workflow = Bun.YAML.parse(await Bun.file(new URL('../.github/workflows/release-tag.yml', import.meta.url)).text()) as any;
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(workflow.jobs['source-build'].if).toBe("needs.candidate.outputs.enabled == 'true'");
  expect(workflow.jobs.tag.needs).toEqual(['candidate', 'source-build']);
  expect(workflow.jobs.tag.if).toContain("needs.source-build.result == 'success'");
  expect(workflow.jobs.tag.permissions).toEqual({ contents: 'write' });
  const build = workflow.jobs['source-build'].steps.filter((step: any) => step.run).map((step: any) => step.run).join('\n');
  expect(build).toContain('release-tag.ts scan');
  expect(build).toContain('build --test --stop --scan-binary');
  expect(build).toContain('tests/android-push-artifact.test.ts');
  const fdroidCommands = build.split('\n').filter((line: string) => line.includes('/bin/fdroid ')).join('\n');
  expect(fdroidCommands).not.toMatch(/--force|--skip-scan|novcheck/);
});

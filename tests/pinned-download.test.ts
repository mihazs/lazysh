import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { gitFixtureRoots, project } from './support/gitFixture';
import { document, executedSteps, interpolate, type Context } from './support/workflowGraph';
import { moonJson, plannedTargets } from './support/moon';

const script = join(project, '.github', 'scripts', 'pinned-download.sh');
const pinned = 'pinned fixture bytes';
const sha = createHash('sha256').update(pinned).digest('hex');
const roots = gitFixtureRoots('lazysh-pinned-download-test-');
afterAll(() => roots.cleanup());
const read = (path: string) => readFile(path, 'utf8').catch(() => undefined);

/** A fixture root whose fake curl records its argv and writes `SERVED` to its -o target. */
async function fakeCurl(cached?: string, cacheName = 'cache') {
  const { root: directory } = await roots.create();
  const bin = join(directory, 'bin'), calls = join(directory, 'calls'), cache = join(directory, cacheName);
  await mkdir(bin);
  await writeFile(join(bin, 'curl'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$CALLS"\nfor target; do :; done\nprintf \'%s\' "$SERVED" > "$target"\nexit "$CURL_EXIT"\n', { mode: 0o700 });
  if (cached !== undefined) { await mkdir(cache); await writeFile(join(cache, sha), cached); }
  const run = async (argv: string[], env: Record<string, string>, { served = pinned, curlExit = 0 } = {}) => {
    const child = Bun.spawn(argv, { cwd: project, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, SERVED: served, CURL_EXIT: String(curlExit), ...env } });
    const exit = await child.exited;
    return { exit, calls: (await read(calls))?.trim().split('\n') ?? [], cached: await read(join(cache, sha)) };
  };
  return { directory, cache, run };
}

/** Run the helper with a fake curl, optionally over a restored cache entry. */
async function download({ cached, served = pinned, curlExit = 0 }: { cached?: string; served?: string; curlExit?: number } = {}) {
  const { directory, cache, run } = await fakeCurl(cached);
  const output = join(directory, 'fixture.tar.gz');
  const result = await run(['sh', script, sha, output, '--fail', '--max-filesize', '64', 'https://example.invalid/fixture.tar.gz'],
    { LAZYSH_PINNED_DOWNLOADS: cache }, { served, curlExit });
  return { ...result, path: output, output: await read(output) };
}

test('a cache miss downloads with the caller curl arguments and caches only the matching bytes', async () => {
  const result = await download();
  expect(result).toMatchObject({ exit: 0, output: pinned, cached: pinned });
  expect(result.calls).toEqual([`--fail --max-filesize 64 https://example.invalid/fixture.tar.gz -o ${result.path}`]);
});

test('a matching cached copy is used without contacting the host', async () => {
  expect(await download({ cached: pinned, served: 'never served' })).toMatchObject({ exit: 0, output: pinned, cached: pinned, calls: [] });
});

test('a cached copy that no longer matches the pin is downloaded again and replaced', async () => {
  const result = await download({ cached: 'stale or tampered bytes' });
  expect(result).toMatchObject({ exit: 0, output: pinned, cached: pinned });
  expect(result.calls).toHaveLength(1);
});

test('bytes that do not match the pin reach the caller for rejection but are never cached', async () => {
  const result = await download({ served: 'changed upstream bytes' });
  expect(result).toMatchObject({ exit: 0, output: 'changed upstream bytes', cached: undefined });
  expect(result.calls).toHaveLength(1);
});

test('a failed download fails the step', async () => {
  const result = await download({ curlExit: 22 });
  expect(result.exit).toBe(22);
  expect(result.cached).toBeUndefined();
});

// The Parakeet build script otherwise downloads the pinned Linux x64 ORT archive from GitHub.
const ortAction = './.github/actions/parakeet-onnxruntime';
const ortStep = (await document(`${ortAction.slice(2)}/action.yml`)).runs.steps.find((step: any) => step.run);

/** Run the action's provisioning step with fixture bytes pinned in place of the real archive's. */
async function provisionOrt({ cached, served = pinned }: { cached?: string; served?: string } = {}) {
  const { directory, run } = await fakeCurl(cached, 'lazysh-parakeet-onnxruntime-cache');
  const githubEnv = join(directory, 'github-env');
  const result = await run(['bash', '-e', '-c', ortStep.run], { ...ortStep.env, RUNNER_TEMP: directory, GITHUB_ENV: githubEnv,
    ORT_SHA256: sha, ORT_SIZE: String(pinned.length), ORT_URL: 'https://example.invalid/ort.zip' }, { served });
  const archive = join(directory, 'lazysh-parakeet-onnxruntime', ortStep.env.ORT_NAME);
  return { ...result, archive, bytes: await read(archive), env: (await read(githubEnv)) ?? '' };
}

test('the ORT action downloads the pinned archive with bounded retries and points the build at the verified copy', async () => {
  const result = await provisionOrt();
  expect(result).toMatchObject({ exit: 0, bytes: pinned, cached: pinned, env: `LAZYSH_PARAKEET_ORT_ARCHIVE=${result.archive}\n` });
  expect(result.calls).toHaveLength(1);
  expect(result.calls[0].split(' ')).toEqual(expect.arrayContaining(['--fail', '--retry', '6', '--retry-all-errors', 'https://example.invalid/ort.zip']));
});

test('the ORT action reuses a matching restored archive without contacting GitHub', async () => {
  expect(await provisionOrt({ cached: pinned, served: 'never served' })).toMatchObject({ exit: 0, bytes: pinned, calls: [] });
});

test('the ORT action fails and exports nothing when the archive does not match its pin', async () => {
  // Same length as the pinned fixture, so only the checksum can reject these bytes.
  const result = await provisionOrt({ served: 'pinned fixture bytez' });
  expect(result.exit).not.toBe(0);
  expect(result).toMatchObject({ cached: undefined, env: '' });
});

// Resolve `bun run` to package scripts and `moon run` to moon's own resolved task graph, then find
// Cargo or Tauri invocations that compile the Linux client or the Parakeet runtime and so run its
// native build script.
const workspaces = new Map<string, { dir: string; scripts: Record<string, string> }>();
for (const dir of ['.', ...[...new Bun.Glob('{apps,packages}/*/package.json').scanSync(project)].map(path => path.slice(0, -'/package.json'.length))]) {
  const manifest = await Bun.file(join(project, dir, 'package.json')).json();
  workspaces.set(manifest.name, { dir, scripts: manifest.scripts ?? {} });
}
const parakeetCrates = new Set(['apps/client/src-tauri', 'packages/parakeet-runtime']);

// Every task moon can run, with its project directory and shell-visible command line.
const moonSources = new Map<string, string>(((await moonJson(['query', 'projects'])).projects as any[]).map(entry => [entry.id, entry.source]));
const moonTasks = new Map<string, { dir: string; line: string }>();
for (const [id, tasks] of Object.entries<Record<string, any>>((await moonJson(['query', 'tasks'])).tasks))
  for (const task of Object.values(tasks)) moonTasks.set(task.target, { dir: moonSources.get(id)!, line: task.script ?? [task.command, ...(task.args ?? [])].join(' ') });
const moonTargets = (words: string) => words.split(/\s+/).filter(word => /^[#\w-]*:[\w-]+$/.test(word));
// The tasks a `moon run` or `moon ci` command line schedules, dependencies included, planned up front by moon itself.
const moonPlans = new Map<string, string[]>();
const moonInvocations = [await Bun.file(join(project, 'package.json')).text(), ...await Promise.all(
  [...new Bun.Glob('.github/workflows/*.yml').scanSync({ cwd: project, dot: true })].map(path => Bun.file(join(project, path)).text()))].join('\n');
await Promise.all([...new Set([...moonInvocations.matchAll(/\bmoon (?:run|ci) ([^\n&|;"']+)/g)].map(match => moonTargets(match[1]).join(' ')).filter(Boolean))]
  .map(async targets => { moonPlans.set(targets, await plannedTargets(...targets.split(' '))); }));

/** Whether running `script` from package directory `dir` executes a named script that compiles Parakeet. */
function runsScript(dir: string, name: string, seen: Set<string>) {
  const key = `${dir}#${name}`;
  const body = [...workspaces.values()].find(entry => entry.dir === dir)?.scripts[name];
  return body !== undefined && !seen.has(key) && compilesParakeet(body, dir, new Set([...seen, key]));
}

function compilesParakeet(command: string, dir: string, seen = new Set<string>()): boolean {
  return command.split(/&&|\|\||[;|\n]/).some(part => {
    const words = part.trim().split(/\s+/);
    const at = (flag: string) => { const index = words.indexOf(flag); return index < 0 ? undefined : words[index + 1]; };
    if (/\btauri build\b/.test(part)) return true;
    const bun = /\bbun run (?:--cwd (\S+) )?([\w:.-]+)/.exec(part);
    if (bun) return runsScript(bun[1] ? join(dir, bun[1]) : dir, bun[2], seen);
    const moon = /\bmoon (?:run|ci) (.+)/.exec(part);
    if (moon) {
      const planned = moonPlans.get(moonTargets(moon[1]).join(' '));
      if (planned === undefined) throw new Error(`Unplanned moon command: ${part}`);
      return planned.some(target => compilesParakeet(moonTasks.get(target)!.line, moonTasks.get(target)!.dir, seen));
    }
    const cargo = words.indexOf('cargo');
    if (cargo < 0 || /android|ios/.test(at('--target') ?? '')) return false;
    const subcommand = words.slice(cargo + 1).find(word => !word.startsWith('+'));
    if (!['build', 'test', 'check', 'clippy', 'run'].includes(subcommand ?? '')) return false;
    const manifest = at('--manifest-path'), crate = at('-p') ?? at('--package');
    if (manifest) return parakeetCrates.has(relative(project, resolve(project, dir, manifest, '..')));
    if (crate) return crate === 'lazysh' || crate === 'lazysh-parakeet-runtime';
    return dir === '.' || dir === 'apps/client' || parakeetCrates.has(dir);
  });
}

/** Every Linux x64 runner row of `file`'s jobs with its executed steps on a main push. */
async function linuxRows(file: string) {
  const rows: { name: string; steps: { step: any }[] }[] = [];
  for (const [id, job] of Object.entries<any>((await document(file)).jobs)) {
    if (!job.steps) continue;
    const matrix = job.strategy?.matrix;
    for (const row of matrix?.include ?? (Array.isArray(matrix?.os) ? matrix.os.map((os: string) => ({ os })) : [{}])) {
      const label = String(interpolate(job['runs-on'], { matrix: row }));
      if (!label.startsWith('ubuntu-') || label.endsWith('-arm')) continue;
      const context: Context = { github: { event_name: 'push', ref: 'refs/heads/main' }, inputs: {}, matrix: row, runner: { os: 'Linux', arch: 'X64' } };
      rows.push({ name: `${file.split('/').pop()}#${id}${row.target ? `[${row.target}]` : ''}`, steps: await executedSteps(job.steps, context) });
    }
  }
  return rows;
}

test('every Linux x64 job that compiles the Parakeet runtime reads the verified ORT archive before its first build', async () => {
  const builders: string[] = [];
  for (const file of ['.github/workflows/checks.yml', '.github/workflows/release-artifacts.yml']) {
    for (const { name, steps } of await linuxRows(file)) {
      const first = steps.findIndex(({ step }) => step.run && step['working-directory'] === undefined && compilesParakeet(step.run, '.'));
      if (first < 0) continue;
      builders.push(name);
      const provider = steps.findIndex(({ step }) => step.uses === ortAction);
      expect({ name, provided: provider >= 0 && provider < first }).toEqual({ name, provided: true });
    }
  }
  // The inventory is pinned so a detector regression cannot make this pass vacuously.
  expect(builders.sort()).toEqual(['checks.yml#native-linux', 'checks.yml#native-linux-runtimes', 'release-artifacts.yml#desktop[linux-x64]']);
});

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { project } from './support/gitFixture';
import { document } from './support/workflowGraph';

const script = join(project, '.github', 'scripts', 'apt-install.sh');
const temporary: string[] = [];
afterAll(() => Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))));

const config = 'Acquire::http::Timeout "30";\nAcquire::https::Timeout "30";\nAcquire::ftp::Timeout "30";\nAcquire::Retries "5";\n';
const oneLine = 'deb http://azure.archive.ubuntu.com/ubuntu/ jammy main\ndeb http://security.ubuntu.com/ubuntu jammy-security main\n';
const deb822 = 'Types: deb\nURIs: http://azure.archive.ubuntu.com/ubuntu/\nSuites: noble noble-updates\nComponents: main universe\n';
const mirrors = 'http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://archive.ubuntu.com/ubuntu/\tpriority:2\nhttps://archive.ubuntu.com/ubuntu/\tpriority:3\n';
const archived = (text: string) => text.replaceAll('azure.archive.ubuntu.com', 'archive.ubuntu.com').replaceAll('http://archive.ubuntu.com', 'https://archive.ubuntu.com');

/**
 * A fake root whose apt-get records each call, refuses to run before the bounded network
 * configuration exists, and behaves per `APT_BEHAVIOUR`: `hang` stalls while any source still
 * names the Azure mirror, `stall` always stalls, `fail` fails every call, `fail-install` every
 * install and `fail-install-once` only the first install.
 */
async function aptRoot() {
  const root = await mkdtemp(join(tmpdir(), 'lazysh-apt-install-test-'));
  temporary.push(root);
  const bin = join(root, 'bin'), etc = join(root, 'etc', 'apt');
  await mkdir(bin);
  await mkdir(join(etc, 'sources.list.d'), { recursive: true });
  await writeFile(join(etc, 'sources.list'), oneLine);
  await writeFile(join(etc, 'sources.list.d', 'ubuntu.sources'), deb822);
  await writeFile(join(etc, 'apt-mirrors.txt'), mirrors);
  await writeFile(join(bin, 'sudo'), '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
  await writeFile(join(bin, 'dpkg'), '#!/bin/sh\necho "dpkg $*" >> "$CALLS"\n[ "$APT_BEHAVIOUR" != stall-dpkg ] || sleep 60\n[ "$APT_BEHAVIOUR" != fail-dpkg ]\n', { mode: 0o700 });
  await writeFile(join(bin, 'apt-get'), `#!/bin/sh
[ -f "$LAZYSH_APT_ROOT/etc/apt/apt.conf.d/99lazysh-bounded-network" ] || { echo unbounded >> "$CALLS"; exit 97; }
echo "$*" >> "$CALLS"
case $APT_BEHAVIOUR:$1 in
  hang:*) if grep -qr azure "$LAZYSH_APT_ROOT/etc/apt"; then sleep 60; fi ;;
  stall:*) sleep 60 ;;
  fail:* | fail-install:install) exit 100 ;;
  fail-install-once:install | fail-dpkg:install | stall-dpkg:install) [ "$(grep -c '^install' "$CALLS")" -gt 1 ] || exit 100 ;;
esac
`, { mode: 0o700 });
  const read = (path: string) => readFile(join(etc, path), 'utf8').catch(() => undefined);
  const run = async (argv: string[], behaviour = 'ok', cwd = project) => {
    const started = performance.now();
    const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      LAZYSH_APT_ROOT: root, LAZYSH_APT_UPDATE_SECONDS: '1', LAZYSH_APT_INSTALL_SECONDS: '1', APT_BEHAVIOUR: behaviour, CALLS: join(root, 'calls') } });
    const [stdout, exit] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const calls = (await readFile(join(root, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return { exit, stdout, calls, seconds: (performance.now() - started) / 1000, config: await read('apt.conf.d/99lazysh-bounded-network'),
      sources: [await read('sources.list'), await read('sources.list.d/ubuntu.sources'), await read('apt-mirrors.txt')] };
  };
  return run;
}

const install = async (args: string[], behaviour?: string) => (await aptRoot())(['sh', script, ...args], behaviour);

describe.skipIf(process.platform !== 'linux')('bounded apt installer', () => {
  test('writes network timeouts, then updates and installs the exact packages from the configured mirror', async () => {
    const result = await install(['libssl-dev', 'pkg-config']);
    expect(result).toMatchObject({ exit: 0, config, calls: ['update', 'install -y libssl-dev pkg-config'], sources: [oneLine, deb822, mirrors] });
  });

  test('a stalled update is killed and retried against archive.ubuntu.com in both source formats', async () => {
    const result = await install(['strace'], 'hang');
    expect(result).toMatchObject({ exit: 0, calls: ['update', 'update', 'install -y strace'],
      sources: [archived(oneLine), archived(deb822), archived(mirrors)] });
    expect(result.stdout).toContain('::warning::apt-get update failed or timed out');
    expect(result.seconds).toBeLessThan(20);
  });

  test('a failed install switches mirrors, refreshes the lists and installs once more', async () => {
    const result = await install(['strace'], 'fail-install-once');
    expect(result).toMatchObject({ exit: 0, calls: ['update', 'install -y strace', 'update', 'dpkg --configure -a', 'install -y strace'] });
    expect(result.sources).toEqual([archived(oneLine), archived(deb822), archived(mirrors)]);
  });

  test('exhausted update retries fail the step before any install', async () => {
    expect(await install(['strace'], 'fail')).toMatchObject({ exit: 100, calls: ['update', 'update'] });
  });

  test('exhausted install retries fail the step', async () => {
    expect(await install(['strace'], 'fail-install')).toMatchObject({ exit: 100, calls: ['update', 'install -y strace', 'update', 'dpkg --configure -a', 'install -y strace'] });
  });

  test('failed dpkg recovery stops before retrying install', async () => {
    expect(await install(['strace'], 'fail-dpkg')).toMatchObject({ exit: 1, calls: ['update', 'install -y strace', 'update', 'dpkg --configure -a'] });
  });

  test('stalled dpkg recovery is bounded and stops before retrying install', async () => {
    const result = await install(['strace'], 'stall-dpkg');
    expect(result).toMatchObject({ exit: 124, calls: ['update', 'install -y strace', 'update', 'dpkg --configure -a'] });
    expect(result.seconds).toBeLessThan(20);
  });

  test('a mirror that stalls every attempt fails the step within its bound instead of hanging', async () => {
    const result = await install(['strace'], 'stall');
    expect(result).toMatchObject({ exit: 124, calls: ['update', 'update'] });
    expect(result.seconds).toBeLessThan(20);
  });

  test('--no-update installs from the current lists, and alone only writes the configuration', async () => {
    expect(await install(['--no-update', 'tmux', 'bison'])).toMatchObject({ exit: 0, config, calls: ['install -y tmux bison'] });
    expect(await install(['--no-update'])).toMatchObject({ exit: 0, config, calls: [], sources: [oneLine, deb822, mirrors] });
    expect(await install([])).toMatchObject({ exit: 0, config, calls: ['update'] });
  });

  // Runner steps that use apt; the F-Droid container step needs Docker and is covered above
  // through the same script it feeds the container.
  const runnerAptSteps = async () => {
    const files = ['.github/workflows/*.yml', '.github/actions/*/action.yml'].flatMap(glob => [...new Bun.Glob(glob).scanSync({ cwd: project, dot: true })]).sort();
    const runs = new Set<string>();
    for (const file of files) {
      const parsed = await document(file);
      const steps = [...Object.values<any>(parsed.jobs ?? {}).flatMap(job => job.steps ?? []), ...(parsed.runs?.steps ?? [])];
      for (const step of steps) if (/apt-get|apt-install\.sh/.test(step.run ?? '') && !step.run.includes('docker exec')) runs.add(step.run);
    }
    return [...runs];
  };

  test('every runner apt step writes the bounded configuration before apt runs and installs its packages', async () => {
    const runs = await runnerAptSteps();
    // The inventory is pinned so a detector regression cannot make this pass vacuously.
    expect(runs).toHaveLength(8);
    for (const run of runs) {
      const result = await (await aptRoot())(['bash', '-e', '-c', run]);
      const packages = run.split(/\s+/).slice(run.split(/\s+/).indexOf('.github/scripts/apt-install.sh') + 1).filter(word => word !== '--no-update');
      const expected = [...(run.includes('--no-update') ? [] : ['update']), ...(packages.length ? [`install -y ${packages.join(' ')}`] : [])];
      expect({ run, exit: result.exit, calls: result.calls }).toEqual({ run, exit: 0, calls: expected });
    }
  });
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import tls from 'node:tls';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { gitFixtureRoots, project } from './support/gitFixture';

/**
 * The host bootstrap the app runs over SSH on a host whose companion has no `update` command. It is executed
 * here exactly as sshd's shell would receive it (`sh -c <script> lazysh-bootstrap VERSION SHA256 BYTES TARGET DIR`)
 * against a fake HTTPS release server with a private CA. The only substitution is the release URL's host.
 */
const script = await readFile(resolve(project, 'apps/client/src-tauri/src/companion/install/bootstrap.sh'), 'utf8');
const PRODUCTION = 'https://github.com/mihazs/lazysh/releases/download';
const TARGET = 'linux-agent-x64';
// Resolved once from the runner's PATH (dash on Debian and Ubuntu), because each host below gets a restricted PATH.
const SH = Bun.which('sh')!;
const roots = gitFixtureRoots('lazysh-bootstrap-test-');
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** A stand-in companion that satisfies the self-test; `brokenAs` makes it fail from the named place only. */
const companion = (version: string, extra = '') => `#!/bin/sh
${extra}
case "$1" in
  --version) echo 'lazysh-agent ${version}';;
  ingest) mkdir -p "$LAZYSH_STATE_DIR" && cat > "$LAZYSH_STATE_DIR/event";;
  snapshot) cat "$LAZYSH_STATE_DIR/event";;
esac
`;
const release = (version: string, body = companion(version)) => ({ version, body: Buffer.from(body), digest: sha(body) });

type Mode = 'ok' | 'tamper' | 'flip' | 'oversize' | 'http-redirect' | 'missing' | 'slow';
const log: { path: string; agent: string }[] = [];
let mode: Mode = 'ok';
let assets = new Map<string, Buffer>();
let server: ReturnType<typeof Bun.serve>;
let ca = '';
let pairKey = '', pairCert = '';
let toolbox = '';
let port = 0;

async function certificate(directory: string) {
  const run = async (...args: string[]) => {
    const child = Bun.spawn(['openssl', ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (await child.exited) throw new Error(await new Response(child.stderr).text());
  };
  const key = join(directory, 'key.pem'), cert = join(directory, 'ca.pem');
  await run('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=lazysh-release-test',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', key, '-out', cert);
  return { key: await readFile(key, 'utf8'), cert: await readFile(cert, 'utf8'), path: cert };
}

beforeAll(async () => {
  const { root } = await roots.create();
  const pair = await certificate(root);
  ca = pair.path;
  pairKey = pair.key; pairCert = pair.cert;
  server = Bun.serve({
    port: 0, hostname: '127.0.0.1', tls: { cert: pair.cert, key: pair.key },
    fetch(request) {
      const url = new URL(request.url);
      log.push({ path: url.pathname, agent: request.headers.get('user-agent') ?? '' });
      const asset = assets.get(url.pathname);
      if (mode === 'missing' || !asset) return new Response('not found', { status: 404 });
      if (mode === 'http-redirect') return new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${port}${url.pathname}` } });
      if (mode === 'tamper') return new Response(Buffer.concat([asset, Buffer.from('x')]));
      if (mode === 'flip') return new Response(Buffer.concat([Buffer.from([asset[0] ^ 1]), asset.subarray(1)]));
      if (mode === 'oversize') {
        // No Content-Length and far more than the declared size: a downloader without a size option relies on the descriptor cap.
        let sent = 0;
        return new Response(new ReadableStream({ async pull(controller) {
          await Bun.sleep(1);
          if (sent++ >= 400) return controller.close();
          controller.enqueue(new Uint8Array(1024));
        } }), { headers: { 'content-type': 'application/octet-stream' } });
      }
      if (mode === 'slow') {
        let sent = 0;
        return new Response(new ReadableStream({ async pull(controller) {
          await Bun.sleep(400);
          if (sent >= asset.length) return controller.close();
          controller.enqueue(asset.subarray(sent, sent += 32768));
        } }), { headers: { 'content-length': String(asset.length) } });
      }
      return new Response(asset);
    },
  });
  port = server.port!;
  toolbox = join(root, 'toolbox');
  await mkdir(toolbox);
  for (const name of ['uname', 'id', 'stat', 'mkdir', 'mktemp', 'find', 'wc', 'cat', 'cp', 'mv', 'rm', 'rmdir', 'chmod', 'env', 'grep', 'head', 'sleep', 'tr', 'touch', 'sha256sum', 'shasum', 'curl', 'wget']) {
    const found = Bun.which(name);
    if (found) await symlink(found, join(toolbox, name));
  }
});
afterAll(async () => { server?.stop(true); await roots.cleanup(); });

const release1 = (version: string) => `/mihazs/lazysh/releases/download/v${version}/lazysh-${version}-${TARGET}.bin`;
function publish(...published: ReturnType<typeof release>[]) {
  assets = new Map(published.map((item) => [release1(item.version), item.body]));
}

/** A host: the managed directory beside a private home, a restricted PATH and the state a real host would keep. */
async function host(tools = ['curl']) {
  const { root } = await roots.create();
  const home = await mkdtemp(join(root, 'home-'));
  const managed = join(home, '.local/share/lazysh/companion');
  const bin = join(home, 'bin');
  await mkdir(bin);
  for (const name of readdirSyncNames(toolbox)) if (!['curl', 'wget'].includes(name) || tools.includes(name)) await symlink(join(toolbox, name), join(bin, name)).catch(() => {});
  for (const name of tools.filter((tool) => !readdirSyncNames(toolbox).includes(tool))) await writeFile(join(bin, name), '#!/bin/sh\n', { mode: 0o700 });
  await mkdir(join(home, 'state'), { recursive: true });
  await writeFile(join(home, 'state/settings.json'), 'settings that must stay');
  await writeFile(join(home, 'hooks.json'), 'hooks that must stay');
  return { home, managed, agent: join(managed, 'lazysh-agent'), previous: join(managed, 'lazysh-agent.previous'), bin };
}
function readdirSyncNames(directory: string) { return [...new Bun.Glob('*').scanSync({ cwd: directory, onlyFiles: false })]; }
async function install(h: Awaited<ReturnType<typeof host>>, version: string, digest: string, bytes: number, options: { args?: string[]; env?: Record<string, string>; text?: string; production?: boolean; trusted?: boolean } = {}) {
  const text = options.production ? script : (options.text ?? script).replace(PRODUCTION, `https://127.0.0.1:${port}/mihazs/lazysh/releases/download`);
  const argv = options.args ?? [version, digest, String(bytes), TARGET, h.managed];
  // GnuTLS wget ignores SSL_CERT_FILE: its trust store is a host setting in the user's wgetrc, as on any host.
  await writeFile(join(h.home, 'wgetrc'), `ca_certificate = ${ca}\n`);
  const env = { PATH: h.bin, HOME: h.home, SECRET: 'hunter2-never-printed', LAZYSH_STATE_DIR: join(h.home, 'state'),
    ...(options.trusted === false ? {} : { CURL_CA_BUNDLE: ca, SSL_CERT_FILE: ca, WGETRC: join(h.home, 'wgetrc') }), ...options.env };
  const child = Bun.spawn([SH, '-c', text, 'lazysh-bootstrap', ...argv], { stdout: 'pipe', stderr: 'pipe', env });
  const out = new Response(child.stdout).text(), err = new Response(child.stderr).text();
  return finished(child, await out, await err);
}
async function finished(child: ReturnType<typeof Bun.spawn>, out: string, err: string) {
  const exit = await child.exited;
  const lines = out.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const result = lines.at(-1);
  return { exit, out, err, lines, result, stages: lines.filter((line) => line.event === 'stage') };
}
const residue = async (h: { managed: string }) => (await readdir(h.managed).catch(() => [])).filter((name) => name.startsWith('.'));
const put = async (path: string, text: string) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, text, { mode: 0o700 }); };

test('a missing companion is downloaded by the host over verified HTTPS and installed once', async () => {
  const item = release('1.54.1');
  publish(item);
  const h = await host();
  log.length = 0; mode = 'ok';
  const r = await install(h, item.version, item.digest, item.body.length);
  expect(r.exit).toBe(0);
  expect(r.result).toMatchObject({ schemaVersion: 1, event: 'result', outcome: 'updated', exitCode: 0, error: null, current: { version: '1.54.1' }, previous: null });
  expect(r.stages.map((s) => s.stage)).toEqual(expect.arrayContaining(['downloading', 'verifying', 'selfTesting', 'replacing', 'checkingInstalled']));
  expect(await readFile(h.agent)).toEqual(item.body);
  expect((await lstat(h.agent)).mode & 0o777).toBe(0o700);
  expect((await lstat(h.managed)).mode & 0o777).toBe(0o700);
  expect(log).toEqual([{ path: release1('1.54.1'), agent: expect.stringContaining('curl') }]);
  expect(await residue(h)).toEqual([]);
  expect(await readFile(join(h.home, 'state/settings.json'), 'utf8')).toBe('settings that must stay');
  for (const line of r.lines) expect(JSON.stringify(line)).not.toMatch(/127\.0\.0\.1|github|hunter2|\/home|\/tmp/);
  expect(r.err).toBe('');
});

test.each(['1.28.0', '1.33.4'])('a host with companion %s is upgraded in place and keeps it as the previous version', async (old) => {
  const item = release('1.54.1');
  publish(item);
  const h = await host();
  const previous = companion(old);
  await put(h.agent, previous);
  await put(join(h.home, '.codex/hooks.json'), 'hooks that must stay');
  log.length = 0; mode = 'ok';
  const r = await install(h, item.version, item.digest, item.body.length);
  expect(r.exit).toBe(0);
  expect(r.result).toMatchObject({ outcome: 'updated', current: { version: '1.54.1' }, previous: { version: old } });
  expect(await readFile(h.agent)).toEqual(item.body);
  expect(await readFile(h.previous, 'utf8')).toBe(previous);
  expect((await lstat(h.previous)).mode & 0o777).toBe(0o700);
  expect(log).toHaveLength(1);
  expect(await readFile(join(h.home, 'state/settings.json'), 'utf8')).toBe('settings that must stay');
  expect(await readFile(join(h.home, '.codex/hooks.json'), 'utf8')).toBe('hooks that must stay');
  expect(await residue(h)).toEqual([]);
});

test('the same version is up to date and a newer one is never downgraded, both without any request', async () => {
  const item = release('1.54.1');
  publish(item);
  const h = await host();
  log.length = 0; mode = 'ok';
  await put(h.agent, companion('1.54.1', '# the very same version'));
  const same = await install(h, item.version, item.digest, item.body.length);
  expect(same).toMatchObject({ exit: 0, result: { outcome: 'upToDate', exitCode: 0 } });
  expect(await readFile(h.agent, 'utf8')).toContain('very same');
  await put(h.agent, companion('2.0.0'));
  const newer = await install(h, item.version, item.digest, item.body.length);
  expect(newer).toMatchObject({ exit: 23, result: { outcome: 'failed', exitCode: 23, error: { kind: 'downgradeRefused' } } });
  expect(await readFile(h.agent, 'utf8')).toBe(companion('2.0.0'));
  expect(log).toEqual([]);
  expect(await residue(h)).toEqual([]);
});

test('a download that is not the pinned file is discarded and the installed companion is untouched', async () => {
  const item = release('1.54.1');
  publish(item);
  const h = await host();
  const kept = companion('1.28.0');
  await put(h.agent, kept);
  const marker = join(h.home, 'executed');
  for (const [served, exit, detail] of [['tamper', 22, 'sizeMismatch'], ['flip', 22, 'digestMismatch'], ['oversize', 22, 'sizeMismatch'], ['http-redirect', 22, 'redirectRefused']] as const) {
    mode = served;
    const r = await install(h, item.version, item.digest, item.body.length);
    expect(r.exit, served).toBe(exit);
    expect(r.result, served).toMatchObject({ outcome: 'failed', exitCode: exit, error: { kind: 'verificationFailed', detail } });
    expect(await readFile(h.agent, 'utf8'), served).toBe(kept);
    expect(await lstat(h.previous).catch(() => null), served).toBeNull();
    expect(await residue(h), served).toEqual([]);
  }
  // A file the release metadata does not vouch for never runs: its digest differs from the pin, so no marker appears.
  const hostile = release('1.54.1', companion('1.54.1', `touch ${marker}`));
  publish(hostile);
  mode = 'ok';
  const r = await install(h, item.version, item.digest, hostile.body.length);
  expect(r.result).toMatchObject({ exitCode: 22 });
  expect(await lstat(marker).catch(() => null)).toBeNull();
  // A pin whose size is one byte off is refused even when the digest of the served file is right.
  publish(item);
  const sized = await install(h, item.version, item.digest, item.body.length + 1);
  expect(sized).toMatchObject({ exit: 22, result: { error: { detail: 'sizeMismatch' } } });
  expect(await readFile(h.agent, 'utf8')).toBe(kept);
});

test('an unreachable, missing or untrusted release is a network failure that changes nothing', async () => {
  const item = release('1.54.1');
  publish(item);
  const h = await host();
  const kept = companion('1.28.0');
  await put(h.agent, kept);
  mode = 'missing';
  expect(await install(h, item.version, item.digest, item.body.length)).toMatchObject({ exit: 20, result: { error: { kind: 'networkUnavailable', detail: 'http' } } });
  // A connection that promises the whole file and drops halfway is a network failure, not a short install.
  const dropping = tls.createServer({ key: pairKey, cert: pairCert }, (socket) => {
    socket.on('error', () => {});
    socket.once('data', () => { socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${item.body.length}\r\n\r\n`); socket.write(item.body.subarray(0, item.body.length >> 1), () => socket.destroy()); });
  });
  await new Promise<void>((done) => dropping.listen(0, '127.0.0.1', done));
  const half = await install(h, item.version, item.digest, item.body.length, { text: script.replace(PRODUCTION, `https://127.0.0.1:${(dropping.address() as { port: number }).port}/x`) });
  dropping.close();
  expect(half).toMatchObject({ exit: 20, result: { error: { kind: 'networkUnavailable' } } });
  expect(await readFile(h.agent, 'utf8')).toBe(kept);
  mode = 'ok';
  log.length = 0;
  expect(await install(h, item.version, item.digest, item.body.length, { trusted: false })).toMatchObject({ exit: 20, result: { error: { kind: 'networkUnavailable', detail: 'tls' } } });
  expect(log, 'a certificate outside the trust store is refused before any request').toEqual([]);
  const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const dead = closed.port!; closed.stop(true);
  const unreachable = await install(h, item.version, item.digest, item.body.length, { text: script.replace(PRODUCTION, `https://127.0.0.1:${dead}/x`) });
  expect(unreachable).toMatchObject({ exit: 20, result: { error: { kind: 'networkUnavailable', detail: 'connect' } } });
  expect(await readFile(h.agent, 'utf8')).toBe(kept);
  expect(await residue(h)).toEqual([]);
});

/** Publish `body` as the release and run the bootstrap on a host that has the old 1.28.0 companion. */
async function updateOldHost(body: string) {
  const item = release('1.54.1', body);
  publish(item);
  const h = await host();
  const kept = companion('1.28.0');
  await put(h.agent, kept);
  mode = 'ok';
  return { h, kept, r: await install(h, item.version, item.digest, item.body.length) };
}

test('a staged companion that fails its self test is never installed', async () => {
  const stages = [
    ['reports the wrong version', companion('9.9.9')],
    ['cannot ingest an event', companion('1.54.1').replace('ingest) mkdir', 'ingest) exit 3;; ingest2) mkdir')],
    ['does not return the event', companion('1.54.1').replace('snapshot) cat', 'snapshot) echo nothing; : ')],
  ] as const;
  for (const [name, body] of stages) {
    const { h, kept, r } = await updateOldHost(body);
    expect(r.exit, name).toBe(24);
    expect(r.result, name).toMatchObject({ outcome: 'failed', error: { kind: 'selfTestFailed' } });
    expect(await readFile(h.agent, 'utf8'), name).toBe(kept);
    expect(await residue(h), name).toEqual([]);
  }
});

test('a self test runs with a cleared environment so host secrets never reach the downloaded file', async () => {
  const item = release('1.54.1', companion('1.54.1', 'case "$0" in */asset) [ -z "${SECRET-}${HOME-}" ] || exit 9;; esac'));
  publish(item);
  const h = await host();
  mode = 'ok';
  const r = await install(h, item.version, item.digest, item.body.length);
  expect(r.exit).toBe(0);
});

test('an installed companion that fails after the replace is rolled back to the previous binary', async () => {
  // The same file passes from the staging directory and fails from the managed one.
  const body = `#!/bin/sh\ncase "$0" in */lazysh-agent) [ "$1" != --version ] || echo 'lazysh-agent 0.0.1'; exit 0;; esac\n${companion('1.54.1').split('\n').slice(1).join('\n')}`;
  const { h, kept, r } = await updateOldHost(body);
  expect(r.exit).toBe(25);
  expect(r.result).toMatchObject({ outcome: 'failed', error: { kind: 'rolledBack' } });
  expect(await readFile(h.agent, 'utf8')).toBe(kept);
  expect(await lstat(h.previous).catch(() => null), 'the restored binary is not also kept as previous').toBeNull();
  expect(await residue(h)).toEqual([]);
  // A first install that fails afterwards leaves no half-installed companion behind.
  const item = release('1.54.1', body);
  const fresh = await host();
  expect((await install(fresh, item.version, item.digest, item.body.length)).exit).toBe(25);
  expect(await lstat(fresh.agent).catch(() => null)).toBeNull();
});

test.each([
  ['a pin that is not a version', ['1.54', 'a'.repeat(64), '10', TARGET]],
  ['a version with a leading zero', ['01.54.1', 'a'.repeat(64), '10', TARGET]],
  ['a version carrying a command', ['1.54.1$(touch pwned)', 'a'.repeat(64), '10', TARGET]],
  ['a digest in upper case', ['1.54.1', 'A'.repeat(64), '10', TARGET]],
  ['a short digest', ['1.54.1', 'a'.repeat(63), '10', TARGET]],
  ['zero bytes', ['1.54.1', 'a'.repeat(64), '0', TARGET]],
  ['a size over the cap', ['1.54.1', 'a'.repeat(64), '67108865', TARGET]],
  ['a size with an expression', ['1.54.1', 'a'.repeat(64), '1+1', TARGET]],
  ['a Windows target', ['1.54.1', 'a'.repeat(64), '10', 'windows-agent-x64']],
])('usage: %s is refused before anything is created or fetched', async (_name, pin) => {
  const h = await host();
  log.length = 0;
  const r = await install(h, '', '', 0, { args: [...pin, h.managed] });
  expect(r.exit).toBe(2);
  expect(r.result).toMatchObject({ outcome: 'failed', exitCode: 2, error: { kind: 'usage' } });
  expect(await lstat(h.managed).catch(() => null)).toBeNull();
  expect(await lstat(join(h.home, 'pwned')).catch(() => null)).toBeNull();
  expect(log).toEqual([]);
});

test.each([
  ['a relative directory', 'data/lazysh/companion'],
  ['a directory outside the managed namespace', '/tmp/elsewhere'],
  ['a parent traversal', '/tmp/x/../lazysh/companion'],
  ['a dot component', '/tmp/./lazysh/companion'],
  ['a control character', '/tmp/a\nb/lazysh/companion'],
])('usage: %s is refused', async (_name, directory) => {
  const h = await host();
  const r = await install(h, '1.54.1', 'a'.repeat(64), 10, { args: ['1.54.1', 'a'.repeat(64), '10', TARGET, directory] });
  expect(r).toMatchObject({ exit: 2, result: { error: { kind: 'usage' } } });
  expect(await lstat(h.managed).catch(() => null)).toBeNull();
  const wrongCount = await install(h, '1.54.1', 'a'.repeat(64), 10, { args: ['1.54.1', 'a'.repeat(64)] });
  expect(wrongCount.exit).toBe(2);
});

test('an unsafe managed location is refused and never written through', async () => {
  const item = release('1.54.1');
  publish(item);
  mode = 'ok';
  const shared = await host();
  await mkdir(shared.managed, { recursive: true, mode: 0o700 });
  await chmod(shared.managed, 0o770);
  expect(await install(shared, item.version, item.digest, item.body.length)).toMatchObject({ exit: 27, result: { error: { kind: 'unsafeInstallLocation' } } });
  const linked = await host();
  const elsewhere = join(linked.home, 'elsewhere');
  await mkdir(elsewhere, { mode: 0o700 });
  await mkdir(join(linked.home, '.local/share/lazysh'), { recursive: true });
  await symlink(elsewhere, linked.managed);
  expect(await install(linked, item.version, item.digest, item.body.length)).toMatchObject({ exit: 27 });
  expect(await readdir(elsewhere)).toEqual([]);
  const binary = await host();
  await mkdir(binary.managed, { recursive: true, mode: 0o700 });
  await writeFile(join(binary.home, 'outside'), companion('1.28.0'), { mode: 0o700 });
  await symlink(join(binary.home, 'outside'), binary.agent);
  expect(await install(binary, item.version, item.digest, item.body.length)).toMatchObject({ exit: 27 });
  expect(await readFile(join(binary.home, 'outside'), 'utf8')).toBe(companion('1.28.0'));
  const wrongPlatform = await host();
  expect(await install(wrongPlatform, item.version, item.digest, item.body.length, { args: [item.version, item.digest, String(item.body.length), 'macos-agent-arm64', wrongPlatform.managed] })).toMatchObject({ exit: 27 });
});

test('another running bootstrap is reported busy and a stale lock is taken over', async () => {
  const item = release('1.54.1');
  publish(item);
  mode = 'ok';
  const h = await host();
  await mkdir(join(h.managed, '.lazysh-bootstrap.lock'), { recursive: true, mode: 0o700 });
  expect(await install(h, item.version, item.digest, item.body.length)).toMatchObject({ exit: 26, result: { error: { kind: 'busy' } } });
  expect((await lstat(join(h.managed, '.lazysh-bootstrap.lock'))).isDirectory(), 'a lock this run did not take is never removed').toBe(true);
  const old = new Date(Date.now() - 11 * 60_000);
  await utimes(join(h.managed, '.lazysh-bootstrap.lock'), old, old);
  // The run that held the stale lock was killed: its staging directory is residue the next run clears.
  await put(join(h.managed, '.update.killed/asset'), 'partial download');
  expect(await install(h, item.version, item.digest, item.body.length)).toMatchObject({ exit: 0, result: { outcome: 'updated' } });
  expect(await residue(h)).toEqual([]);
});

test('a host without a downloader or a SHA-256 tool is told so before anything is fetched', async () => {
  const item = release('1.54.1');
  publish(item);
  mode = 'ok';
  log.length = 0;
  const none = await host([]);
  expect(await install(none, item.version, item.digest, item.body.length)).toMatchObject({ exit: 30, result: { error: { kind: 'hostToolMissing', detail: 'noDownloader' } } });
  const busybox = await host([]);
  await writeFile(join(busybox.bin, 'wget'), "#!/bin/sh\necho 'BusyBox v1.36.1 multi-call binary.'\n", { mode: 0o700 });
  expect(await install(busybox, item.version, item.digest, item.body.length)).toMatchObject({ exit: 30, result: { error: { detail: 'noDownloader' } } });
  const digestless = await host();
  await rm(join(digestless.bin, 'sha256sum'), { force: true });
  await rm(join(digestless.bin, 'shasum'), { force: true });
  expect(await install(digestless, item.version, item.digest, item.body.length)).toMatchObject({ exit: 30, result: { error: { detail: 'noDigestTool' } } });
  expect(log).toEqual([]);
  for (const h of [none, busybox, digestless]) expect(await residue(h)).toEqual([]);
});

test('GNU wget downloads when curl is absent and applies the same checks', async () => {
  if (!Bun.which('wget')) return;
  const item = release('1.54.1');
  publish(item);
  mode = 'ok';
  const h = await host(['wget']);
  const r = await install(h, item.version, item.digest, item.body.length);
  expect({ exit: r.exit, outcome: r.result.outcome }).toEqual({ exit: 0, outcome: 'updated' });
  expect(await readFile(h.agent)).toEqual(item.body);
  const tampered = await host(['wget']);
  mode = 'flip';
  expect(await install(tampered, item.version, item.digest, item.body.length)).toMatchObject({ exit: 22, result: { error: { detail: 'digestMismatch' } } });
  // wget has no size option: the descriptor-level file size limit alone must stop a body of unbounded size.
  mode = 'oversize';
  expect(await install(tampered, item.version, item.digest, item.body.length)).toMatchObject({ exit: 22, result: { error: { detail: 'sizeMismatch' } } });
  expect(await residue(tampered)).toEqual([]);
  mode = 'http-redirect';
  expect((await install(tampered, item.version, item.digest, item.body.length)).exit, 'an http redirect is not followed').not.toBe(0);
  mode = 'ok';
  const untrusted = await install(tampered, item.version, item.digest, item.body.length, { trusted: false });
  expect(untrusted).toMatchObject({ exit: 20, result: { error: { detail: 'tls' } } });
  expect(await lstat(tampered.agent).catch(() => null)).toBeNull();
});

test('the production script contacts only the fixed release URL over HTTPS with the documented limits and never uses sudo', async () => {
  const item = release('1.54.1');
  const h = await host([]);
  const calls = join(h.home, 'calls');
  await writeFile(join(h.bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nfor last; do :; done\nout=\nwhile [ "$#" -gt 0 ]; do case $1 in -o) out=$2;; esac; shift; done\ncp '${join(h.home, 'served')}' "$out"\n`, { mode: 0o700 });
  await writeFile(join(h.home, 'served'), item.body);
  for (const privileged of ['sudo', 'su', 'doas', 'pkexec']) await writeFile(join(h.bin, privileged), `#!/bin/sh\necho ${privileged} >> '${join(h.home, 'privileged')}'\nexit 1\n`, { mode: 0o700 });
  const r = await install(h, item.version, item.digest, item.body.length, { production: true });
  expect(r.exit).toBe(0);
  const recorded = (await readFile(calls, 'utf8')).trim().split('\n');
  expect(recorded).toHaveLength(1);
  const arguments_ = recorded[0].split(' ');
  expect(arguments_.at(-1)).toBe(`${PRODUCTION}/v1.54.1/lazysh-1.54.1-${TARGET}.bin`);
  expect(arguments_).toEqual(expect.arrayContaining(['--proto', '=https', '--proto-redir', '--tlsv1.2', '--fail', '--max-redirs', '3', '--max-filesize', String(item.body.length), '--max-time']));
  expect(await lstat(join(h.home, 'privileged')).catch(() => null)).toBeNull();
});

test('progress reports the bytes the host has received and a termination cleans up completely', async () => {
  const big = release('1.54.1', companion('1.54.1') + '#'.repeat(256 * 1024));
  publish(big);
  mode = 'slow';
  const h = await host();
  const text = script.replace(PRODUCTION, `https://127.0.0.1:${port}/mihazs/lazysh/releases/download`);
  const child = Bun.spawn([SH, '-c', text, 'lazysh-bootstrap', big.version, big.digest, String(big.body.length), TARGET, h.managed],
    { stdout: 'pipe', stderr: 'pipe', env: { PATH: h.bin, HOME: h.home, CURL_CA_BUNDLE: ca, SSL_CERT_FILE: ca } });
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const counted = () => seen.split('\n').filter((line) => line.includes('"bytes"')).map((line) => JSON.parse(line).bytes as number);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !counted().some((bytes) => bytes > 0)) {
    const chunk = await reader.read();
    if (chunk.done) break;
    seen += decoder.decode(chunk.value);
  }
  expect(counted().some((bytes) => bytes > 0 && bytes < big.body.length)).toBe(true);
  child.kill('SIGTERM');
  expect(await child.exited).toBe(143);
  expect(await residue(h), 'staging and the lock are removed on termination').toEqual([]);
  expect(await lstat(h.agent).catch(() => null)).toBeNull();
  mode = 'ok';
});

import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { digestFile } from '../.changeset/release-artifacts';
import { exactlyOne, windowsNsisBinaryDigest } from '../.changeset/release-platform';
import { assertCargoReceipt, descendantsOf, edgeDriverVersion, freePorts, hostState, launch, mainWindow, parseHostState,
  parseProcessTable, pinnedTools, powershell, processTable, requireOwnedWindowsRunner, sameImage, killOwned, until,
  WebDriver, WebDriverError, type HostState, type ProcessRow } from './support/windowsGui';

const root = join(import.meta.dir, '..');
const results = join(root, 'test-results/windows-gui');

test('Windows installed GUI acceptance refuses any job it does not own', () => {
  const owned = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: 'C:\\Temp' };
  expect(() => requireOwnedWindowsRunner(owned, 'win32')).not.toThrow();
  for (const [env, platform] of [[owned, 'linux'], [{ ...owned, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'],
    [{ ...owned, GITHUB_ACTIONS: undefined }, 'win32'], [{ ...owned, RUNNER_TEMP: '' }, 'win32']] as const)
    expect(() => requireOwnedWindowsRunner(env, platform)).toThrow('owned GitHub-hosted Windows job');
});

test('process ownership follows real parent chains and ignores recycled parent identifiers', () => {
  const rows = [
    { pid: 10, parent: 1, path: 'C:\\tauri-driver.exe', created: 100 }, { pid: 11, parent: 10, path: 'C:\\msedgedriver.exe', created: 110 },
    { pid: 12, parent: 11, path: 'C:\\Installed\\lazysh.exe', created: 120 }, { pid: 13, parent: 12, path: null, created: 130 },
    { pid: 20, parent: 10, path: 'C:\\Stale\\lazysh.exe', created: 50 }, { pid: 30, parent: 2, path: 'C:\\Other\\lazysh.exe', created: 120 },
  ];
  expect(descendantsOf(rows, { pid: 10, created: 100 }).map(row => row.pid).sort()).toEqual([11, 12, 13]);
  expect(descendantsOf(rows, { pid: 99, created: 0 })).toEqual([]);
  expect(sameImage('c:/installed/LAZYSH.exe', 'C:\\Installed\\lazysh.exe')).toBe(true);
  expect(sameImage('C:\\Installed\\other\\lazysh.exe', 'C:\\Installed\\lazysh.exe')).toBe(false);
  expect(sameImage(null, 'C:\\Installed\\lazysh.exe')).toBe(false);
  expect(parseProcessTable(JSON.stringify(rows))).toEqual(rows);
  for (const bad of ['{}', '[{"pid":"1","parent":1,"path":null,"created":1}]', '[{"pid":1,"parent":1,"path":5,"created":1}]'])
    expect(() => parseProcessTable(bad)).toThrow('Invalid Windows process table');
});

test('host state and pinned tool receipts reject anything that is not exactly the owned fixture', () => {
  const state = { runtime: '130.0.2849.80', paths: { roaming: 'C:\\Users\\runner\\AppData\\Roaming\\app.lazysh.client' }, present: ['roaming'] };
  expect(parseHostState(JSON.stringify(state))).toEqual(state);
  for (const bad of [{ ...state, runtime: '' }, { ...state, present: ['unknown'] }, { ...state, paths: { roaming: 'relative' } }])
    expect(() => parseHostState(JSON.stringify(bad))).toThrow('Invalid Windows host state');
  const receipt = (version_req: string, bins: string[]) => JSON.stringify({ installs: {
    'tauri-driver 2.1.0 (registry+https://github.com/rust-lang/crates.io-index)': { version_req, bins } } });
  expect(() => assertCargoReceipt(receipt('=2.1.0', ['tauri-driver.exe']), 'tauri-driver', '2.1.0', 'tauri-driver.exe')).not.toThrow();
  for (const bad of [receipt('^2.1.0', ['tauri-driver.exe']), receipt('=2.1.0', ['other.exe']), '{"installs":{}}'])
    expect(() => assertCargoReceipt(bad, 'tauri-driver', '2.1.0', 'tauri-driver.exe')).toThrow('pinned Cargo');
  expect(edgeDriverVersion('Microsoft Edge WebDriver 130.0.2849.80 (a8a1f9c)\r\n')).toBe('130.0.2849.80');
  expect(() => edgeDriverVersion('ChromeDriver 130.0.0.0')).toThrow('Unrecognized');
});

test('the WebDriver client sends the Tauri application capability and reports driver errors', async () => {
  const calls: { method: string; url: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    calls.push({ method: request.method!, url: request.url!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
    const reply = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ value })); };
    if (request.url === '/session') reply(200, { sessionId: 'abc', capabilities: {} });
    else if (request.url!.endsWith('/element')) reply(404, { error: 'no such element', message: 'absent' });
    else if (request.url!.endsWith('/url')) reply(500, { error: 'unknown error', message: 'x'.repeat(2000) });
    else if (request.method === 'DELETE') reply(200, null);
    else if (request.url!.endsWith('/hang')) return;
    else reply(200, 'tauri://localhost');
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const driver = new WebDriver(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await driver.create('C:\\Installed\\lazysh.exe');
    expect(calls[0].body).toEqual({ capabilities: { alwaysMatch: { 'tauri:options': { application: 'C:\\Installed\\lazysh.exe' } } } });
    expect(await driver.find('.absent')).toBeUndefined();
    const failure = await driver.url().catch(error => error);
    expect(failure).toBeInstanceOf(WebDriverError);
    expect(failure.message.length).toBeLessThan(500);
    await expect(driver.request('GET', '/hang', undefined, 100)).rejects.toThrow();
    await driver.quit();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/session/abc' });
  } finally { server.close(); }
});

// ---- Actual Windows acceptance: exactly one installed image, driven through the real WebView2 window. ----

async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
function runToExit(program: string, args: string[], milliseconds = 120_000) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore', windowsHide: true });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${program} exceeded its ${milliseconds}ms deadline`)); }, milliseconds);
    child.once('error', reject);
    child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`${program} exited with ${code}`)); });
  });
}
/** Remove one application-specific root that was absent before the test, refusing links and non-directories. */
async function removeOwnedRoot(path: string) {
  const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Owned Windows application root was replaced by a link or file');
  await rm(path, { recursive: true, maxRetries: 10, retryDelay: 500 });
}
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
async function uninstall(directory: string, before: HostState) {
  const installed = join(directory, 'lazysh.exe'), uninstaller = join(directory, 'uninstall.exe');
  if (await exists(uninstaller)) {
    await runToExit(uninstaller, ['/S', `_?=${directory}`]);
    expect(await exists(installed)).toBe(false);
    expect(await readdir(directory)).toEqual(['uninstall.exe']);
    await unlink(uninstaller);
  }
  await rmdir(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  // Only the key the installer wrote for this exact directory; the roots below were absent in `before`.
  await powershell(String.raw`
$key = 'HKCU:\Software\lazysh\lazysh'
if (Test-Path -LiteralPath $key) {
  if ((Get-Item -LiteralPath $key).GetValue('') -ne ${quote(directory)}) { throw 'Foreign lazysh installation key' }
  Remove-Item -LiteralPath $key
}`);
  for (const name of ['roaming', 'local', 'localLegacy'] as const) await removeOwnedRoot(before.paths[name]);
}

test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1')('actual Windows installed GUI owns the installed image, shows its bundled identity, shuts down in bounds and uninstalls cleanly', async () => {
  requireOwnedWindowsRunner();
  await mkdir(results, { recursive: true });
  const need = (name: string) => process.env[name] || (() => { throw new Error(`${name} is required`); })();
  const driverTool = need('LAZYSH_WINDOWS_GUI_DRIVER'), edgeDriver = need('LAZYSH_WINDOWS_GUI_EDGEDRIVER');
  const revision = need('LAZYSH_EXPECTED_SOURCE_REVISION');
  expect(revision).toMatch(/^[0-9a-f]{40}$/);
  const { version } = await Bun.file(join(root, 'apps/client/package.json')).json();
  const installer = await exactlyOne('nsis/*.exe', join(root, 'target/release/bundle'));
  const binary = join(root, 'target/release/lazysh.exe');
  const predicted = await windowsNsisBinaryDigest(binary, await digestFile(binary));

  // Ambient installations and application data are rejected, never adopted or removed.
  const before = await hostState();
  expect(before.present).toEqual([]);
  await pinnedTools(driverTool, edgeDriver, before.runtime);

  const directory = join(process.env.RUNNER_TEMP!, `lazysh-installed-gui-${crypto.randomUUID()}`);
  const installed = join(directory, 'lazysh.exe');
  const alive = async (identity: Pick<ProcessRow, 'pid' | 'created'>) =>
    (await processTable()).some(row => row.pid === identity.pid && row.created === identity.created);
  let driver: ReturnType<typeof launch> | undefined;
  let owner: ProcessRow | undefined;
  let browser: WebDriver | undefined;
  let app: ProcessRow | undefined;
  let failed = false;
  try {
    await mkdir(directory);
    await runToExit(installer, ['/S', '/NS', `/D=${directory}`]);
    const image = await digestFile(installed);
    expect(image).toEqual(predicted);
    expect((await processTable()).filter(row => sameImage(row.path, installed))).toEqual([]);

    const [port, nativePort] = await freePorts(2);
    const log = join(results, 'tauri-driver.log');
    await writeFile(log, '');
    driver = launch(driverTool, ['--port', String(port), '--native-port', String(nativePort), '--native-host', '127.0.0.1', '--native-driver', edgeDriver], log);
    owner = await until('driver process identity', async () => (await processTable()).find(row => row.pid === driver!.pid));
    browser = new WebDriver(`http://127.0.0.1:${port}`);
    await until('driver readiness', async () => browser!.request('GET', '/status', undefined, 5000).then(() => true, () => undefined));
    await browser.create(installed);

    // The only application image in the driver's process tree is the installed one, with a real native window.
    const rows = await processTable();
    const images = descendantsOf(rows, owner).filter(row => sameImage(row.path, installed));
    expect(images).toHaveLength(1);
    app = images[0];
    expect(rows.filter(row => sameImage(row.path, binary))).toEqual([]);
    const hwnd = await until('native window handle', async () => { const handle = await mainWindow(app!.pid); return handle > 0 ? handle : undefined; });
    expect(new URL(await browser.url()).hostname).toBe('tauri.localhost');

    // Bundled About identity: the shown version and source revision are the ones this job built.
    const about = await until('About button', () => browser!.find('button.about-button'));
    expect(await browser.text(about)).toBe(`About lazysh · ${version}`);
    await browser.click(about);
    const panel = await until('About panel', async () => (await browser!.script(
      "const p=document.querySelector('.about-panel');return p?{description:p.querySelector('p')?.textContent??'',revision:p.querySelector('code')?.textContent??'',dirty:/uncommitted/.test(p.textContent??'')}:null")) ?? undefined);
    expect(panel.description).toContain(`Version ${version}`);
    expect(panel.revision).toBe(revision);
    expect(await alive(app)).toBe(true);
    console.info(`Windows installed GUI evidence: image sha256=${image.sha256}; app pid=${app.pid} start=${app.created} hwnd=${hwnd}; about version=${version} revision=${panel.revision} dirty=${panel.dirty}`);

    // Bounded shutdown: closing the session retires the application, then the driver and its whole tree.
    const closing = performance.now();
    await browser.quit();
    browser = undefined;
    await until('application retirement', async () => (await alive(app!)) ? undefined : true, 15_000);
    driver.kill();
    await until('driver tree retirement', async () => {
      const now = await processTable();
      return now.some(row => row.pid === owner!.pid && row.created === owner!.created) || descendantsOf(now, owner!).length ? undefined : true;
    }, 15_000);
    console.info(`Windows installed GUI evidence: shutdown in ${Math.round(performance.now() - closing)}ms`);
  } catch (error) {
    failed = true;
    console.error(`Windows installed GUI failure; driver log:\n${(await readFile(join(results, 'tauri-driver.log'), 'utf8').catch(() => '')).slice(-6000)}`);
    if (browser?.session) await browser.screenshot().then(png => writeFile(join(results, 'window.png'), Buffer.from(png, 'base64'))).catch(() => undefined);
    const tree = owner ? descendantsOf(await processTable().catch(() => []), owner) : [];
    console.error(`Windows installed GUI driver tree: ${JSON.stringify(tree)}`);
    throw error;
  } finally {
    if (owner) await killOwned(owner);
    else driver?.kill();
    if (app) await until('retired application', async () => (await alive(app!)) ? undefined : true, 15_000).catch(() => undefined);
    try { await uninstall(directory, before); }
    catch (error) { if (!failed) throw error; console.error(`Windows installed GUI cleanup failed: ${error}`); }
  }
  expect((await hostState()).present).toEqual([]);
}, 900_000);

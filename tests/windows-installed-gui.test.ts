import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { lstat, mkdir, readdir, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { digestFile } from '../.changeset/release-artifacts';
import { project } from './support/gitFixture';
import { document, evaluate, executedSteps } from './support/workflowGraph';
import { exactlyOne, windowsNsisBinaryDigest } from '../.changeset/release-platform';
import { assertCargoReceipt, descendantsOf, edgeDriverVersion, freePorts, hostState, installWebViewArguments, launch, mainWindow, parseHostState,
  parseProcessTable, pinnedTools, powershell, processTable, quote, removeWebViewArguments, requireOwnedWindowsRunner, sameImage, killOwned, until,
  WebDriver, WebDriverError, type HostState, type ProcessRow } from './support/windowsGui';

const root = join(import.meta.dir, '..');
const results = join(root, 'test-results/windows-gui');

test('Windows installer dispatches only build the requested profile', async () => {
  const { jobs } = await document('.github/workflows/windows-surface-probe.yml');
  const job = jobs['terminal-windows-app-host'];
  for (const [event_name, installer_engine, anchor, installer, gui] of [
    ['pull_request', undefined, true, false, false],
    ['push', undefined, true, false, false],
    ['workflow_dispatch', 'skip', true, false, false],
    ['workflow_dispatch', 'on', false, true, true],
    ['workflow_dispatch', 'off', false, true, true],
  ] as const) {
    const context = { github: { event_name }, inputs: { installer_engine } };
    expect(evaluate(job['timeout-minutes'], context)).toBe(installer ? 90 : 60);
    const steps = await executedSteps(job.steps, context);
    const names = steps.map(({ step }) => step.name);
    expect(names.includes('Build the native-enabled app and run the Windows anchor test')).toBe(anchor);
    const build = steps.find(({ step }) => step.name === 'Build and verify the unsigned native terminal test installer');
    expect(Boolean(build)).toBe(installer);
    if (installer) expect(build?.step.run).toContain('await verifyWindowsTerminalEngine(binary, process.env.LAZYSH_NATIVE_TERMINAL)');
    expect(names.includes('Verify xterm.js fallback in the installed build')).toBe(gui);
  }
});

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
  const state = { runtime: '130.0.2849.80', paths: { roaming: 'C:\\Users\\runner\\AppData\\Roaming\\app.lazysh.client' }, present: ['roaming', 'webViewArguments'] };
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

type Reply = (status: number, value: unknown) => void;
/** A loopback WebDriver endpoint that records every request; `answer` decides the reply, and not replying hangs the request. */
async function recordingDriver(answer: (request: { method: string; url: string }, reply: Reply) => void) {
  const calls: { method: string; url: string; body: any }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    calls.push({ method: request.method!, url: request.url!, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined });
    answer({ method: request.method!, url: request.url! }, (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ value })); });
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { calls, driver: new WebDriver(`http://127.0.0.1:${(server.address() as { port: number }).port}`), close: () => server.close() };
}

test('the WebDriver client sends the Tauri application capability and reports driver errors', async () => {
  const { calls, driver, close } = await recordingDriver(({ method, url }, reply) => {
    if (url === '/session') reply(200, { sessionId: 'abc', capabilities: {} });
    else if (url.endsWith('/element')) reply(404, { error: 'no such element', message: 'absent' });
    else if (url.endsWith('/url')) reply(500, { error: 'unknown error', message: 'x'.repeat(2000) });
    else if (method === 'DELETE') reply(200, null);
    else if (!url.endsWith('/hang')) reply(200, 'tauri://localhost');
  });
  try {
    await driver.create('C:\\Installed\\lazysh.exe');
    expect(calls[0].body).toEqual({ capabilities: { alwaysMatch: { 'tauri:options': { application: 'C:\\Installed\\lazysh.exe' } } } });
    expect(await driver.find('.absent')).toBeUndefined();
    const failure = await driver.url().catch(error => error);
    expect(failure).toBeInstanceOf(WebDriverError);
    expect(failure.message.length).toBeLessThan(500);
    await expect(driver.request('GET', '/hang', undefined, 100)).rejects.toThrow();
    await driver.quit();
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/session/abc' });
  } finally { close(); }
});

test('the WebDriver client searches below an element, types into controls and sends real key presses', async () => {
  const { calls, driver, close } = await recordingDriver(({ url }, reply) =>
    reply(200, url.endsWith('/element') ? { 'element-6066-11e4-a52e-4f735466cecf': 'e2' } : url.endsWith('/displayed') ? true : 'secret'));
  try {
    driver.session = 's';
    expect(await driver.find(".//button[normalize-space()='Cancel']", 'e1', 'xpath')).toBe('e2');
    await driver.type('e2', 'secret');
    expect(await driver.property('e2', 'value')).toBe('secret');
    expect(await driver.displayed('e2')).toBe(true);
    await driver.keys('c\uE007');
    expect(calls.map(({ method, url, body }) => ({ method, url, body }))).toEqual([
      { method: 'POST', url: '/session/s/element/e1/element', body: { using: 'xpath', value: ".//button[normalize-space()='Cancel']" } },
      { method: 'POST', url: '/session/s/element/e2/value', body: { text: 'secret' } },
      { method: 'GET', url: '/session/s/element/e2/property/value', body: undefined },
      { method: 'GET', url: '/session/s/element/e2/displayed', body: undefined },
      { method: 'POST', url: '/session/s/actions', body: { actions: [{ type: 'key', id: 'keyboard', actions: [
        { type: 'keyDown', value: 'c' }, { type: 'keyUp', value: 'c' }, { type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] } },
    ]);
  } finally { close(); }
});

// The runner validates a composite manifest when it loads the action and rejects the step before anything runs, and a
// `continue-on-error` caller then reports that step as a success. Only these keys are accepted on a composite step.
test('every composite action step uses only keys the runner accepts', async () => {
  const accepted = new Set(['id', 'if', 'name', 'run', 'shell', 'uses', 'with', 'env', 'continue-on-error', 'working-directory']);
  const manifests = [...new Bun.Glob('.github/actions/*/action.yml').scanSync({ cwd: project, dot: true })].sort();
  expect(manifests).toContain('.github/actions/windows-installed-gui/action.yml');
  for (const manifest of manifests) {
    const steps: any[] = (await document(manifest)).runs.steps ?? [];
    expect(steps.map(step => ({ manifest, step: step.name, unknown: Object.keys(step).filter(key => !accepted.has(key)) })))
      .toEqual(steps.map(step => ({ manifest, step: step.name, unknown: [] })));
  }
});

// ---- Actual Windows acceptance: exactly one installed image, driven through the real WebView2 window. ----

async function exists(path: string) { return lstat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }); }
function runToExit(program: string, args: string[], milliseconds = 120_000, cwd?: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(program, args, { stdio: 'ignore', windowsHide: true, cwd });
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
  await removeWebViewArguments();
}

const needEnv = (name: string) => process.env[name] || (() => { throw new Error(`${name} is required`); })();

/** What a scenario may touch: the one running installed application, a second launch of it, and a loopback target that must stay unused. */
interface InstalledGui {
  browser: WebDriver;
  app: ProcessRow;
  installed: string;
  version: string;
  revision: string;
  image: { sha256: string };
  hwnd: number;
  /** A second launch of the installed image, the way a shortcut or a shell starts it; it must hand over and exit. */
  secondary(args: string[], cwd?: string): Promise<void>;
  /** Connections the loopback target (the saved hosts' address) has accepted. */
  connections(): number;
  owned(): Promise<ProcessRow[]>;
}

/**
 * Install the packaged application into a fresh directory, start exactly one of it below pinned tauri-driver and run `scenario`
 * against it, then require bounded shutdown, uninstall and a host that matches its initial state again.
 */
async function withInstalledGui(name: string, scenario: (gui: InstalledGui) => Promise<void>, options: { savedHosts?: boolean } = {}) {
  requireOwnedWindowsRunner();
  await mkdir(results, { recursive: true });
  const driverTool = needEnv('LAZYSH_WINDOWS_GUI_DRIVER'), edgeDriver = needEnv('LAZYSH_WINDOWS_GUI_EDGEDRIVER');
  const revision = needEnv('LAZYSH_EXPECTED_SOURCE_REVISION');
  expect(revision).toMatch(/^[0-9a-f]{40}$/);
  const { version } = await Bun.file(join(root, 'apps/client/package.json')).json();
  const release = join(process.env.CARGO_TARGET_DIR || join(root, 'target'), 'release');
  const installer = await exactlyOne('nsis/*.exe', join(release, 'bundle'));
  const binary = join(release, 'lazysh.exe');
  const predicted = await windowsNsisBinaryDigest(binary, await digestFile(binary));

  // Ambient installations and application data are rejected, never adopted or removed.
  const before = await hostState();
  // Name what is there: an earlier step of the job that leaves application data behind shows up here, not in its own result.
  if (before.present.length) {
    const listing = await Promise.all(before.present.filter(name => name in before.paths).map(async name => `${name} ${before.paths[name]}\n` +
      await powershell(`Get-ChildItem -Force -Recurse -Depth 3 -LiteralPath ${quote(before.paths[name])} -ErrorAction SilentlyContinue | Select-Object -First 60 | ForEach-Object { '{0} {1} {2:o}' -f $_.FullName, $_.Length, $_.LastWriteTimeUtc }`).catch(() => 'listing unavailable')));
    throw new Error(`The Windows host holds state this case does not own: ${before.present.join(', ')}\n${listing.join('\n')}`);
  }
  await pinnedTools(driverTool, edgeDriver, before.runtime);

  const directory = join(process.env.RUNNER_TEMP!, `lazysh-installed-gui-${crypto.randomUUID()}`);
  const installed = join(directory, 'lazysh.exe');
  const alive = async (identity: Pick<ProcessRow, 'pid' | 'created'>) =>
    (await processTable()).some(row => row.pid === identity.pid && row.created === identity.created);
  let accepted = 0;
  const target = createNetServer(socket => { accepted++; socket.destroy(); });
  let driver: ReturnType<typeof launch> | undefined;
  let owner: ProcessRow | undefined;
  let browser: WebDriver | undefined;
  let app: ProcessRow | undefined;
  let failed = false;
  try {
    await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
    if (options.savedHosts) {
      const { port } = target.address() as { port: number };
      await mkdir(before.paths.roaming, { recursive: true });
      await writeFile(join(before.paths.roaming, 'hosts.json'), JSON.stringify([
        { id: 'gui-first', name: 'Primary GUI host', hostname: '127.0.0.1', port, username: 'owned' },
        { id: 'gui-selected', name: 'Selected GUI host', hostname: '127.0.0.1', port, username: 'owned' },
      ]));
    }
    await mkdir(directory);
    await installWebViewArguments();
    await runToExit(installer, ['/S', '/NS', `/D=${directory}`]);
    const image = await digestFile(installed);
    expect(image).toEqual(predicted);
    expect((await processTable()).filter(row => sameImage(row.path, installed))).toEqual([]);

    const [port, nativePort] = await freePorts(2);
    driver = launch(driverTool, ['--port', String(port), '--native-port', String(nativePort), '--native-driver', edgeDriver]);
    owner = await until('driver process identity', async () => (await processTable()).find(row => row.pid === driver!.child.pid));
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

    const tree = owner;
    await scenario({ browser, app, installed, version, revision, image, hwnd,
      secondary: (args, cwd) => runToExit(installed, args, 30_000, cwd), connections: () => accepted,
      owned: async () => descendantsOf(await processTable(), tree).filter(row => sameImage(row.path, installed)) });
    expect(await alive(app)).toBe(true);

    // Bounded shutdown: closing the session retires the application, then the driver and its whole tree.
    const closing = performance.now();
    await browser.quit();
    browser = undefined;
    await until('application retirement', async () => (await alive(app!)) ? undefined : true, 15_000);
    driver.child.kill();
    await until('driver tree retirement', async () => {
      const now = await processTable();
      return now.some(row => row.pid === owner!.pid && row.created === owner!.created) || descendantsOf(now, owner!).length ? undefined : true;
    }, 15_000);
    console.info(`Windows installed GUI evidence (${name}): image sha256=${image.sha256}; app pid=${app.pid} start=${app.created} hwnd=${hwnd}; shutdown in ${Math.round(performance.now() - closing)}ms`);
  } catch (error) {
    failed = true;
    await writeFile(join(results, `${name}-tauri-driver.log`), driver?.output() ?? '');
    console.error(`Windows installed GUI failure (${name}); driver output:\n${driver?.output().slice(-6000)}`);
    if (browser?.session) console.error(`Windows installed GUI page: ${JSON.stringify(await browser.script(
      'return {url: location.href, title: document.title, text: document.body.innerText.slice(0, 1500)}').catch(() => null))}`);
    if (browser?.session) await browser.screenshot().then(png => writeFile(join(results, `${name}-window.png`), Buffer.from(png, 'base64'))).catch(() => undefined);
    const tree = owner ? descendantsOf(await processTable().catch(() => []), owner) : [];
    console.error(`Windows installed GUI driver tree: ${JSON.stringify(tree)}`);
    throw error;
  } finally {
    target.close();
    if (owner) await killOwned(owner);
    else driver?.child.kill();
    if (app) await until('retired application', async () => (await alive(app!)) ? undefined : true, 15_000).catch(() => undefined);
    try { await uninstall(directory, before); }
    catch (error) { if (!failed) throw error; console.error(`Windows installed GUI cleanup failed: ${error}`); }
  }
  expect((await hostState()).present).toEqual([]);
}

const actual = test.skipIf(process.env.LAZYSH_TEST_WINDOWS_GUI !== '1');

actual('actual Windows installed GUI owns the installed image, shows its bundled identity, shuts down in bounds and uninstalls cleanly', () =>
  withInstalledGui('identity', async ({ browser, app, version, revision, image, hwnd }) => {
    // Bundled About identity: the shown version and source revision are the ones this job built.
    const about = await until('About button', () => browser.find('button.about-button'));
    expect(await browser.text(about)).toBe(`About lazysh · ${version}`);
    await browser.click(about);
    const panel = await until('About panel', async () => (await browser.script(
      "const p=document.querySelector('.about-panel');return p?{description:p.querySelector('p')?.textContent??'',revision:p.querySelector('code')?.textContent??'',dirty:/uncommitted/.test(p.textContent??'')}:null")) ?? undefined);
    expect(panel.description).toContain(`Version ${version}`);
    expect(panel.revision).toBe(revision);
    console.info(`Windows installed GUI evidence: image sha256=${image.sha256}; app pid=${app.pid} hwnd=${hwnd}; about version=${version} revision=${panel.revision} dirty=${panel.dirty}`);
  }), 900_000);

const dialog = (host: string) => `[role="dialog"][aria-label="Connect to ${host}"]`;
const cancel = ".//button[normalize-space()='Cancel']";

actual('actual Windows installed GUI hands a secondary --host launch to the original window, keeps its manual dialog and opens the selected saved host', () =>
  withInstalledGui('singleton-host', async ({ browser, app, secondary, connections, owned }) => {
    await browser.click(await until('first saved host', () => browser.find('button[aria-label="Connect to Primary GUI host"]')));
    const manual = await until('manual connection dialog', () => browser.find(dialog('Primary GUI host')));
    const password = (await browser.find('input[type="password"]', manual))!;
    await browser.type(password, 'synthetic-manual-value');

    // A second launch of the installed image forwards its argv to the original window and exits; nothing else starts or moves.
    await secondary(['--host', 'gui-selected']);
    expect(await owned()).toEqual([app]);
    expect(await browser.displayed(manual)).toBe(true);
    expect(await browser.property(password, 'value')).toBe('synthetic-manual-value');
    await browser.click((await browser.find(cancel, manual, 'xpath'))!);

    // The forwarded request is admitted once the manual dialog is gone, with empty credentials; Connect is never pressed.
    const selected = await until('selected host dialog', () => browser.find(dialog('Selected GUI host')));
    expect(await browser.property((await browser.find('input[type="password"]', selected))!, 'value')).toBe('');
    expect(connections()).toBe(0);
    await browser.click((await browser.find(cancel, selected, 'xpath'))!);
    await until('selected host dialog closed', async () => (await browser.find(dialog('Selected GUI host'))) ? undefined : true);

    // A second explicit launch with a multiplexer selector opens another dialog, again handed to the original window.
    await secondary(['--host=gui-selected', '--mux=tmux:owned-gui-server']);
    const next = await until('next selected host dialog', () => browser.find(dialog('Selected GUI host')));
    expect(await browser.text(next)).toContain('Mux launches use SSH for their control connection. The saved host transport is unchanged.');
    expect(await owned()).toEqual([app]);
    expect(connections()).toBe(0);
  }, { savedHosts: true }), 900_000);

actual('actual Windows installed GUI opens a caller-relative literal directory in the original window and observes the real shell cwd', async () => {
  const caller = join(process.env.RUNNER_TEMP ?? '', `lg-${crypto.randomUUID().slice(0, 8)}`);
  const name = "workspace é '$(printf NO);";
  const path = join(caller, name);
  await mkdir(path, { recursive: true });
  try {
    await withInstalledGui('singleton-dir', async ({ browser, app, secondary, connections, owned }) => {
      await until('application shell', () => browser.find('button.about-button'));
      const engineBuild = process.env.LAZYSH_NATIVE_TERMINAL;
      const narrator = process.env.LAZYSH_WINDOWS_GUI_NARRATOR === '1';
      if (narrator) {
        const platform = await browser.script(`return Promise.all([
          window.__TAURI_INTERNALS__.invoke('screen_reader_active'),
          window.__TAURI_INTERNALS__.invoke('terminal_core_available'),
        ]);`) as [boolean, {available: boolean}];
        expect(platform[0]).toBe(true);
        expect(platform[1].available).toBe(true);
      }
      if (engineBuild === 'off' || engineBuild === 'on') {
        await browser.script(`
          localStorage.setItem('lazysh.preferences.v1', JSON.stringify({version: 1, terminalEngine: 'native'}));
          localStorage.setItem('lazysh.terminal.backend', 'native');
        `);
        await browser.request('POST', `/session/${browser.session}/refresh`, {});
        await until('application shell after setting Native', () => browser.find('button.about-button'));
        await browser.click(await until('Workspace tools', () => browser.find('button.workspace-tools-trigger')));
        const menu = await until('Application tools', () => browser.find('#workspace-tools-page-application:not([aria-hidden="true"])'));
        await browser.click(await until('Preferences in Workspace tools', () =>
          browser.find(".//button[normalize-space()='Preferences']", menu, 'xpath')));
        await browser.click(await until('Terminal and accessibility settings', () => browser.find('button[data-settings-target="terminal"]')));
        const reason = await until('disabled native engine reason', () => browser.find('#terminal-engine-native-off'));
        const refusal = await browser.text(reason);
        if (engineBuild === 'off') expect(refusal).toContain('disabled in this build');
        else if (narrator) expect(refusal).toContain('a screen reader is active and the native engine cannot be read by it');
        else expect(refusal).toMatch(/no hardware GPU, only a software rasterizer|no adapter the policy accepts could create a device/);
        console.info(`Windows installed terminal rollback (${engineBuild}): ${refusal}`);
        const native = await until('Native engine radio', () => browser.find('input[name="terminal-engine"][value="native"]'));
        expect(await browser.property(native, 'checked')).toBe(true);
        expect(await browser.property(native, 'disabled')).toBe(true);
        await browser.click(await until('Close Preferences', () => browser.find('button[aria-label="Close Preferences"]')));
      }
      await secondary(['--dir', name], caller);
      const screen = await until('local terminal', () => browser.find('.terminal-canvas .xterm-screen'));
      expect(await owned()).toEqual([app]);

      // The shell's own prompt names its working directory; `cd` prints it again after real keyboard input reaches the ConPTY.
      const shown = async () => (await browser.text(screen)).replaceAll(/\s*\n\s*/g, '');
      await until('prompt in the requested directory', async () => (await shown()).includes(path) ? true : undefined, 30_000);
      await browser.click(screen);
      await browser.keys('cd');
      await until('cd output', async () => (await shown()).split(path).length > 3 ? true : undefined, 30_000);
      if (narrator) {
        await until('xterm accessibility tree containing the shell directory', async () => {
          const text = await browser.script("return document.querySelector('.terminal-canvas .xterm-accessibility')?.textContent ?? ''");
          return typeof text === 'string' && text.includes(path) ? true : undefined;
        });
      }
      expect(connections()).toBe(0);
    });
  } finally { await rm(caller, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
}, 900_000);

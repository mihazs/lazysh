import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

/** The installed-GUI acceptance runs only on a fresh GitHub-hosted Windows VM that the job exclusively owns. */
export function requireOwnedWindowsRunner(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform) {
  if (platform !== 'win32' || env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !env.RUNNER_TEMP)
    throw new Error('Windows installed GUI acceptance requires an owned GitHub-hosted Windows job');
}

export async function until<T>(stage: string, probe: () => Promise<T | undefined>, milliseconds = 30_000): Promise<T> {
  const deadline = performance.now() + milliseconds;
  do {
    const value = await probe();
    if (value !== undefined) return value;
    await delay(250);
  } while (performance.now() < deadline);
  throw new Error(`Windows installed GUI deadline: ${stage}`);
}

export async function powershell(script: string, timeout = 60_000) {
  const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64');
  try {
    return (await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout, maxBuffer: 8_388_608, windowsHide: true })).stdout.trim();
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    throw new Error(`PowerShell failed: ${String(stderr).slice(0, 2000)} ${String(stdout).slice(0, 500)}`);
  }
}

// ---- Host state: the only roots the acceptance may own are the ones absent before it starts. ----

export interface HostState { runtime: string; paths: Record<string, string>; present: string[] }
const stateNames = ['roaming', 'local', 'localLegacy', 'desktopShortcut', 'programsShortcut',
  'manufacturerKey', 'uninstallKey', 'protocolKey', 'machineUninstallKey', 'autostart'];
export const hostStateScript = String.raw`
$webview = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
$runtime = @('HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\', 'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\') |
  ForEach-Object { $key = Get-Item -LiteralPath ($_ + $webview) -ErrorAction SilentlyContinue; if ($key) { $key.GetValue('pv') } } |
  Where-Object { $_ } | Select-Object -First 1
$paths = [ordered]@{
  roaming = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'app.lazysh.client'
  local = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'app.lazysh.client'
  localLegacy = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'lazysh'
  desktopShortcut = Join-Path ([Environment]::GetFolderPath('DesktopDirectory')) 'lazysh.lnk'
  programsShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'lazysh.lnk'
}
$keys = [ordered]@{
  manufacturerKey = 'HKCU:\Software\lazysh\lazysh'
  uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\lazysh'
  protocolKey = 'HKCU:\Software\Classes\lazysh'
  machineUninstallKey = 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\lazysh'
}
$present = @()
foreach ($name in $paths.Keys) { if (Get-Item -Force -LiteralPath $paths[$name] -ErrorAction SilentlyContinue) { $present += $name } }
foreach ($name in $keys.Keys) { if (Test-Path -LiteralPath $keys[$name]) { $present += $name } }
$run = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
if ($run -and ($run.PSObject.Properties.Name -contains 'lazysh')) { $present += 'autostart' }
ConvertTo-Json -Compress -InputObject ([ordered]@{ runtime = [string]$runtime; paths = $paths; present = @($present) })
`;
export function parseHostState(stdout: string): HostState {
  const state = JSON.parse(stdout);
  if (typeof state?.runtime !== 'string' || !/^(?:\d+\.){3}\d+$/.test(state.runtime)
    || !Array.isArray(state.present) || state.present.some((name: unknown) => !stateNames.includes(name as string))
    || Object.values(state.paths ?? {}).some(path => typeof path !== 'string' || !win32.isAbsolute(path)))
    throw new Error('Invalid Windows host state');
  return state;
}
export const hostState = async () => parseHostState(await powershell(hostStateScript));

// ---- Pinned tools. ----

/** Cargo records the exact `--version` request of an installed binary; refuse any other install. */
export function assertCargoReceipt(receipt: string, crate: string, version: string, binary: string) {
  const installed = JSON.parse(receipt).installs?.[`${crate} ${version} (registry+https://github.com/rust-lang/crates.io-index)`];
  if (installed?.version_req !== `=${version}` || !Array.isArray(installed.bins) || !installed.bins.includes(binary))
    throw new Error(`Windows installed GUI requires the pinned Cargo ${crate} ${version} installation`);
}
export function edgeDriverVersion(output: string) {
  const version = /^Microsoft Edge WebDriver ((?:\d+\.){3}\d+)\b/.exec(output.trim())?.[1];
  if (!version) throw new Error('Unrecognized Microsoft Edge WebDriver version output');
  return version;
}
export async function pinnedTools(driver: string, edgeDriver: string, runtime: string) {
  assertCargoReceipt(await Bun.file(join(dirname(dirname(driver)), '.crates2.json')).text(), 'tauri-driver', '2.1.0', 'tauri-driver.exe');
  const { stdout } = await execute(edgeDriver, ['--version'], { timeout: 30_000, windowsHide: true });
  // The official driver must be the exact build of the WebView2 runtime the application will load.
  if (edgeDriverVersion(stdout) !== runtime) throw new Error('Microsoft Edge WebDriver does not match the installed WebView2 runtime');
}

// ---- Process ownership. ----

export interface ProcessRow { pid: number; parent: number; path: string | null; created: number }
export const processTableScript = String.raw`
ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object {
  [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; path = $_.ExecutablePath
    created = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 } }
})
`;
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows) || rows.some(row => !Number.isSafeInteger(row?.pid) || !Number.isSafeInteger(row?.parent)
    || !Number.isSafeInteger(row?.created) || (row?.path !== null && typeof row?.path !== 'string')))
    throw new Error('Invalid Windows process table');
  return rows;
}
export const processTable = async () => parseProcessTable(await powershell(processTableScript));
/** Everything below `root`; a row that predates its parent is a recycled PID, not a child. */
export function descendantsOf(rows: ProcessRow[], root: { pid: number; created: number }) {
  const started = new Map([[root.pid, root.created]]);
  const found: ProcessRow[] = [];
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      const parent = started.get(row.parent);
      if (parent !== undefined && !started.has(row.pid) && row.created >= parent) { started.set(row.pid, row.created); found.push(row); grew = true; }
    }
  }
  return found;
}
export const sameImage = (path: string | null, image: string) => path !== null && win32.normalize(path).toLowerCase() === win32.normalize(image).toLowerCase();
export const mainWindow = async (pid: number) =>
  Number(await powershell(`(Get-Process -Id ${Math.trunc(pid)}).MainWindowHandle.ToInt64()`));

/** Start a long-lived tool whose most recent 64 KiB of output is kept for failure reports. */
export function launch(program: string, args: string[]) {
  let output = '';
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-65_536); });
  return { child, output: () => output };
}
/** Terminate the driver and whatever is still below it, matched by PID and start time so no recycled PID is touched. */
export async function killOwned(owner: ProcessRow) {
  const rows = await processTable();
  const victims = descendantsOf(rows, owner);
  if (rows.some(row => row.pid === owner.pid && row.created === owner.created)) victims.push(owner);
  for (const row of victims) await execute('taskkill.exe', ['/PID', String(row.pid), '/F'], { timeout: 30_000, windowsHide: true }).catch(() => undefined);
}
export async function freePorts(count: number) {
  const servers = await Promise.all(Array.from({ length: count }, () => new Promise<ReturnType<typeof createServer>>((resolve, reject) => {
    const server = createServer().once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  })));
  const ports = servers.map(server => (server.address() as { port: number }).port);
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  return ports;
}

// ---- A minimal W3C WebDriver (classic) client; tauri-driver proxies it to Microsoft's EdgeDriver. ----

export class WebDriverError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export class WebDriver {
  session = '';
  constructor(readonly origin: string) {}
  async request(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeout = 30_000) {
    const response = await fetch(this.origin + path, { method, signal: AbortSignal.timeout(timeout),
      headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json: { value?: any };
    try { json = JSON.parse(text); } catch { throw new WebDriverError('invalid response', `WebDriver ${method} ${path}: HTTP ${response.status} not JSON`); }
    if (!response.ok || json.value?.error)
      throw new WebDriverError(String(json.value?.error ?? response.status), `WebDriver ${method} ${path}: ${json.value?.error ?? response.status}: ${String(json.value?.message ?? '').slice(0, 400)}`);
    return json.value;
  }
  private call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, timeout?: number) {
    return this.request(method, `/session/${this.session}${path}`, body, timeout);
  }
  async create(application: string) {
    this.session = (await this.request('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application } } } }, 90_000)).sessionId;
  }
  url = () => this.call('GET', '/url') as Promise<string>;
  async find(selector: string) {
    try { return (await this.call('POST', '/element', { using: 'css selector', value: selector }))[ELEMENT] as string; }
    catch (error) { if (error instanceof WebDriverError && error.code === 'no such element') return undefined; throw error; }
  }
  click = (element: string) => this.call('POST', `/element/${element}/click`, {});
  text = (element: string) => this.call('GET', `/element/${element}/text`) as Promise<string>;
  script = (source: string, args: unknown[] = []) => this.call('POST', '/execute/sync', { script: source, args });
  screenshot = () => this.call('GET', '/screenshot') as Promise<string>;
  async quit() { const session = this.session; this.session = ''; await this.request('DELETE', `/session/${session}`, undefined, 20_000); }
}

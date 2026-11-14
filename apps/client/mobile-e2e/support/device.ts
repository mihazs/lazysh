import {execFile} from 'node:child_process';
import {mkdir, open, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {promisify} from 'node:util';

// The only module that changes device state (window size, density, navigation mode, IME, animations, rotation,
// permissions). A run holds an advisory lock per serial, records the baseline in a journal before anything changes, and
// restores it afterwards, so a shared Waydroid guest or emulator is left as it was found.

const exec = promisify(execFile);
export const APP_PACKAGE = 'app.lazysh.client';
const ANIMATIONS = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const;

export type Adb = (...args: string[]) => Promise<string>;
export interface Baseline {
  size: string | null;
  density: number | null;
  navigation: string | null;
  ime: string;
  animations: Record<(typeof ANIMATIONS)[number], string>;
  rotation: {user: string; auto: string};
  permissions: Record<string, boolean>;
}

/** adb pinned to one serial: every call is `adb -s <serial> ...`, never the default device. */
export function adbFor(serial: string, binary = process.env.ADB || 'adb'): Adb {
  if (!serial) throw new Error('ANDROID_SERIAL is required: refusing to let adb pick a device');
  return async (...args) => (await exec(binary, ['-s', serial, ...args], {timeout: 30_000, maxBuffer: 4 << 20})).stdout;
}

const shell = (adb: Adb, ...args: string[]) => adb('shell', ...args);
const read = async (adb: Adb, ...args: string[]) => (await shell(adb, ...args)).trim();
const override = (text: string, name: string) => new RegExp(`Override ${name}: (\\S+)`).exec(text)?.[1] ?? null;

export const setWindowSize = (adb: Adb, size: string | null) => shell(adb, 'wm', 'size', size ?? 'reset');
export const setDensity = (adb: Adb, density: number | null) => shell(adb, 'wm', 'density', density === null ? 'reset' : String(density));
export const setNavigation = (adb: Adb, overlay: string) => shell(adb, 'cmd', 'overlay', 'enable-exclusive', '--category', overlay);
export const setIme = (adb: Adb, ime: string) => shell(adb, 'ime', 'set', ime);
const putSetting = (adb: Adb, namespace: string, key: string, value: string) =>
  value === 'null' ? shell(adb, 'settings', 'delete', namespace, key) : shell(adb, 'settings', 'put', namespace, key, value);
export const setAnimationScale = (adb: Adb, scale: string) => Promise.all(ANIMATIONS.map(key => putSetting(adb, 'global', key, scale)));
export const setRotation = (adb: Adb, user: string, auto: string) =>
  Promise.all([putSetting(adb, 'system', 'user_rotation', user), putSetting(adb, 'system', 'accelerometer_rotation', auto)]);
export const setPermission = (adb: Adb, permission: string, granted: boolean) =>
  shell(adb, 'pm', granted ? 'grant' : 'revoke', '--user', '0', APP_PACKAGE, permission);

async function runtimePermissions(adb: Adb) {
  const permissions: Record<string, boolean> = {};
  const block = (await shell(adb, 'dumpsys', 'package', APP_PACKAGE)).split('runtime permissions:')[1] ?? '';
  for (const line of block.split('\n').slice(1)) { // shortcut: user 0 only, the first block; extend for multi-user guests
    const match = /^\s+([\w.]+): granted=(true|false)/.exec(line);
    if (!match) break;
    permissions[match[1]] = match[2] === 'true';
  }
  return permissions;
}

export async function captureBaseline(adb: Adb): Promise<Baseline> {
  const [size, density, overlays, ime, user, auto, permissions, ...scales] = await Promise.all([
    shell(adb, 'wm', 'size'), shell(adb, 'wm', 'density'), shell(adb, 'cmd', 'overlay', 'list', '--user', '0'),
    read(adb, 'settings', 'get', 'secure', 'default_input_method'),
    read(adb, 'settings', 'get', 'system', 'user_rotation'), read(adb, 'settings', 'get', 'system', 'accelerometer_rotation'),
    runtimePermissions(adb), ...ANIMATIONS.map(key => read(adb, 'settings', 'get', 'global', key)),
  ]);
  const density_ = override(density, 'density');
  return {
    size: override(size, 'size'), density: density_ === null ? null : Number(density_),
    navigation: /^\[x\] (com\.android\.internal\.systemui\.navbar\.\S+)/m.exec(overlays)?.[1] ?? null,
    ime, animations: Object.fromEntries(ANIMATIONS.map((key, index) => [key, scales[index]])) as Baseline['animations'],
    rotation: {user, auto}, permissions,
  };
}

/** Changes only what differs from the baseline, applies every step even when one fails, then reports all failures together. */
export async function restoreBaseline(adb: Adb, baseline: Baseline) {
  const now = await captureBaseline(adb);
  const differs = (key: keyof Baseline) => JSON.stringify(now[key]) !== JSON.stringify(baseline[key]);
  const steps: [string, () => Promise<unknown>][] = [];
  if (differs('size')) steps.push(['window size', () => setWindowSize(adb, baseline.size)]);
  if (differs('density')) steps.push(['density', () => setDensity(adb, baseline.density)]);
  if (differs('ime')) steps.push(['IME', () => setIme(adb, baseline.ime)]);
  if (differs('rotation')) steps.push(['rotation', () => setRotation(adb, baseline.rotation.user, baseline.rotation.auto)]);
  if (differs('navigation') && baseline.navigation) steps.push(['navigation mode', () => setNavigation(adb, baseline.navigation!)]);
  for (const key of ANIMATIONS.filter(name => now.animations[name] !== baseline.animations[name])) {
    steps.push([key, () => putSetting(adb, 'global', key, baseline.animations[key])]);
  }
  for (const [name, granted] of Object.entries(baseline.permissions).filter(([name, granted]) => now.permissions[name] !== granted)) {
    steps.push([`permission ${name}`, () => setPermission(adb, name, granted)]);
  }
  const failed: string[] = [];
  for (const [name, step] of steps) await step().catch((error: Error) => failed.push(`${name}: ${error.message.split('\n')[0]}`));
  if (failed.length) throw new Error(`Device baseline not fully restored (${failed.join('; ')})`);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; } };

export interface AcquireOptions {
  stateDir?: string;
  lockTimeoutMs?: number;
  pollMs?: number;
  /** Restore a journal left by a run that died, instead of refusing. */
  recover?: boolean;
  adb?: Adb;
  log?: (message: string) => void;
}
export interface DeviceSession {
  adb: Adb;
  baseline: Baseline;
  journal: string;
  /** Restores the baseline, removes the journal only when that succeeded, and always releases the lock. */
  release(): Promise<void>;
}

async function takeLock(path: string, timeoutMs: number, pollMs: number, log: (message: string) => void) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(JSON.stringify({pid: process.pid, started: new Date().toISOString()}));
      await file.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const owner = await readFile(path, 'utf8').then(text => JSON.parse(text) as {pid: number; started: string}).catch(() => undefined);
    // A lock that cannot be read is being written by a run that has just created it: only a stale empty file is taken over.
    const unreadableAndStale = !owner && Date.now() - (await stat(path).then(info => info.mtimeMs, () => 0)) > 5000;
    // shortcut: advisory lock, a dead owner is taken over without a compare-and-swap; two waiters racing here is not guarded.
    if (owner ? !alive(owner.pid) : unreadableAndStale) { await rm(path, {force: true}); continue; }
    const heldBy = owner ? `pid ${owner.pid} since ${owner.started} (${Math.max(0, Math.round((Date.now() - Date.parse(owner.started)) / 60_000))} min ago)` : 'a run that is still starting';
    if (Date.now() >= deadline) throw new Error(`Device is busy: lock ${path} is held by ${heldBy}`);
    if (!announced) log(`Waiting for the device lock held by ${heldBy}`);
    announced = true;
    await delay(pollMs);
  }
}

/** A per-user mode-0700 directory: /tmp itself is shared, so a predictable file there could be a planted symlink. */
async function privateStateDir() {
  // Fixed, not $TMPDIR: two runs with different TMPDIR values must still meet at the same lock.
  const directory = join('/tmp', `lazysh-mobile-e2e-${process.getuid?.() ?? 'user'}`);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const info = await stat(directory);
  if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0) throw new Error(`${directory} must be private to this user`);
  return directory;
}

const stem = (serial: string) => `lazysh-mobile-e2e-${serial.replace(/[^\w.-]/g, '_')}`;
export const journalPath = (serial: string, stateDir: string) => join(stateDir, `${stem(serial)}.journal.json`);

export async function acquireDevice(serial: string, options: AcquireOptions = {}): Promise<DeviceSession> {
  const {lockTimeoutMs = 600_000, pollMs = 2000, recover = false, log = console.log} = options;
  const stateDir = options.stateDir ?? await privateStateDir();
  const adb = options.adb ?? adbFor(serial), lock = join(stateDir, `${stem(serial)}.lock`), journal = journalPath(serial, stateDir);
  await mkdir(stateDir, {recursive: true});
  await takeLock(lock, lockTimeoutMs, pollMs, log);
  try {
    const leftover = await readFile(journal, 'utf8').then(text => JSON.parse(text) as Baseline, () => undefined);
    if (leftover && !recover) {
      throw new Error(`Device ${serial} was left modified by an earlier run (journal ${journal}). Restore it, or rerun with LAZYSH_E2E_RECOVER=1`);
    }
    if (leftover) { await restoreBaseline(adb, leftover); await rm(journal); }
    const baseline = await captureBaseline(adb);
    await writeFile(journal, JSON.stringify(baseline), {mode: 0o600});
    return {
      adb, baseline, journal,
      async release() {
        try { await restoreBaseline(adb, baseline); await rm(journal, {force: true}); } finally { await rm(lock, {force: true}); }
      },
    };
  } catch (error) {
    await rm(lock, {force: true});
    throw error;
  }
}

/** For a worker process: restore the baseline recorded by the launcher without releasing the run's lock. */
export async function restoreFromJournal(serial: string, stateDir?: string, adb = adbFor(serial)) {
  await restoreBaseline(adb, JSON.parse(await readFile(journalPath(serial, stateDir ?? await privateStateDir()), 'utf8')) as Baseline);
}

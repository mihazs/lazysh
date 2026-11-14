import {afterEach, beforeEach, expect, test} from 'bun:test';
import {access, mkdtemp, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {acquireDevice, adbFor, ensurePhoneScreen, ensureThreeButtonNavigation, journalPath, restoreFromJournal, setDensity, setIme, setNavigation, setPermission, setWindowSize} from './device';
import {createFakeAdb, type FakeDevice} from './fakeAdb';

const SERIAL = 'fake:5555';
let fake: Awaited<ReturnType<typeof createFakeAdb>>, stateDir: string, cleanup: string[];
const exists = (path: string) => access(path).then(() => true, () => false);
const options = () => ({stateDir, adb: adbFor(SERIAL, fake.binary), log: () => {}, lockTimeoutMs: 400, pollMs: 20});
const changed = async (adb = adbFor(SERIAL, fake.binary)) => {
  await setWindowSize(adb, '1080x2000'); await setDensity(adb, 300); await setNavigation(adb, 'com.android.internal.systemui.navbar.gestural');
  await setIme(adb, 'org.example/.OtherIme'); await setPermission(adb, 'android.permission.POST_NOTIFICATIONS', true);
};
const baselineOf = (state: FakeDevice) => JSON.stringify({...state, calls: [], failOn: []});

beforeEach(async () => { fake = await createFakeAdb(); stateDir = await mkdtemp(join(tmpdir(), 'lazysh-device-state-')); cleanup = [fake.directory, stateDir]; });
afterEach(async () => { await Promise.all(cleanup.map(path => rm(path, {recursive: true, force: true}))); });

test('adb is always pinned to the serial and refuses to run without one', async () => {
  expect(() => adbFor('')).toThrow('ANDROID_SERIAL is required');
  const session = await acquireDevice(SERIAL, options());
  await session.release();
  const calls = (await fake.read()).calls;
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(call => call.startsWith(`-s ${SERIAL} shell `))).toBe(true);
});

test('the baseline of every managed setting is restored, and the lock and journal are removed', async () => {
  const before = baselineOf(await fake.read());
  const session = await acquireDevice(SERIAL, options());
  expect(session.baseline).toMatchObject({size: null, density: null, navigation: 'com.android.internal.systemui.navbar.threebutton',
    ime: 'com.android.inputmethod.latin/.LatinIME', permissions: {'android.permission.POST_NOTIFICATIONS': false}});
  expect((await stat(session.journal)).mode & 0o777).toBe(0o600);
  await changed(session.adb);
  expect(baselineOf(await fake.read())).not.toBe(before);
  await session.release();
  expect(baselineOf(await fake.read())).toBe(before);
  expect(await exists(session.journal)).toBe(false);
  expect(await exists(join(stateDir, `lazysh-mobile-e2e-fake_5555.lock`))).toBe(false);
});

test('a second run waits for the first, names its owner, and proceeds once it is released', async () => {
  const first = await acquireDevice(SERIAL, options());
  const messages: string[] = [];
  const blocked = acquireDevice(SERIAL, {...options(), log: message => messages.push(message), lockTimeoutMs: 80});
  await expect(blocked).rejects.toThrow(`held by pid ${process.pid}`);
  expect(messages[0]).toContain(`pid ${process.pid}`);
  const second = acquireDevice(SERIAL, {...options(), lockTimeoutMs: 5000});
  await first.release();
  await (await second).release();
});

test('a lock another run has just created and not yet filled is not taken over', async () => {
  await writeFile(join(stateDir, 'lazysh-mobile-e2e-fake_5555.lock'), '');
  await expect(acquireDevice(SERIAL, {...options(), lockTimeoutMs: 100})).rejects.toThrow('Device is busy');
});

test('a lock whose owner died is taken over', async () => {
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  await writeFile(join(stateDir, 'lazysh-mobile-e2e-fake_5555.lock'), JSON.stringify({pid: dead, started: 'earlier'}));
  await (await acquireDevice(SERIAL, options())).release();
});

test('a failing restore step does not stop the others, keeps the journal and still releases the lock', async () => {
  const before = baselineOf(await fake.read());
  const session = await acquireDevice(SERIAL, options());
  await changed(session.adb);
  const state = await fake.read();
  await fake.write({...state, failOn: ['ime set']});
  await expect(session.release()).rejects.toThrow(/not fully restored \(IME: Command failed/);
  const after = await fake.read();
  expect(after.size).toBeNull();
  expect(after.density).toBeNull();
  expect(after.permissions['android.permission.POST_NOTIFICATIONS']).toBe(false);
  expect(after.settings['secure.default_input_method']).toBe('org.example/.OtherIme');
  expect(await exists(session.journal)).toBe(true);
  expect(await exists(join(stateDir, 'lazysh-mobile-e2e-fake_5555.lock'))).toBe(false);

  // The journal is the dirty-baseline marker: the next run refuses until it is recovered.
  await fake.write({...after, failOn: []});
  await expect(acquireDevice(SERIAL, options())).rejects.toThrow('left modified by an earlier run');
  expect(await exists(join(stateDir, 'lazysh-mobile-e2e-fake_5555.lock'))).toBe(false);
  const recovered = await acquireDevice(SERIAL, {...options(), recover: true});
  expect(baselineOf(await fake.read())).toBe(before);
  await recovered.release();
});

test('a worker restores the launcher baseline from the journal without touching the lock', async () => {
  const before = baselineOf(await fake.read());
  const session = await acquireDevice(SERIAL, options());
  await changed(session.adb);
  await restoreFromJournal(SERIAL, stateDir, session.adb);
  expect(baselineOf(await fake.read())).toBe(before);
  expect(await exists(journalPath(SERIAL, stateDir))).toBe(true);
  await session.release();
});

test('a tablet-shaped guest gets a phone window that the baseline takes away again, and a phone window is left alone', async () => {
  expect(await ensurePhoneScreen(adbFor(SERIAL, fake.binary))).toBe(false);
  expect(await fake.read()).toMatchObject({size: null, density: null});
  await fake.write({...await fake.read(), physical: {size: '1920x1080', density: 180}});
  const session = await acquireDevice(SERIAL, options());
  expect(await ensurePhoneScreen(session.adb)).toBe(true);
  expect(await fake.read()).toMatchObject({size: '1080x2400', density: 420});
  expect(await ensurePhoneScreen(session.adb)).toBe(false);
  await session.release();
  expect(await fake.read()).toMatchObject({size: null, density: null});
});

test('a guest left on a gestural overlay starts from three buttons, and the baseline puts the overlay back', async () => {
  await fake.write({...await fake.read(), navigation: 'gestural'});
  const session = await acquireDevice(SERIAL, options());
  expect(await ensureThreeButtonNavigation(session.adb)).toBe(true);
  expect(await fake.read()).toMatchObject({navigation: 'threebutton'});
  expect(await ensureThreeButtonNavigation(session.adb)).toBe(false);
  await session.release();
  expect(await fake.read()).toMatchObject({navigation: 'gestural'});
});

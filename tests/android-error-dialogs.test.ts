import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedProcess } from './support/ownedProcess';

const script = new URL('../.github/scripts/android-dismiss-error-dialogs.sh', import.meta.url).pathname;
const temporary: string[] = [];
afterAll(() => Promise.all(temporary.map(path => rm(path, { recursive: true, force: true }))));

const node = (id: string, text: string, bounds: string, owner = 'android') =>
  `<node index="0" text="${text}" resource-id="${id}" class="android.widget.Button" package="${owner}" bounds="${bounds}" />`;
const hierarchy = (...nodes: string[]) => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${nodes.join('')}</hierarchy>`;
const message = node('android:id/message', "System UI isn't responding", '[10,20][30,40]');
const close = node('android:id/aerr_close', 'Close app', '[100,200][300,400]');
const wait = node('android:id/aerr_wait', 'Wait', '[500,600][700,800]');

/**
 * A fake adb whose dialog goes away after `gone` taps (never when `gone` is large) and whose
 * uiautomator can be made to fail. It records every tap, like the real `input tap`.
 */
async function run(dialog: string[], options: { gone?: number; attempts?: number; unreadable?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-error-dialogs-'));
  temporary.push(directory);
  const taps = join(directory, 'taps');
  await writeFile(join(directory, 'with-dialog.xml'), hierarchy(message, ...dialog));
  await writeFile(join(directory, 'clean.xml'), hierarchy(message));
  await writeFile(taps, '');
  await writeFile(join(directory, 'adb'), `#!/bin/sh
case "$1 $2" in
  "shell uiautomator") [ -z "$UNREADABLE" ] || exit 1 ;;
  "exec-out cat")
    if [ "$(wc -l < "$TAPS")" -lt "$GONE" ]; then cat "$DIR/with-dialog.xml"; else cat "$DIR/clean.xml"; fi ;;
  "shell input") shift 3; echo "$*" >> "$TAPS" ;;
esac
`, { mode: 0o700 });
  const child = new OwnedProcess('/bin/sh', [script], directory, {
    PATH: process.env.PATH, ADB: join(directory, 'adb'), DIR: directory, TAPS: taps,
    GONE: String(options.gone ?? 0), LAZYSH_DIALOG_SETTLE_SECONDS: '0', ...(options.attempts ? { LAZYSH_DIALOG_ATTEMPTS: String(options.attempts) } : {}),
    ...(options.unreadable ? { UNREADABLE: '1' } : {}),
  });
  const stdout = await child.finish('actual dialog dismissal script', 10_000);
  return { stdout, taps: (await readFile(taps, 'utf8')).split('\n').filter(Boolean) };
}

test.skipIf(process.platform !== 'linux')('leaves a clean screen untouched', async () => {
  expect(await run([])).toEqual({ stdout: 'android error dialogs: none present\n', taps: [] });
});

test.skipIf(process.platform !== 'linux')('taps the centre of Wait, not Close app, until the dialog is gone', async () => {
  expect(await run([close, wait], { gone: 1 })).toEqual({
    stdout: 'android error dialogs: dismissed with 1 tap(s), last aerr_wait at 600 700\n', taps: ['600 700'] });
});

test.skipIf(process.platform !== 'linux')('falls back to Close app for a crash dialog without Wait', async () => {
  expect(await run([close], { gone: 1 })).toEqual({
    stdout: 'android error dialogs: dismissed with 1 tap(s), last aerr_close at 200 300\n', taps: ['200 300'] });
});

test.skipIf(process.platform !== 'linux')('finds Wait by its label when a release renames the resource id', async () => {
  expect((await run([node('', 'Wait', '[0,0][10,20]')], { gone: 1 })).taps).toEqual(['5 10']);
});

test.skipIf(process.platform !== 'linux')('never taps an app control that is merely labelled Wait or Close app', async () => {
  const app = [node('com.example:id/wait', 'Wait', '[1,1][3,3]', 'com.example'), node('com.example:id/close', 'Close app', '[1,1][3,3]', 'com.example')];
  expect(await run(app, { gone: 99 })).toEqual({ stdout: 'android error dialogs: none present\n', taps: [] });
});

test.skipIf(process.platform !== 'linux')('follows a second dialog and stops at its attempt bound without failing the job', async () => {
  expect((await run([wait], { gone: 2 })).taps).toEqual(['600 700', '600 700']);
  expect(await run([wait], { gone: 99, attempts: 3 })).toEqual({
    stdout: 'android error dialogs: still present after 3 tap(s), last aerr_wait at 600 700\n', taps: ['600 700', '600 700', '600 700'] });
});

test.skipIf(process.platform !== 'linux')('reports an unreadable hierarchy without tapping or failing the job', async () => {
  expect(await run([wait], { unreadable: true, attempts: 2 })).toEqual({ stdout: 'android error dialogs: view hierarchy unavailable\n', taps: [] });
});

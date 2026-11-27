import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnedProcess } from './support/ownedProcess';

const script = new URL('../.github/scripts/android-await-systemui.sh', import.meta.url).pathname;

type Device = {
  /** The SystemUI startup ANR is in the events buffer while fewer guest reboots than this have happened. */
  anrBoots?: number;
  /** ...but only from this many `logcat` reads on, like an ANR that fires late in the quiet window. */
  anrAfterReads?: number;
  noSystemUi?: boolean;
  /** After a reboot the old guest keeps answering (identity unchanged, ANR still visible) for this many identity reads. */
  staleReads?: number;
  /** The new guest reports sys.boot_completed empty for this many reads. */
  slowBoot?: number;
  /** The guest never reports another boot identity. */
  neverBack?: boolean;
  /** The guest's boot identity cannot be read at all. */
  unidentifiable?: boolean;
};

const fakeAdb = `#!/bin/sh
echo "$*" >> "$DIR/calls"
boots=$(cat "$DIR/boots"); reads=$(cat "$DIR/reads")
case "$*" in
  "logcat -b events -d -s am_anr")
    n=$(($(cat "$DIR/logcat") + 1)); echo "$n" > "$DIR/logcat"
    echo '11-13 16:43:40.000   635  1494 I am_anr  : [0,2222,com.example.other,1,Input dispatching timed out]'
    if [ "$n" -gt "$ANR_AFTER" ] && { [ "$boots" -lt "$ANR_BOOTS" ] || { [ "$boots" -gt 0 ] && [ "$reads" -le "$STALE" ]; }; }; then
      echo '11-13 16:43:47.100   635  1494 I am_anr  : [0,971,com.android.systemui,818462221,Process ProcessRecord{543b477 971:com.android.systemui/u0a124} failed to complete startup]'
    fi ;;
  "shell pidof com.android.systemui") [ -n "$NO_SYSTEMUI" ] || echo 971 ;;
  reboot) echo $((boots + 1)) > "$DIR/boots"; echo 0 > "$DIR/reads"; echo 0 > "$DIR/bc" ;;
  "shell cat /proc/sys/kernel/random/boot_id; getprop ro.boottime.zygote")
    [ -z "$UNIDENTIFIABLE" ] || exit 1
    echo $((reads + 1)) > "$DIR/reads"
    if [ "$boots" -gt 0 ] && { [ -n "$NEVER_BACK" ] || [ "$reads" -lt "$STALE" ]; }; then echo "boot-$((boots - 1))"; else echo "boot-$boots"; fi ;;
  "shell getprop sys.boot_completed")
    bc=$(($(cat "$DIR/bc") + 1)); echo "$bc" > "$DIR/bc"
    if [ "$boots" -gt 0 ] && [ "$bc" -le "$SLOW" ]; then echo; else echo 1; fi ;;
esac
`;

/**
 * Runs the real gate against a fake adb that models one emulator guest: a boot counter that only a
 * `reboot` advances, a SystemUI ANR record visible per the options, and an unrelated app's ANR that
 * must never count. Every adb invocation is recorded.
 */
async function run(device: Device = {}, environment: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lazysh-systemui-gate-'));
  try {
    for (const name of ['boots', 'reads', 'logcat', 'bc']) await writeFile(join(directory, name), '0');
    await writeFile(join(directory, 'calls'), '');
    await writeFile(join(directory, 'adb'), fakeAdb, { mode: 0o700 });
    const child = new OwnedProcess('/bin/sh', [script], directory, {
      PATH: process.env.PATH, ADB: join(directory, 'adb'), DIR: directory,
      ANR_BOOTS: String(device.anrBoots ?? 0), ANR_AFTER: String(device.anrAfterReads ?? 0), STALE: String(device.staleReads ?? 0), SLOW: String(device.slowBoot ?? 0),
      ...(device.noSystemUi ? { NO_SYSTEMUI: '1' } : {}), ...(device.neverBack ? { NEVER_BACK: '1' } : {}), ...(device.unidentifiable ? { UNIDENTIFIABLE: '1' } : {}),
      LAZYSH_SYSTEMUI_POLL_SECONDS: '0', LAZYSH_SYSTEMUI_POLLS: '3', LAZYSH_SYSTEMUI_BOOT_POLLS: '20', ...environment,
    });
    const code = await Promise.race([child.done, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('gate deadline')), 10_000))]);
    await child.stop();
    const calls = (await readFile(join(directory, 'calls'), 'utf8')).split('\n').filter(Boolean);
    return { code, lines: child.stdout.split('\n').filter(Boolean), reboots: calls.filter(call => call === 'reboot').length, reads: calls.filter(call => call.startsWith('logcat')).length };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== 'linux')('settles without a reboot, watching the whole quiet window and ignoring other apps\' ANRs', async () => {
  expect(await run()).toEqual({ code: 0, lines: ['android systemui gate: settled after 0 reboot(s)'], reboots: 0, reads: 4 });
});

test.skipIf(process.platform !== 'linux')('reboots once on a SystemUI startup ANR and waits for the new boot, not the stale guest', async () => {
  const result = await run({ anrBoots: 1, staleReads: 3, slowBoot: 2 });
  expect(result).toMatchObject({ code: 0, reboots: 1 });
  expect(result.lines).toEqual([
    expect.stringMatching(/^android systemui gate: unsettled: startup ANR event: .*com\.android\.systemui.*failed to complete startup/),
    'android systemui gate: rebooting the guest (1 of 2)',
    'android systemui gate: settled after 1 reboot(s)',
  ]);
});

test.skipIf(process.platform !== 'linux')('catches an ANR that is logged late in the quiet window', async () => {
  expect(await run({ anrBoots: 1, anrAfterReads: 3 })).toMatchObject({ code: 0, reboots: 1, lines: [expect.stringContaining('startup ANR event'), expect.stringContaining('rebooting'), expect.stringContaining('settled after 1')] });
});

test.skipIf(process.platform !== 'linux')('stops after the bounded reboots when every boot hangs SystemUI, before any native case', async () => {
  expect(await run({ anrBoots: 99 })).toMatchObject({ code: 1, reboots: 2, lines: expect.arrayContaining(['android systemui gate: still unsettled after 2 reboot(s); no native case was started']) });
  expect(await run({ anrBoots: 99 }, { LAZYSH_SYSTEMUI_REBOOTS: '0' })).toMatchObject({ code: 1, reboots: 0 });
});

test.skipIf(process.platform !== 'linux')('treats a missing SystemUI process as unsettled', async () => {
  expect(await run({ noSystemUi: true }, { LAZYSH_SYSTEMUI_REBOOTS: '1' })).toMatchObject({
    code: 1, reboots: 1, lines: expect.arrayContaining(['android systemui gate: unsettled: no SystemUI process']) });
});

test.skipIf(process.platform !== 'linux')('fails when the guest does not come back from a reboot, and never reboots it twice', async () => {
  expect(await run({ anrBoots: 99, neverBack: true }, { LAZYSH_SYSTEMUI_BOOT_POLLS: '3' })).toMatchObject({
    code: 1, reboots: 1, lines: expect.arrayContaining(['android systemui gate: the guest did not come back from the reboot; no native case was started']) });
});

test.skipIf(process.platform !== 'linux')('does not reboot a guest whose next boot it could not tell apart from the stale one', async () => {
  expect(await run({ anrBoots: 99, unidentifiable: true })).toMatchObject({ code: 1, reboots: 0, lines: expect.arrayContaining([expect.stringContaining('cannot read the guest boot identity')]) });
});

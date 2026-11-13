import {browser} from '@wdio/globals';
import {adbFor, APP_PACKAGE, setPermission} from './device';

// App lifecycle through Appium `mobile:` commands and device.ts, never through the Appium adb_shell feature.

const serial = () => process.env.ANDROID_SERIAL ?? '';

/** Installs (or replaces) the x86_64 debug APK named by LAZYSH_E2E_APK. */
export function installApp(apk = process.env.LAZYSH_E2E_APK) {
  if (!apk) throw new Error('Set LAZYSH_E2E_APK to the x86_64 debug APK (bun run build:android:emulator)');
  return browser.installApp(apk);
}

export const terminateApp = () => browser.terminateApp(APP_PACKAGE);
export const launchApp = () => browser.activateApp(APP_PACKAGE);
/** Stops the app and starts it again with its data intact. */
export async function relaunchApp() { await terminateApp(); await launchApp(); }

/**
 * Clears the app's data (hosts, vault, preferences) and starts it on the empty home. Use it in `after` (or `afterEach` when each
 * test connects its own host) so hosts made by one test never reach the next.
 */
export async function resetApp() {
  await browser.execute('mobile: clearApp', {appId: APP_PACKAGE});
  await launchApp();
}

/** Runtime permissions change through device.ts, which restores the baseline afterwards. Revoking stops the app. */
export const grantPermission = (permission: string) => setPermission(adbFor(serial()), permission, true);
export const revokePermission = (permission: string) => setPermission(adbFor(serial()), permission, false);

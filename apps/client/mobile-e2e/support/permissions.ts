import {adbFor, APP_PACKAGE} from './device';

/** Whether the app holds `permission` right now, read from the package manager. */
export async function isGranted(permission: string) {
  const dump = await adbFor(process.env.ANDROID_SERIAL ?? '')('shell', 'dumpsys', 'package', APP_PACKAGE);
  return new RegExp(`${permission.replace(/\./g, '\\.')}: granted=true`).test(dump);
}

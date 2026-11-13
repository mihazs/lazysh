import {adbFor} from './device';

// Files a test caused on the device's shared storage, found, read and removed through adb pinned to the run's serial.
const adb = () => adbFor(process.env.ANDROID_SERIAL ?? '');

/** The paths on shared storage (a symlink at /sdcard, so its target is searched) named `name`: the document picker saves where it last was, so the folder is not assumed. */
export async function findDeviceFiles(name: string) {
  return (await adb()('shell', 'find', '/storage/emulated/0', '-name', name, '-type', 'f')).split('\n').map(path => path.trim()).filter(Boolean);
}
export const readDeviceFile = (path: string) => adb()('shell', 'cat', path);
export async function removeDeviceFiles(name: string) {
  for (const path of await findDeviceFiles(name)) await adb()('shell', 'rm', '-f', path);
}

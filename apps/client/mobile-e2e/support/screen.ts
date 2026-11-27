import {relaunchApp} from './app';
import {adbFor, setDensity, setWindowSize} from './device';

/** A common phone: 1080x2340 pixels at 420 dpi (411x890 CSS pixels at 2.625), the compact layout the regression specs target. */
export const PHONE = {size: '1080x2340', density: 420} as const;

/**
 * Puts the device in the phone geometry and restarts the app in it. The baseline (a landscape guest or a real phone) is
 * restored by device.ts after each spec file, so a spec never undoes this itself.
 */
export async function usePhoneScreen() {
  const adb = adbFor(process.env.ANDROID_SERIAL ?? '');
  await setWindowSize(adb, PHONE.size);
  await setDensity(adb, PHONE.density);
  await relaunchApp();
}

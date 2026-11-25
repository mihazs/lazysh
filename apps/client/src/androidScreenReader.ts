import {invoke, isTauri} from '@tauri-apps/api/core';
import {isAndroidApp} from './isAndroidApp';
import {isIosApp} from './isIosApp';

/** Whether platform accessibility calls for the screen-reader-capable terminal. */
export async function systemScreenReader(): Promise<boolean> {
  const linuxApp = isTauri() && /Linux/i.test(navigator.userAgent);
  const macApp = isTauri() && /Macintosh/i.test(navigator.userAgent);
  if (!isAndroidApp() && !linuxApp && !isIosApp() && !macApp) return false;
  try { return await invoke<boolean>('screen_reader_active') !== false; } catch { return true; }
}

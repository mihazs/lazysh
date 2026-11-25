import {invoke, isTauri} from '@tauri-apps/api/core';
import {isAndroidApp} from './isAndroidApp';

/** Whether platform accessibility calls for the screen-reader-capable terminal. */
export async function systemScreenReader(): Promise<boolean> {
  const desktopApp = isTauri() && /Linux|Windows/i.test(navigator.userAgent);
  if (!isAndroidApp() && !desktopApp) return false;
  try { return await invoke<boolean>('screen_reader_active') !== false; } catch { return true; }
}

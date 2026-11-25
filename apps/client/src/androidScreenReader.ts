import {invoke, isTauri} from '@tauri-apps/api/core';
import {isAndroidApp} from './isAndroidApp';
import {isIosApp} from './isIosApp';

/** The native surface needs an accessible fallback when TalkBack or VoiceOver is active. */
export async function systemScreenReader(): Promise<boolean> {
  const macApp = isTauri() && /Macintosh/i.test(navigator.userAgent);
  if (!isAndroidApp() && !isIosApp() && !macApp) return false;
  try { return await invoke<boolean>('screen_reader_active') !== false; } catch { return true; }
}

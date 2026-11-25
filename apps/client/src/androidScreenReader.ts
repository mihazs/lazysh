import {invoke, isTauri} from '@tauri-apps/api/core';
import {isAndroidApp} from './isAndroidApp';

/** The native surface needs an accessible fallback when TalkBack or VoiceOver is active. */
export async function systemScreenReader(): Promise<boolean> {
  const iosApp = isTauri() && (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
  if (!isAndroidApp() && !iosApp) return false;
  try { return await invoke<boolean>('screen_reader_active') !== false; } catch { return true; }
}

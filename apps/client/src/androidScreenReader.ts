import {invoke} from '@tauri-apps/api/core';
import {isAndroidApp} from './isAndroidApp';
import {isIosApp} from './isIosApp';

/** The native surface needs an accessible fallback when TalkBack or VoiceOver is active. */
export async function systemScreenReader(): Promise<boolean> {
  if (!isAndroidApp() && !isIosApp()) return false;
  try { return await invoke<boolean>('screen_reader_active') !== false; } catch { return true; }
}

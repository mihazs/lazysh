import {invoke} from '@tauri-apps/api/core';
import {isAndroidApp} from './isAndroidApp';

/**
 * Whether Android reports a screen reader, asked of the app (`screen_reader_active`, #1329): touch exploration, which TalkBack and its
 * kin turn on, or an enabled service that speaks or brailles the screen. The native terminal draws no text a reader can reach.
 * Anywhere else it is no: iOS and the desktop have their own accessibility paths and the Screen reader announcements preference.
 * An Android app that cannot answer counts as having one, so the surface is never put in front of someone who cannot read it.
 */
export async function systemScreenReader(): Promise<boolean> {
  if (!isAndroidApp()) return false;
  try { return await invoke<boolean>('screen_reader_active') !== false; } catch { return true; }
}

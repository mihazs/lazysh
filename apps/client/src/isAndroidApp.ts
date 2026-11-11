import { isTauri } from '@tauri-apps/api/core';

/** The packaged Android app, where notification permission is the user's to grant in system settings. */
export const isAndroidApp = () => isTauri() && /Android/i.test(navigator.userAgent);

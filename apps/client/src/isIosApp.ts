import {isTauri} from '@tauri-apps/api/core';

/** WKWebView may identify an iPad as a Macintosh in desktop browsing mode. */
export const isIosApp = () => isTauri() && (/iPhone|iPad|iPod/i.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

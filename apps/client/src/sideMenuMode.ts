import {useSyncExternalStore} from 'react';

/** "Show top bar": phones in a session hide the bar for the side menu unless this device keeps it. Device-local; sync never carries it. */
export const topBarKey = 'lazysh.show-top-bar.v1';
const changed = 'lazysh-show-top-bar';
let fallback = false;

function read() {
  try { return localStorage.getItem(topBarKey) === 'true'; } catch { return fallback; }
}

export function setShowTopBar(value: boolean) {
  fallback = value;
  try { localStorage.setItem(topBarKey, String(value)); } catch { /* Storage is blocked: the choice holds until the app restarts. */ }
  window.dispatchEvent(new Event(changed));
}

function subscribe(callback: () => void) {
  window.addEventListener(changed, callback);
  window.addEventListener('storage', callback);
  return () => { window.removeEventListener(changed, callback); window.removeEventListener('storage', callback); };
}

export function useShowTopBar() { return useSyncExternalStore(subscribe, read, () => false); }

const coarse = '(pointer: coarse)';
function watchPointer(callback: () => void) {
  const media = typeof window.matchMedia === 'function' ? window.matchMedia(coarse) : undefined;
  media?.addEventListener('change', callback);
  return () => media?.removeEventListener('change', callback);
}
const hasTouchPointer = () => typeof window.matchMedia === 'function' && window.matchMedia(coarse).matches;

/** A phone is a narrow window with a touch screen: a narrowed desktop window keeps its top bar, as nothing there could swipe. */
export function useSideMenuMode(hasSession: boolean, narrow: boolean) {
  const touch = useSyncExternalStore(watchPointer, hasTouchPointer, () => false);
  const topBar = useShowTopBar();
  return hasSession && narrow && touch && !topBar;
}

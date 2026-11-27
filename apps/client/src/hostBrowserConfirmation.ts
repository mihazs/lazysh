/**
 * Hosts whose browser reach the user confirmed on this device. It lives in its own key and never in the
 * preferences, so the sync snapshot (`syncablePreferences`) cannot carry it, and it holds host ids only:
 * no address, title or frame of a page.
 */
const storageKey='lazysh.hostBrowserConfirmed.v1';
const maxHosts=64;

function read():string[] {
  try {
    const value:unknown=JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(value) ? value.filter((host):host is string=>typeof host==='string' && host.length>0 && host.length<=256).slice(-maxHosts) : [];
  } catch { return []; }
}

export function isHostBrowserConfirmed(host:string):boolean {
  return read().includes(host);
}

/** Without storage the confirmation is simply asked again, the safe direction. */
export function confirmHostBrowser(host:string) {
  try { localStorage.setItem(storageKey,JSON.stringify([...read().filter(known=>known!==host),host].slice(-maxHosts))); } catch { /* Asked again next time. */ }
}

const changed='lazysh:host-browser-switch';
/** The switch was saved: whatever offers the tool reads it again. */
export function announceHostBrowserSwitch() { window.dispatchEvent(new Event(changed)); }
export function onHostBrowserSwitch(listener:()=>void) { window.addEventListener(changed,listener);return ()=>window.removeEventListener(changed,listener); }

/**
 * What the user chose about a host's browser on this device: the hosts whose browser reach was confirmed, and the
 * hosts that keep their browser profile. Each list lives in its own key and never in the preferences, so the sync
 * snapshot (`syncablePreferences`) cannot carry it, and it holds host ids only: no address, title or frame of a
 * page. Without storage a choice is simply not remembered: the confirmation is asked again and the profile is not
 * kept, the safe direction for both.
 */
const maxHosts=64;

function hostList(storageKey:string) {
  const read=():string[]=>{
    try {
      const value:unknown=JSON.parse(localStorage.getItem(storageKey) ?? '[]');
      return Array.isArray(value) ? value.filter((host):host is string=>typeof host==='string' && host.length>0 && host.length<=256).slice(-maxHosts) : [];
    } catch { return []; }
  };
  return {
    has:(host:string)=>read().includes(host),
    set(host:string,on:boolean) {
      try { localStorage.setItem(storageKey,JSON.stringify([...read().filter(known=>known!==host),...on ? [host] : []].slice(-maxHosts))); } catch { /* Not remembered. */ }
    },
  };
}
const confirmed=hostList('lazysh.hostBrowserConfirmed.v1');
const keepsProfile=hostList('lazysh.hostBrowserKeepProfile.v1');

export const isHostBrowserConfirmed=(host:string):boolean=>confirmed.has(host);
export const confirmHostBrowser=(host:string)=>confirmed.set(host,true);
/** Keep profile: off for every host until chosen, and chosen per host. */
export const isHostBrowserKeepProfile=(host:string):boolean=>keepsProfile.has(host);
export const setHostBrowserKeepProfile=(host:string,keep:boolean)=>keepsProfile.set(host,keep);

const changed='lazysh:host-browser-switch';
/** The switch was saved: whatever offers the tool reads it again. */
export function announceHostBrowserSwitch() { window.dispatchEvent(new Event(changed)); }
export function onHostBrowserSwitch(listener:()=>void) { window.addEventListener(changed,listener);return ()=>window.removeEventListener(changed,listener); }

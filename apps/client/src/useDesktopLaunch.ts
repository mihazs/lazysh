import {useEffect, useMemo, useRef} from 'react';
import {listen} from '@tauri-apps/api/event';
import {bindProtectedInvoke, captureAccess, isAccessReady, subscribeAccess} from './access';
import {t} from './i18n/core';

type Snapshot = {directoryReceipt:string|null; notice:{receipt:string}|null};
export const WARM_UNSUPPORTED='LOCAL_LAUNCH_WARM_UNSUPPORTED';
export function localLaunchError(error:unknown):string {
  const message=error instanceof Error ? error.message : String(error);
  return message === 'LOCAL_LAUNCH_UNAVAILABLE' ? t('desktopLaunchUnavailable')
    : message === WARM_UNSUPPORTED ? t('desktopLaunchWarmUnsupported') : message;
}
function snapshot(value:unknown):Snapshot {
  const uuid=(value:unknown)=>typeof value==='string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value);
  if(!value || typeof value!=='object')throw new Error('LOCAL_LAUNCH_UNAVAILABLE');
  const state=value as Snapshot;
  if(!(state.directoryReceipt===null || uuid(state.directoryReceipt))
    || !(state.notice===null || (typeof state.notice==='object' && uuid(state.notice.receipt))))throw new Error('LOCAL_LAUNCH_UNAVAILABLE');
  return state;
}

/** A locked or replaced mount cannot start an initial intent or show old errors. */
export function useDesktopLaunch(native:boolean, available:boolean, busy:boolean,
  open:(receipt:string)=>Promise<void>, notice:(message:string)=>void) {
  const lease=useRef(captureAccess()).current;
  const invoke=useMemo(()=>bindProtectedInvoke(lease),[lease]);
  const callbacks=useRef({open,notice}); callbacks.current={open,notice};
  useEffect(()=>{
    if(!native || !available || busy)return;
    let alive=true, running=false, dirty=false, stopEvent:(()=>void)|undefined;
    const current=()=>alive && lease.current() && isAccessReady();
    const refresh=async()=>{
      if(!current())return;
      if(running){dirty=true;return;}
      running=true;
      try {
        do {
          dirty=false;
          const value=snapshot(await invoke<unknown>('desktop_launch_read'));
          if(!current())return;
          if(value.directoryReceipt) await callbacks.current.open(value.directoryReceipt);
          if(value.notice && current()) {
            callbacks.current.notice(WARM_UNSUPPORTED);
            await invoke('desktop_launch_ack',{receipt:value.notice.receipt});
          }
        } while(dirty && current());
      } catch(error) { if(current()) callbacks.current.notice(error instanceof Error ? error.message : String(error)); }
      finally { running=false; }
    };
    const stopAccess=subscribeAccess(()=>void refresh());
    void listen('lazysh-desktop-launch',()=>void refresh()).then(stop=>{if(!alive)stop();else{stopEvent=stop;void refresh();}}).catch(()=>{});
    void refresh();
    return()=>{alive=false;stopAccess();stopEvent?.();};
  },[native,available,busy,lease,invoke]);
}

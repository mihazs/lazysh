import {useEffect, useMemo, useRef} from 'react';
import {listen} from '@tauri-apps/api/event';
import {bindProtectedInvoke, captureAccess, isAccessReady, subscribeAccess} from './access';
import {captureUiError, LocalUiError, type UiErrorCause} from './i18n/localError';

type Snapshot = {directoryReceipt:string|null; notice:{receipt:string}|null};
/** Interpret native codes only at the directory-launch operation boundary. */
export function captureLaunchError(error:unknown):UiErrorCause {
  return error === 'LOCAL_LAUNCH_UNAVAILABLE' ? new LocalUiError('desktopLaunchUnavailable')
    : error === 'LOCAL_LAUNCH_DIRECTORY_UNSUPPORTED' ? new LocalUiError('desktopLaunchWindowsUnsupported') : captureUiError(error);
}
function snapshot(value:unknown):Snapshot {
  const uuid=(value:unknown)=>typeof value==='string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value);
  if(!value || typeof value!=='object')throw new LocalUiError('desktopLaunchUnavailable');
  const state=value as Snapshot;
  if(!(state.directoryReceipt===null || uuid(state.directoryReceipt))
    || !(state.notice===null || (typeof state.notice==='object' && uuid(state.notice.receipt))))throw new LocalUiError('desktopLaunchUnavailable');
  return state;
}

/** A locked or replaced mount cannot start an initial intent or show old errors. */
export function useDesktopLaunch(native:boolean, available:boolean, busy:boolean,
  open:(receipt:string)=>Promise<void>, notice:(message:UiErrorCause)=>void) {
  const lease=useRef(captureAccess()).current;
  const attempted=useRef(false);
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
          const value=snapshot(await invoke<unknown>('desktop_launch_read').catch(error=>{throw captureLaunchError(error);}));
          if(!current())return;
          if(value.directoryReceipt && !attempted.current) {
            attempted.current=true;
            await callbacks.current.open(value.directoryReceipt);
          }
          if(value.notice && current()) {
            callbacks.current.notice(new LocalUiError('desktopLaunchWarmUnsupported'));
            await invoke('desktop_launch_ack',{receipt:value.notice.receipt}).catch(error=>{throw captureLaunchError(error);});
          }
        } while(dirty && current());
      } catch(error) { if(current()) callbacks.current.notice(captureUiError(error)); }
      finally { running=false; }
    };
    const stopAccess=subscribeAccess(()=>void refresh());
    void listen('lazysh-desktop-launch',()=>void refresh()).then(stop=>{if(!alive)stop();else{stopEvent=stop;void refresh();}}).catch(()=>{});
    // A StrictMode setup cleaned up immediately must not spend native admission.
    void Promise.resolve().then(()=>refresh());
    return()=>{alive=false;stopAccess();stopEvent?.();};
  },[native,available,busy,lease,invoke]);
}

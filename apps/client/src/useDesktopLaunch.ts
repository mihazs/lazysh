import {useEffect, useMemo, useRef} from 'react';
import {listen} from '@tauri-apps/api/event';
import {bindProtectedInvoke, captureAccess, isAccessReady, subscribeAccess, type AccessLease} from './access';
import type {Host} from './bridge';
import {validTmuxServer} from './workspace';
import {captureUiError, LocalUiError, type UiErrorCause} from './i18n/localError';

type Snapshot = {directoryReceipt:string|null; hostReceipt?:string|null; notice:{receipt:string}|null};
export type DesktopMux = Readonly<{kind:'tmux';tmuxServer:string}|{kind:'herdr'}>;
export type DesktopMuxRequest = Readonly<{sessionId:string;lease:AccessLease;mux:DesktopMux}>;
export type DesktopHostLaunch = Readonly<{receipt:string;lease:AccessLease;hosts:readonly Host[];mux:DesktopMux|null}>;
/** Only a native launch await may brand these finite failures. */
export function ownedLaunchError(error:unknown):LocalUiError|undefined {
  const code=typeof error==='string' ? error : error && typeof error==='object' && 'kind' in error ? error.kind : undefined;
  const key=code === 'LOCAL_LAUNCH_UNAVAILABLE' ? 'desktopLaunchUnavailable'
    : code === 'LOCAL_LAUNCH_DIRECTORY_UNSUPPORTED' ? 'desktopLaunchWindowsUnsupported'
    : code === 'HOST_LAUNCH_MISSING' ? 'desktopLaunchHostMissing'
    : code === 'HOST_LAUNCH_AMBIGUOUS' ? 'desktopLaunchHostAmbiguous'
    : code === 'HOST_LAUNCH_CHANGED' ? 'desktopLaunchHostChanged'
    : code === 'HOST_LAUNCH_BUSY' ? 'desktopLaunchHostBusy'
    : code === 'HOST_LAUNCH_INVALID' ? 'desktopLaunchHostInvalid' : undefined;
  return key ? new LocalUiError(key) : undefined;
}
export function captureLaunchError(error:unknown):UiErrorCause {
  return ownedLaunchError(error) ?? captureUiError(error);
}
function snapshot(value:unknown):Snapshot {
  const uuid=(value:unknown)=>typeof value==='string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/.test(value);
  if(!value || typeof value!=='object')throw new LocalUiError('desktopLaunchUnavailable');
  const state=value as Snapshot;
  if(!(state.directoryReceipt===null || uuid(state.directoryReceipt))
    || !(state.hostReceipt==null || uuid(state.hostReceipt))
    || !!(state.directoryReceipt && state.hostReceipt)
    || !(state.notice===null || (typeof state.notice==='object' && uuid(state.notice.receipt))))throw new LocalUiError('desktopLaunchUnavailable');
  return state;
}

function preparedHosts(value:unknown):readonly Host[] {
  if(!value || typeof value!=='object' || !('hosts' in value) || !Array.isArray(value.hosts)
    || value.hosts.length<1 || value.hosts.length>2)throw new LocalUiError('desktopLaunchHostInvalid');
  const hosts=value.hosts as Host[];
  if(hosts.some(host=>!host || typeof host!=='object' || ['id','name','hostname','username'].some(key=>typeof host[key as keyof Host]!=='string')
    || !host.id || new TextEncoder().encode(host.id).length>100 || /[\x00-\x1f\x7f-\x9f]/.test(host.id)
    || !Number.isInteger(host.port) || host.port<1 || host.port>65535)
    || (hosts[0].jumpHostId ? hosts.length!==2 || hosts[1].id!==hosts[0].jumpHostId : hosts.length!==1))throw new LocalUiError('desktopLaunchHostInvalid');
  return Object.freeze(hosts.map(host=>Object.freeze({...host})));
}

function preparedMux(value:unknown):DesktopMux|null {
  if(value==null)return null;
  if(typeof value!=='object' || !('kind' in value))throw new LocalUiError('desktopLaunchHostInvalid');
  if(value.kind==='herdr' && Object.keys(value).length===1)return Object.freeze({kind:'herdr'});
  if(value.kind==='tmux' && 'tmuxServer' in value && validTmuxServer(value.tmuxServer) && Object.keys(value).length===2)
    return Object.freeze({kind:'tmux',tmuxServer:value.tmuxServer});
  throw new LocalUiError('desktopLaunchHostInvalid');
}

/** A locked or replaced mount cannot start an initial intent or show old errors. */
export function useDesktopLaunch(native:boolean, available:boolean, busy:boolean,
  open:(receipt:string)=>Promise<void>, notice:(message:UiErrorCause)=>void, openHost?:(launch:DesktopHostLaunch)=>Promise<void>) {
  const lease=useRef(captureAccess()).current;
  const attempted=useRef(false);
  const invoke=useMemo(()=>bindProtectedInvoke(lease),[lease]);
  const callbacks=useRef({open,notice,openHost}); callbacks.current={open,notice,openHost};
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
          if(value.hostReceipt && !attempted.current) {
            attempted.current=true;
            const prepared=await invoke<unknown>('desktop_launch_prepare_host',{receipt:value.hostReceipt}).catch(error=>{throw captureLaunchError(error);});
            const hosts=preparedHosts(prepared);
            const mux=preparedMux((prepared as {mux?:unknown}).mux);
            if(!current())return;
            if(!callbacks.current.openHost)throw new LocalUiError('desktopLaunchHostInvalid');
            await callbacks.current.openHost(Object.freeze({receipt:value.hostReceipt,lease,hosts,mux}));
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

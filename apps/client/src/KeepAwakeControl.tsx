import {invoke as cleanupInvoke, isTauri} from '@tauri-apps/api/core';
import {useEffect, useRef, useState} from 'react';
import {useAccessSnapshot, useMountedAccess, useProtectedInvoke} from './access';

export const boardAwakeKey = 'lazysh.agent-board.keep-awake.v1';
type Ticket = {epoch:string;ticket:number};
type NativeStatus = Ticket & {available:boolean;active:boolean;reason:string};
function readEnabled() { try { return localStorage.getItem(boardAwakeKey)==='true'; } catch { return false; } }
function visible() { return document.visibilityState==='visible' && document.hasFocus(); }
export function parseKeepAwakeStatus(value: unknown): NativeStatus {
  if (!value || typeof value!=='object') throw new Error('Native display status is unavailable.');
  const row=value as Record<string,unknown>;
  if (typeof row.available!=='boolean' || typeof row.active!=='boolean' || typeof row.reason!=='string' || row.reason.length>512
    || typeof row.epoch!=='string' || row.epoch.length>96 || !/^\d+\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.epoch)
    || !Number.isSafeInteger(row.ticket) || Number(row.ticket)<1)
    throw new Error('Native display status is unavailable.');
  return row as NativeStatus;
}
function message(error:unknown) {
  return error instanceof Error ? error.message : typeof error==='string' ? error : 'The native display request failed.';
}
export default function KeepAwakeControl({sessionId}:{sessionId:string}) {
  const invoke=useProtectedInvoke();
  const {access,mounted}=useMountedAccess();
  const {epoch}=useAccessSnapshot();
  const native=isTauri();
  const [enabled,setEnabled]=useState(readEnabled);
  const [foreground,setForeground]=useState(()=>({visible:visible(),revision:0}));
  const [status,setStatus]=useState<NativeStatus>();
  const [phase,setPhase]=useState<'off'|'checking'|'active'|'paused'|'held'|'error'>('off');
  const [error,setError]=useState('');
  const desired=useRef(enabled);desired.current=enabled;
  const current=useRef<Ticket|undefined>(undefined);
  const cleanupFailure=useRef('');
  useEffect(()=>{
    const changed=()=>setForeground(previous=>({visible:visible(),revision:previous.revision+1}));
    const hidden=()=>setForeground(previous=>({visible:false,revision:previous.revision+1}));
    const stored=(event:StorageEvent)=>{if(event.key===boardAwakeKey || event.key===null)setEnabled(readEnabled());};
    document.addEventListener('visibilitychange',changed);window.addEventListener('focus',changed);
    window.addEventListener('blur',hidden);window.addEventListener('pagehide',hidden);window.addEventListener('pageshow',changed);window.addEventListener('storage',stored);
    return()=>{document.removeEventListener('visibilitychange',changed);window.removeEventListener('focus',changed);
      window.removeEventListener('blur',hidden);window.removeEventListener('pagehide',hidden);window.removeEventListener('pageshow',changed);window.removeEventListener('storage',stored);};
  },[]);
  useEffect(()=>{
    let alive=true;
    let request:Ticket|undefined;
    const fresh=()=>alive && mounted.current && access.current();
    const release=(owner:Ticket)=>{
      void cleanupInvoke('board_keep_awake_release',{request:owner}).then(value=>{
        if(mounted.current && access.current() && !desired.current && (!current.current || current.current===owner)) {
          const released=parseKeepAwakeStatus(value);
          if(released.active)throw new Error('Native display release is still pending.');
          const previous=cleanupFailure.current;cleanupFailure.current='';
          setError(error=>error===previous?'':error);setPhase('off');
        }
      }).catch(failure=>{
        if(mounted.current && access.current() && (!current.current || current.current===owner)){
          cleanupFailure.current=message(failure);
          if(!desired.current){setError(cleanupFailure.current);setPhase('error');}
        }
      });
    };
    if (!native) return;
    if (!access.current()) {cleanupFailure.current='';setPhase('paused');setStatus(undefined);setError('');return;}
    if (!foreground.visible) {setPhase('paused');return;}
    setError(cleanupFailure.current);setPhase(cleanupFailure.current?'error':'checking');
    void (async()=>{
      try {
        const value=parseKeepAwakeStatus(await invoke('board_keep_awake_status'));
        if(!fresh())return;
        setStatus(value);
        if(!enabled || !value.available){
          if(cleanupFailure.current){setError(cleanupFailure.current);setPhase('error');}
          else setPhase(value.active?'held':'off');
          return;
        }
        request={epoch:value.epoch,ticket:value.ticket};current.current=request;
        const acquired=parseKeepAwakeStatus(await invoke('board_keep_awake_acquire',{request}));
        if(!fresh())return;
        if(acquired.epoch!==request.epoch || acquired.ticket!==request.ticket || !acquired.active)
          throw new Error('The native display request was not confirmed.');
        cleanupFailure.current='';setError('');setStatus(acquired);setPhase('active');
      } catch(failure) {
        if(fresh()){setError(message(failure));setPhase('error');}
        if(request)release(request);
      }
    })();
    return()=>{
      alive=false;
      if(current.current===request)current.current=undefined;
      if(request)release(request);
    };
  },[sessionId,enabled,foreground,epoch,native,invoke,access,mounted]);
  function toggle(checked:boolean) {
    try {localStorage.setItem(boardAwakeKey,String(checked));setEnabled(checked);setError(cleanupFailure.current);}
    catch {setError('Keep-awake preference could not be saved on this device.');}
  }
  return <section aria-label="Board display keep awake">
    <label><input type="checkbox" checked={enabled} disabled={!native || !access.current() || (!enabled && !status?.available)}
      onChange={event=>toggle(event.target.checked)}/>Keep display awake while this board is open</label>
    <p role="status">{!native?'Keep awake requires the native app.':phase==='active'?'Native display keep-awake is active.':
      phase==='held'?(enabled?'Native display inhibition is still reported active, but this board has no confirmed ownership.':'Native display inhibition is still reported active although the preference is off.'):
      phase==='error'?'Native display ownership could not be confirmed.':phase==='checking'?'Checking native display ownership…':phase==='paused'?'Keep awake is paused until this board is visible and focused.':
      status && !status.available?status.reason:enabled?'Native keep-awake is not active.':'Keep awake is off.'}</p>
    {status && !status.available && phase!=='off' && <p>{status.reason}</p>}
    {error && <p role="alert">{error}</p>}
    {(phase==='held' || cleanupFailure.current) && <p>Native cleanup was not confirmed. Switch away from the app to retry release, or restart lazysh if it remains active.</p>}
    <small>Opt-in display idle prevention only. Agent processes and network connections are unchanged. Keeping a display on uses more battery.</small>
  </section>;
}

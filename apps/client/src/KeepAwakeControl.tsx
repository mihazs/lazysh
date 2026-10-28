import {invoke as cleanupInvoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {useEffect, useRef, useState} from 'react';
import {useAccessSnapshot, useMountedAccess, useProtectedInvoke} from './access';

import {t, useUi} from './i18n/core';
import {LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';

export const boardAwakeKey = 'lazysh.agent-board.keep-awake.v1';
type Ticket = {epoch:string;ticket:number};
type NativeStatus = Ticket & {available:boolean;active:boolean;reason:string};
function readEnabled() { try { return localStorage.getItem(boardAwakeKey)==='true'; } catch { return false; } }
function visible() { return document.visibilityState==='visible' && document.hasFocus(); }
export function parseKeepAwakeStatus(value: unknown): NativeStatus {
  if (!value || typeof value!=='object') throw new LocalUiError('keepAwakeInvalidStatus');
  const row=value as Record<string,unknown>;
  if (typeof row.available!=='boolean' || typeof row.active!=='boolean' || typeof row.reason!=='string' || row.reason.length>512
    || typeof row.epoch!=='string' || row.epoch.length>96 || !/^\d+\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.epoch)
    || !Number.isSafeInteger(row.ticket) || Number(row.ticket)<1)
    throw new LocalUiError('keepAwakeInvalidStatus');
  return row as NativeStatus;
}
function message(error:unknown) {
  return error instanceof LocalUiError ? error : error instanceof Error ? error.message : typeof error==='string' ? error : new LocalUiError('keepAwakeRequestFailed');
}
export default function KeepAwakeControl({sessionId}:{sessionId:string}) {
  useUi();
  const invoke=useProtectedInvoke();
  const {access,mounted}=useMountedAccess();
  const {epoch}=useAccessSnapshot();
  const native=isTauri();
  const [enabled,setEnabled]=useState(readEnabled);
  const [foreground,setForeground]=useState(()=>({visible:visible(),revision:0}));
  const [status,setStatus]=useState<NativeStatus>();
  const [phase,setPhase]=useState<'off'|'checking'|'active'|'paused'|'held'|'error'>('off');
  const [error,setError]=useState<UiErrorCause>('');
  const [preferenceError,setPreferenceError]=useState<UiErrorCause>('');
  const desired=useRef(enabled);desired.current=enabled;
  const current=useRef<Ticket|undefined>(undefined);
  const cleanupFailure=useRef<UiErrorCause>('');
  const requireOptIn=useRef(false);
  useEffect(()=>{
    let alive=true;
    let unlisten:(()=>void)|undefined;
    const changed=()=>setForeground(previous=>({visible:visible(),revision:previous.revision+1}));
    const hidden=()=>setForeground(previous=>({visible:false,revision:previous.revision+1}));
    const stored=(event:StorageEvent)=>{if(event.key===boardAwakeKey || event.key===null)setEnabled(readEnabled());};
    document.addEventListener('visibilitychange',changed);window.addEventListener('focus',changed);
    window.addEventListener('blur',hidden);window.addEventListener('pagehide',hidden);window.addEventListener('pageshow',changed);window.addEventListener('storage',stored);
    // Native window focus may settle after the DOM's resume/focus observation.
    // It only refreshes metadata; the original lease, visible board and acquire latch still gate ownership.
    if(native)void listen('tauri://focus',()=>{
      if(alive && mounted.current && access.current())changed();
    },{target:{kind:'Window',label:'main'}}).then(stop=>{if(alive)unlisten=stop;else stop();}).catch(()=>{/* Existing DOM lifecycle observation remains available. */});
    return()=>{alive=false;unlisten?.();document.removeEventListener('visibilitychange',changed);window.removeEventListener('focus',changed);
      window.removeEventListener('blur',hidden);window.removeEventListener('pagehide',hidden);window.removeEventListener('pageshow',changed);window.removeEventListener('storage',stored);};
  },[native,access,mounted]);
  useEffect(()=>{
    let alive=true;
    let request:Ticket|undefined;
    let lost=false;
    let unlisten:(()=>void)|undefined;
    const fresh=()=>alive && mounted.current && access.current();
    const release=(owner:Ticket)=>{
      void cleanupInvoke('board_keep_awake_release',{request:owner}).then(value=>{
        if(mounted.current && access.current() && (!current.current || current.current===owner)) {
          const released=parseKeepAwakeStatus(value);
          if(released.active)throw new LocalUiError('keepAwakeReleasePending');
          const previous=cleanupFailure.current;cleanupFailure.current='';
          setError(error=>error===previous?'':error);if(!desired.current)setPhase('off');
        }
      }).catch(failure=>{
        if(mounted.current && access.current() && (!current.current || current.current===owner)){
          cleanupFailure.current=message(failure);
          setError(cleanupFailure.current);setPhase('error');
        }
      });
    };
    if (!native) return;
    if (!access.current()) {cleanupFailure.current='';setPhase('paused');setStatus(undefined);setError('');return;}
    if (requireOptIn.current && enabled) {setPhase('error');return;}
    if (!foreground.visible) {setPhase(cleanupFailure.current?'error':'paused');return;}
    setError(cleanupFailure.current);setPhase(cleanupFailure.current?'error':'checking');
    void (async()=>{
      try {
        const stop=await listen<unknown>('lazysh-board-keep-awake-lost',event=>{
          if(!fresh() || !request || current.current!==request)return;
          try {
            const ended=parseKeepAwakeStatus(event.payload);
            if(ended.epoch!==request.epoch || ended.ticket!==request.ticket || ended.active)return;
            lost=true;requireOptIn.current=true;setStatus(ended);setError(ended.reason);setPhase('error');release(request);
          } catch { /* Unrelated or malformed events cannot change ownership. */ }
        });
        if(!fresh()){stop();return;}unlisten=stop;
        const value=parseKeepAwakeStatus(await invoke('board_keep_awake_status'));
        if(!fresh() || lost)return;
        setStatus(value);
        if(!enabled || !value.available){
          if(cleanupFailure.current){setError(cleanupFailure.current);setPhase('error');}
          else setPhase(value.active?'held':'off');
          return;
        }
        request={epoch:value.epoch,ticket:value.ticket};current.current=request;
        const acquired=parseKeepAwakeStatus(await invoke('board_keep_awake_acquire',{request}));
        if(lost){release(request);return;}
        if(!fresh())return;
        if(acquired.epoch!==request.epoch || acquired.ticket!==request.ticket || !acquired.active)
          throw new LocalUiError('keepAwakeUnconfirmed');
        cleanupFailure.current='';setError('');setStatus(acquired);setPhase('active');
      } catch(failure) {
        if(fresh() && !lost){if(request)requireOptIn.current=true;setError(message(failure));setPhase('error');}
        if(request)release(request);
      }
    })();
    return()=>{
      alive=false;
      unlisten?.();
      if(current.current===request)current.current=undefined;
      if(request)release(request);
    };
  },[sessionId,enabled,foreground,epoch,native,invoke,access,mounted]);
  function toggle(checked:boolean) {
    requireOptIn.current=false;
    desired.current=checked;setEnabled(checked);setError(cleanupFailure.current);
    try {localStorage.setItem(boardAwakeKey,String(checked));setPreferenceError('');}
    catch {setPreferenceError(new LocalUiError('keepAwakeSaveFailed'));}
  }
  return <section className="keep-awake-control" aria-label={t('keepAwakeRegion')}>
    <label><input type="checkbox" checked={enabled} disabled={!native || !access.current() || (!enabled && !status?.available)}
      onChange={event=>toggle(event.target.checked)}/>{t('keepAwakeLabel')}</label>
    <p role="status">{!native?t('keepAwakeNative'):phase==='active'?t('keepAwakeActive'):
      phase==='held'?(enabled?t('keepAwakeHeldOn'):t('keepAwakeHeldOff')):
      phase==='error'?t('keepAwakeOwnership'):phase==='checking'?t('keepAwakeChecking'):phase==='paused'?t('keepAwakePaused'):
      status && !status.available?status.reason:enabled?t('keepAwakeInactive'):t('keepAwakeOff')}</p>
    {status && !status.available && phase!=='off' && <p>{status.reason}</p>}
    {(error || preferenceError) && <p role="alert">{[error,preferenceError].filter(Boolean).map(uiErrorText).join(' ')}</p>}
    {(phase==='held' || cleanupFailure.current) && <p>{t('keepAwakeCleanup')}</p>}
    {requireOptIn.current && <p>{t('keepAwakeOptIn')}</p>}
    <small>{t('keepAwakeLimits')}</small>
  </section>;
}

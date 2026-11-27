import {useEffect,useId,useRef,useState} from 'react';
import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {useProtectedInvoke} from './access';
import {useHostSwitchStatus} from './hostSwitchStatus';
import {announceHostBrowserSwitch,confirmHostBrowser,isHostBrowserConfirmed} from './hostBrowserConfirmation';

type HostBrowser={schemaVersion:1;revision:number;hostBrowserEnabled:boolean};
export function parseHostBrowserSettings(value:unknown):HostBrowser {
  const settings=value as HostBrowser|null;
  if(!settings || typeof settings!=='object' || Array.isArray(settings) || Object.keys(settings).some(key=>!['schemaVersion','revision','hostBrowserEnabled'].includes(key))
    || settings.schemaVersion!==1 || !Number.isSafeInteger(settings.revision) || settings.revision<0 || typeof settings.hostBrowserEnabled!=='boolean')throw new LocalUiError('companionUnsupported');
  return settings;
}
const outdated=(cause:UiErrorCause)=>cause instanceof LocalUiError && cause.key==='hostBrowserUnsupported';

// A save can outlive its switch instance. Keep same-device remounts from reading ahead of it.
const pendingSaves=new Map<string,Set<Promise<unknown>>>();
function trackSave(host:string,write:Promise<unknown>) {
  const pending=pendingSaves.get(host) ?? new Set<Promise<unknown>>();
  pending.add(write);pendingSaves.set(host,pending);
  const release=()=>{pending.delete(write);if(!pending.size)pendingSaves.delete(host);};
  void write.then(release,release);
}
async function waitForSaves(host:string) {
  while(pendingSaves.get(host)?.size)await Promise.allSettled([...pendingSaves.get(host)!]);
}

/**
 * The host browser switch. The companion keeps it in its own file, so it is read and written by its own
 * commands with its own revision; the three companion switches never travel in the same call.
 */
export default function HostBrowserSwitch({sessionId,hostKey,visible,reload}:{sessionId:string;hostKey:string;visible:boolean;reload:number}) {
  useUi();
  const invoke=useProtectedInvoke();
  const [settings,setSettings]=useState<HostBrowser>();
  const [draft,setDraft]=useState(false);
  const {outdatedCompanion,setOutdatedCompanion,error,setError,busy,setBusy,saved,setSaved}=useHostSwitchStatus();
  const [confirming,setConfirming]=useState(false);
  const request=useRef(0);
  const loadedFor=useRef<number|undefined>(undefined);
  const confirmation=useRef<HTMLDivElement>(null);
  const checkbox=useRef<HTMLInputElement>(null);
  const headingId=useId();
  const owns=(current:number)=>current===request.current;
  function fail(failure:unknown,wrap:boolean) {
    const cause=captureUiError(failure);
    if(outdated(cause)){setOutdatedCompanion(true);setSettings(undefined);return;}
    setError(wrap?{refresh:cause}:cause);
  }
  async function load(version:number) {
    const current=++request.current;setBusy(true);setError('');setSaved(false);setConfirming(false);setOutdatedCompanion(false);
    try {
      // A hidden save can still change the host. Read after its response to avoid racing the write.
      await waitForSaves(hostKey);
      if(!owns(current))return;
      const value=parseHostBrowserSettings(await invoke('get_host_browser_settings',{sessionId}));
      if(owns(current)){loadedFor.current=version;setSettings(value);setDraft(value.hostBrowserEnabled);}
    } catch(failure) {
      if(owns(current)){loadedFor.current=outdated(captureUiError(failure))?version:undefined;setSettings(undefined);setDraft(false);fail(failure,false);}
    } finally {if(owns(current))setBusy(false);}
  }
  useEffect(()=>{
    request.current++;setBusy(false);
    if(!visible){loadedFor.current=undefined;setSettings(undefined);setConfirming(false);}
    if(visible && loadedFor.current!==reload)void load(reload);
    return()=>{request.current++;};
  },[sessionId,visible,reload]);
  useEffect(()=>{if(confirming)confirmation.current?.focus();},[confirming]);
  useEffect(()=>{if(saved)checkbox.current?.focus();},[saved]);
  async function save() {
    if(!settings || busy)return;
    const current=++request.current;setBusy(true);setError('');setSaved(false);setConfirming(false);
    try {
      const write=invoke('update_host_browser_settings',{sessionId,settings:{expectedRevision:settings.revision,hostBrowserEnabled:draft}});
      trackSave(hostKey,write);
      const value=parseHostBrowserSettings(await write);
      if(owns(current)){setSettings(value);setDraft(value.hostBrowserEnabled);setSaved(true);if(value.hostBrowserEnabled)confirmHostBrowser(hostKey);announceHostBrowserSwitch();}
    } catch(failure) {if(owns(current))fail(failure,true);}
    finally {if(owns(current))setBusy(false);}
  }
  // Turning it off needs no confirmation; turning it on does, once per host on this device.
  function submit() {
    if(!settings || busy || draft===settings.hostBrowserEnabled)return;
    if(draft && !isHostBrowserConfirmed(hostKey))setConfirming(true);
    else void save();
  }
  return <form className="form-stack host-browser-switch" onSubmit={event=>{event.preventDefault();submit();}}><fieldset disabled={busy || !visible || !settings}>
    <legend>{t('hostBrowserLegend')}</legend>
    <label><input ref={checkbox} type="checkbox" checked={draft} onChange={event=>{setSaved(false);setConfirming(false);setDraft(event.target.checked);}}/>{t('hostBrowserSwitch')}</label>
    <p>{t('hostBrowserHint')}</p>
    {outdatedCompanion&&<p role="status">{t('hostBrowserUnsupported')}</p>}
    {error&&<p role="alert" className="inline-error">{typeof error==='object'&&'refresh' in error?t('companionRefreshWarning',{error:uiErrorText(error.refresh)}):uiErrorText(error)}</p>}
    {confirming
      ? <div ref={confirmation} role="group" tabIndex={-1} aria-labelledby={headingId} className="host-browser-confirm">
        <strong id={headingId}>{t('hostBrowserConfirmTitle')}</strong>
        <p>{t('hostBrowserConfirmIntro')}</p>
        <ul><li>{t('hostBrowserReachNetwork')}</li><li>{t('hostBrowserReachFiles')}</li><li>{t('hostBrowserReachSites')}</li></ul>
        <p>{t('hostBrowserConfirmScope')}</p>
        <div><button type="button" onClick={()=>void save()}>{t('hostBrowserConfirmAllow')}</button><button type="button" onClick={()=>{setConfirming(false);setDraft(false);checkbox.current?.focus();}}>{t('hostBrowserConfirmCancel')}</button></div>
      </div>
      : settings&&<button type="submit" disabled={draft===settings.hostBrowserEnabled}>{t('hostBrowserSave')}</button>}
    {saved&&<p role="status">{t('hostBrowserSaved')}</p>}
  </fieldset></form>;
}

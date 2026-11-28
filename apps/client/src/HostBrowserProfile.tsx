import {useEffect,useId,useRef,useState} from 'react';
import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {useProtectedInvoke} from './access';
import {isHostBrowserKeepProfile,setHostBrowserKeepProfile} from './hostBrowserConfirmation';

type Cleared={schemaVersion:1;cleared:boolean};
export function parseCleared(value:unknown):Cleared {
  const answer=value as Cleared|null;
  if(!answer || typeof answer!=='object' || Array.isArray(answer) || Object.keys(answer).some(key=>!['schemaVersion','cleared'].includes(key))
    || answer.schemaVersion!==1 || typeof answer.cleared!=='boolean')throw new LocalUiError('companionUnsupported');
  return answer;
}
type Outcome='cleared'|'nothing'|'outdated'|'inUse';
const outcomeText:Record<Outcome,'hostBrowserCleared'|'hostBrowserNothingToClear'|'hostBrowserClearUnsupported'|'hostBrowserClearInUse'>={cleared:'hostBrowserCleared',nothing:'hostBrowserNothingToClear',outdated:'hostBrowserClearUnsupported',inUse:'hostBrowserClearInUse'};

/**
 * What the host browser keeps on the host's disk. **Keep profile** is a choice of this device for this host (off
 * until chosen, never synced, and only offered while the host browser settings can be read, like the switch);
 * **Clear browser data** deletes the kept profile on the host, with the host browser
 * switch on or off, after a confirmation that names what is deleted.
 */
export default function HostBrowserProfile({sessionId,hostKey,visible,keepAvailable}:{sessionId:string;hostKey:string;visible:boolean;keepAvailable:boolean}) {
  useUi();
  const invoke=useProtectedInvoke();
  const [keep,setKeep]=useState(()=>isHostBrowserKeepProfile(hostKey));
  const [confirming,setConfirming]=useState(false);
  const [busy,setBusy]=useState(false);
  const [outcome,setOutcome]=useState<Outcome>();
  const [error,setError]=useState<UiErrorCause>('');
  const request=useRef(0);
  const confirmation=useRef<HTMLDivElement>(null);
  const opener=useRef<HTMLButtonElement>(null);
  const headingId=useId();
  useEffect(()=>{
    request.current++;setKeep(isHostBrowserKeepProfile(hostKey));setConfirming(false);setBusy(false);setOutcome(undefined);setError('');
    return()=>{request.current++;};
  },[sessionId,hostKey]);
  // The opener is where the confirmation came from: keyboard users land back on it, on cancel and with the answer.
  useEffect(()=>{
    if(!confirming)return;
    confirmation.current?.focus();
    return()=>opener.current?.focus();
  },[confirming]);
  useEffect(()=>{if(outcome || error)opener.current?.focus();},[outcome,error]);
  async function clear() {
    if(busy)return;
    const current=++request.current;setBusy(true);setConfirming(false);setOutcome(undefined);setError('');
    try {
      const {cleared}=parseCleared(await invoke('host_browser_clear_data',{sessionId}));
      if(current===request.current)setOutcome(cleared?'cleared':'nothing');
    } catch(failure) {
      if(current===request.current) {
        const cause=captureUiError(failure);
        if(cause instanceof LocalUiError && cause.key==='hostBrowserUnsupported')setOutcome('outdated');
        else if(typeof cause==='string' && cause.includes('BrowserProfileInUse'))setOutcome('inUse');
        else setError(cause);
      }
    } finally {if(current===request.current)setBusy(false);}
  }
  return <div className="form-stack host-browser-profile"><fieldset disabled={busy || !visible}>
    <legend>{t('hostBrowserProfileLegend')}</legend>
    <label><input type="checkbox" checked={keep} disabled={!keepAvailable} onChange={event=>{setHostBrowserKeepProfile(hostKey,event.target.checked);setKeep(isHostBrowserKeepProfile(hostKey));}}/>{t('hostBrowserKeepProfile')}</label>
    <p>{t('hostBrowserKeepProfileHint')}</p>
    {confirming
      ? <div ref={confirmation} role="group" tabIndex={-1} aria-labelledby={headingId} className="host-browser-confirm">
        <strong id={headingId}>{t('hostBrowserClearTitle')}</strong>
        <p>{t('hostBrowserClearWhat')}</p>
        <p>{t('hostBrowserClearScope')}</p>
        <div><button type="button" onClick={()=>void clear()}>{t('hostBrowserClearConfirm')}</button><button type="button" onClick={()=>setConfirming(false)}>{t('hostBrowserClearCancel')}</button></div>
      </div>
      : <button ref={opener} type="button" onClick={()=>{setOutcome(undefined);setError('');setConfirming(true);}}>{t('hostBrowserClear')}</button>}
    {outcome&&<p role="status">{t(outcomeText[outcome])}</p>}
    {error&&<p role="alert" className="inline-error">{uiErrorText(error)}</p>}
  </fieldset></div>;
}

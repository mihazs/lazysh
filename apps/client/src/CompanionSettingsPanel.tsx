import {t, useUi} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";
import HostBrowserSwitch from './HostBrowserSwitch';
import NotificationSwitches from './NotificationSwitches';


const policies=['install','notify','off'] as const;
type Policy=typeof policies[number];
type Settings = { schemaVersion:1; revision:number; transcriptDiscoveryEnabled:boolean; recordedUsageEnabled:boolean; deviceToolsEnabled:boolean; autoUpdate?:{revision:number;policy:Policy} };
export function parseCompanionSettings(value:unknown):Settings {
  if (!value || typeof value!=="object") throw new LocalUiError('companionUnsupported');
  const settings=value as Settings;
  const fields=["schemaVersion","revision","transcriptDiscoveryEnabled","recordedUsageEnabled","deviceToolsEnabled","autoUpdate"];
  const auto=settings.autoUpdate;
  if (Object.keys(settings).some(key=>!fields.includes(key)) || settings.schemaVersion!==1 || !Number.isSafeInteger(settings.revision) || settings.revision<0 || [settings.transcriptDiscoveryEnabled,settings.recordedUsageEnabled,settings.deviceToolsEnabled].some(value=>typeof value!=="boolean") || (auto!==undefined && (!auto || typeof auto!=="object" || Object.keys(auto).some(key=>key!=="revision"&&key!=="policy") || !Number.isSafeInteger(auto.revision) || auto.revision<0 || !policies.includes(auto.policy)))) throw new LocalUiError('companionUnsupported');
  return settings;
}
const pendingSaves=new Map<string,Promise<void>>();
const deferredErrors=new Map<string,UiErrorCause>();
const policyLabels={install:'companionAutoUpdateInstall',notify:'companionAutoUpdateNotify',off:'companionAutoUpdateOff'} as const;
const policyHints={install:'companionAutoUpdateInstallHint',notify:'companionAutoUpdateNotifyHint',off:'companionAutoUpdateOffHint'} as const;
export default function CompanionSettingsPanel({sessionId,hostKey=sessionId,visible=true}:{sessionId:string;hostKey?:string;visible?:boolean}) {
  useUi();
  const invoke = useProtectedInvoke();
  const [settings,setSettings]=useState<Settings>();
  const [draft,setDraft]=useState<Settings>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<UiErrorCause | {refresh:UiErrorCause} | {review:UiErrorCause}>('');
  const [saved,setSaved]=useState(false);
  const [reload,setReload]=useState(0);
  const request=useRef(0);
  const loadedSource=useRef<string|undefined>(undefined);
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const scope=useRef({sessionId,visible});scope.current={sessionId,visible};
  const owns=(current:number)=>current===request.current && scope.current.visible && scope.current.sessionId===sessionId;
  async function refresh() {
    if(!scope.current.visible || scope.current.sessionId!==sessionId)return;
    const current=++request.current;setBusy(true);setError("");setSaved(false);
    try { const value=parseCompanionSettings(await invoke("get_companion_settings",{sessionId})); if(owns(current)){loadedSource.current=sessionId;setSettings(value);setDraft(value);const deferred=deferredErrors.get(sessionId);if(deferred){deferredErrors.delete(sessionId);setError({review:deferred});}} }
    catch(error){if(owns(current)){loadedSource.current=undefined;setSettings(undefined);setDraft(undefined);setError(captureUiError(error));}}
    finally {if(owns(current))setBusy(false);}
  }
  useEffect(()=>{loadedSource.current=undefined;setSettings(undefined);setDraft(undefined);setError('');setSaved(false);},[sessionId]);
  useEffect(()=>{
    request.current++;setBusy(false);
    if(visible && pendingSaves.has(sessionId)){
      loadedSource.current=undefined;setSettings(undefined);setDraft(undefined);setBusy(true);
      const pending=pendingSaves.get(sessionId)!;void pending.then(()=>{if(mounted.current && scope.current.visible && scope.current.sessionId===sessionId)void refresh();});
    }
    else if(visible && loadedSource.current!==sessionId)void refresh();
    return()=>{request.current++;};
  },[sessionId,visible]);
  async function save() {
    if(!settings || !draft || busy || !scope.current.visible || scope.current.sessionId!==sessionId || loadedSource.current!==sessionId || pendingSaves.has(sessionId))return;
    let settle!:()=>void;const pending=new Promise<void>(resolve=>{settle=resolve;});pendingSaves.set(sessionId,pending);
    const current=++request.current;setBusy(true);setError("");setSaved(false);
    try {
      const value=parseCompanionSettings(await invoke("update_companion_settings",{sessionId,settings:{expectedRevision:settings.revision,transcriptDiscoveryEnabled:draft.transcriptDiscoveryEnabled,recordedUsageEnabled:draft.recordedUsageEnabled,deviceToolsEnabled:draft.deviceToolsEnabled,...(settings.autoUpdate&&draft.autoUpdate&&draft.autoUpdate.policy!==settings.autoUpdate.policy?{autoUpdate:{expectedRevision:settings.autoUpdate.revision,policy:draft.autoUpdate.policy}}:{})}}));
      if(owns(current)){setSettings(value);setDraft(value);setSaved(true);}
    } catch(error){if(owns(current)){loadedSource.current=undefined;setSettings(undefined);setDraft(undefined);setError({refresh:captureUiError(error)});}else {deferredErrors.set(sessionId,captureUiError(error));}}
    finally {
      pendingSaves.delete(sessionId);settle();
      if(owns(current))setBusy(false);
      else if(mounted.current && scope.current.sessionId===sessionId)loadedSource.current=undefined;
    }
  }
  return <section hidden={!visible} style={visible?undefined:{display:'none'}} className="tool-panel" aria-label={t('companionSettingsTitle')}>
    <div className="tool-bar"><h3>{t('companionSettingsTitle')}</h3><button disabled={busy || !visible} onClick={()=>{setReload(count=>count+1);void refresh();}}>{t('companionRefresh')}</button></div>
    <p className="agent-note">{t('companionScope')}</p>
    {busy&&<p role="status">{t('companionBusy')}</p>}
    {error&&<p role="alert" className="inline-error">{typeof error==='object'&&'refresh' in error?t('companionRefreshWarning',{error:uiErrorText(error.refresh)}):typeof error==='object'&&'review' in error?t('companionReviewWarning',{error:uiErrorText(error.review)}):uiErrorText(error)}</p>}
    {!settings&&!busy&&!error&&<p>{t('companionUnsupportedHint')}</p>}
    {draft&&loadedSource.current===sessionId&&<form className="form-stack" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy || !visible}>
      <legend>{t('companionOperations')}</legend>
      <label><input type="checkbox" checked={draft.transcriptDiscoveryEnabled} onChange={event=>{setSaved(false);setDraft({...draft,transcriptDiscoveryEnabled:event.target.checked});}}/>{t('companionTranscript')}</label>
      <p>{t('companionTranscriptHint')}</p>
      <label><input type="checkbox" checked={draft.recordedUsageEnabled} onChange={event=>{setSaved(false);setDraft({...draft,recordedUsageEnabled:event.target.checked});}}/>{t('companionUsage')}</label>
      <p>{t('companionUsageHint')}</p>
      <label><input type="checkbox" checked={draft.deviceToolsEnabled} onChange={event=>{setSaved(false);setDraft({...draft,deviceToolsEnabled:event.target.checked});}}/>{t('companionDevices')}</label>
      <p>{t('companionDevicesHint')}</p>
      {draft.autoUpdate&&<fieldset className="companion-auto-update" disabled={busy || !visible}>
        <legend>{t('companionAutoUpdate')}</legend>
        <p>{t('companionAutoUpdateHint')}</p>
        {policies.map(policy=><label key={policy}><input type="radio" name="companion-auto-update" value={policy} checked={draft.autoUpdate?.policy===policy} onChange={()=>{setSaved(false);setDraft({...draft,autoUpdate:{revision:draft.autoUpdate!.revision,policy}});}}/>{t(policyLabels[policy])}</label>)}
        <p>{t(policyHints[draft.autoUpdate.policy])}</p>
      </fieldset>}
      <button type="submit">{t('companionSave')}</button>
    </fieldset></form>}
    {saved&&<p role="status">{t('companionSaved')}</p>}
    <HostBrowserSwitch key={sessionId} sessionId={sessionId} hostKey={hostKey} visible={visible} reload={reload}/>
    {draft&&loadedSource.current===sessionId&&<NotificationSwitches key={`notifications:${sessionId}`} sessionId={sessionId} visible={visible} reload={reload}/>}
    <p className="agent-note">{t('companionIndependent')}</p>
  </section>;
}

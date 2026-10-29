import {t, useUi} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";


type Settings = { schemaVersion:1; revision:number; transcriptDiscoveryEnabled:boolean; recordedUsageEnabled:boolean; deviceToolsEnabled:boolean };
export function parseCompanionSettings(value:unknown):Settings {
  if (!value || typeof value!=="object") throw new LocalUiError('companionUnsupported');
  const settings=value as Settings;
  const fields=["schemaVersion","revision","transcriptDiscoveryEnabled","recordedUsageEnabled","deviceToolsEnabled"];
  if (Object.keys(settings).some(key=>!fields.includes(key)) || settings.schemaVersion!==1 || !Number.isSafeInteger(settings.revision) || settings.revision<0 || [settings.transcriptDiscoveryEnabled,settings.recordedUsageEnabled,settings.deviceToolsEnabled].some(value=>typeof value!=="boolean")) throw new LocalUiError('companionUnsupported');
  return settings;
}
export default function CompanionSettingsPanel({sessionId,visible=true}:{sessionId:string;visible?:boolean}) {
  useUi();
  const invoke = useProtectedInvoke();
  const [settings,setSettings]=useState<Settings>();
  const [draft,setDraft]=useState<Settings>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<UiErrorCause | {refresh:UiErrorCause}>('');
  const [saved,setSaved]=useState(false);
  const request=useRef(0);
  const loadedSource=useRef<string|undefined>(undefined);
  const scope=useRef({sessionId,visible});scope.current={sessionId,visible};
  const owns=(current:number)=>current===request.current && scope.current.visible && scope.current.sessionId===sessionId;
  async function refresh() {
    if(!scope.current.visible || scope.current.sessionId!==sessionId)return;
    const current=++request.current;setBusy(true);setError("");setSaved(false);
    try { const value=parseCompanionSettings(await invoke("get_companion_settings",{sessionId})); if(owns(current)){loadedSource.current=sessionId;setSettings(value);setDraft(value);} }
    catch(error){if(owns(current)){loadedSource.current=undefined;setSettings(undefined);setDraft(undefined);setError(captureUiError(error));}}
    finally {if(owns(current))setBusy(false);}
  }
  useEffect(()=>{loadedSource.current=undefined;setSettings(undefined);setDraft(undefined);setError('');setSaved(false);},[sessionId]);
  useEffect(()=>{
    request.current++;setBusy(false);
    if(visible && loadedSource.current!==sessionId)void refresh();
    return()=>{request.current++;};
  },[sessionId,visible]);
  async function save() {
    if(!settings || !draft || busy || !scope.current.visible || scope.current.sessionId!==sessionId || loadedSource.current!==sessionId)return;
    const current=++request.current;setBusy(true);setError("");setSaved(false);
    try {
      const value=parseCompanionSettings(await invoke("update_companion_settings",{sessionId,settings:{expectedRevision:settings.revision,transcriptDiscoveryEnabled:draft.transcriptDiscoveryEnabled,recordedUsageEnabled:draft.recordedUsageEnabled,deviceToolsEnabled:draft.deviceToolsEnabled}}));
      if(owns(current)){setSettings(value);setDraft(value);setSaved(true);}
    } catch(error){if(owns(current))setError({refresh:captureUiError(error)});}
    finally {if(owns(current))setBusy(false);}
  }
  return <section hidden={!visible} style={visible?undefined:{display:'none'}} className="tool-panel" aria-label={t('companionSettingsTitle')}>
    <div className="tool-bar"><h3>{t('companionSettingsTitle')}</h3><button disabled={busy || !visible} onClick={()=>void refresh()}>{t('companionRefresh')}</button></div>
    <p className="agent-note">{t('companionScope')}</p>
    {busy&&<p role="status">{t('companionBusy')}</p>}
    {error&&<p role="alert" className="inline-error">{typeof error==='object'&&'refresh' in error?t('companionRefreshWarning',{error:uiErrorText(error.refresh)}):uiErrorText(error)}</p>}
    {!settings&&!busy&&<p>{t('companionUnsupportedHint')}</p>}
    {draft&&loadedSource.current===sessionId&&<form className="form-stack" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy || !visible}>
      <legend>{t('companionOperations')}</legend>
      <label><input type="checkbox" checked={draft.transcriptDiscoveryEnabled} onChange={event=>{setSaved(false);setDraft({...draft,transcriptDiscoveryEnabled:event.target.checked});}}/>{t('companionTranscript')}</label>
      <p>{t('companionTranscriptHint')}</p>
      <label><input type="checkbox" checked={draft.recordedUsageEnabled} onChange={event=>{setSaved(false);setDraft({...draft,recordedUsageEnabled:event.target.checked});}}/>{t('companionUsage')}</label>
      <p>{t('companionUsageHint')}</p>
      <label><input type="checkbox" checked={draft.deviceToolsEnabled} onChange={event=>{setSaved(false);setDraft({...draft,deviceToolsEnabled:event.target.checked});}}/>{t('companionDevices')}</label>
      <p>{t('companionDevicesHint')}</p>
      <button type="submit">{t('companionSave')}</button>
    </fieldset></form>}
    {saved&&<p role="status">{t('companionSaved')}</p>}
    <p className="agent-note">{t('companionIndependent')}</p>
  </section>;
}

import {t, useUi} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";


const policies=['install','notify','off'] as const;
type Policy=typeof policies[number];
const channels=['stable','prerelease'] as const;
type Channel=typeof channels[number];
/** What the last scheduled check on the host found. */
type LastCheck={at:string;latest:string|null;available:boolean};
/** `channel`, `intervalHours` and `window` come from a companion that has scheduled checks; an older one has only the policy. */
/** What the host's own timer for the check is, read from the system by the companion. */
type Timer={supported:boolean;installed:boolean;enabled:boolean;drift:boolean};
type AutoUpdate={revision:number;policy:Policy;channel?:Channel;intervalHours?:number;window?:string|null;lastCheck?:LastCheck;timer?:Timer};
type Settings = { schemaVersion:1; revision:number; transcriptDiscoveryEnabled:boolean; recordedUsageEnabled:boolean; deviceToolsEnabled:boolean; autoUpdate?:AutoUpdate };
const autoUpdateFields=["revision","policy","channel","intervalHours","window","lastCheck","timer"];
const timerFields=["supported","installed","enabled","drift"];
const windowShape=/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const plainText=/^[A-Za-z0-9.:+-]{1,40}$/;
function validWindow(window:string):boolean{return windowShape.test(window)&&window.slice(0,5)!==window.slice(6);}
function validLastCheck(check:unknown):check is LastCheck{
  if(!check||typeof check!=="object")return false;
  const {at,latest,available}=check as LastCheck;
  return typeof at==="string"&&plainText.test(at)&&typeof available==="boolean"&&(latest===null||(typeof latest==="string"&&plainText.test(latest)));
}
function validTimer(timer:unknown):timer is Timer{
  if(!timer||typeof timer!=="object")return false;
  const value=timer as Record<string,unknown>;
  return Object.keys(value).length===timerFields.length&&timerFields.every(key=>typeof value[key]==="boolean");
}
function validAutoUpdate(auto:unknown):auto is AutoUpdate{
  if(!auto||typeof auto!=="object")return false;
  const value=auto as AutoUpdate;
  return !Object.keys(value).some(key=>!autoUpdateFields.includes(key)) && Number.isSafeInteger(value.revision) && value.revision>=0 && policies.includes(value.policy)
    && (value.channel===undefined||channels.includes(value.channel))
    && (value.intervalHours===undefined||(Number.isInteger(value.intervalHours)&&value.intervalHours>=1&&value.intervalHours<=720))
    && (value.window===undefined||value.window===null||(typeof value.window==="string"&&validWindow(value.window)))
    && (value.lastCheck===undefined||validLastCheck(value.lastCheck))
    && (value.timer===undefined||validTimer(value.timer));
}
export function parseCompanionSettings(value:unknown):Settings {
  if (!value || typeof value!=="object") throw new LocalUiError('companionUnsupported');
  const settings=value as Settings;
  const fields=["schemaVersion","revision","transcriptDiscoveryEnabled","recordedUsageEnabled","deviceToolsEnabled","autoUpdate"];
  const auto=settings.autoUpdate;
  if (Object.keys(settings).some(key=>!fields.includes(key)) || settings.schemaVersion!==1 || !Number.isSafeInteger(settings.revision) || settings.revision<0 || [settings.transcriptDiscoveryEnabled,settings.recordedUsageEnabled,settings.deviceToolsEnabled].some(value=>typeof value!=="boolean") || (auto!==undefined && !validAutoUpdate(auto))) throw new LocalUiError('companionUnsupported');
  return settings;
}
const defaultWindow='02:00-05:00';
/** The `auto-update set` the draft asks for, or nothing when it equals what the host has. A host with scheduled checks is always sent the whole schedule: `set` keeps no setting it is not told. */
function autoUpdateChange(saved?:AutoUpdate,draft?:AutoUpdate){
  if(!saved||!draft)return {};
  const same=saved.policy===draft.policy&&saved.channel===draft.channel&&saved.intervalHours===draft.intervalHours&&(saved.window??null)===(draft.window??null)&&saved.timer?.enabled===draft.timer?.enabled;
  if(same)return {};
  const schedule=draft.channel===undefined?{}:{schedule:{channel:draft.channel,intervalHours:draft.intervalHours??24,window:draft.window??null}};
  const timer=draft.timer&&draft.timer.enabled!==saved.timer?.enabled?{timer:draft.timer.enabled}:{};
  return {autoUpdate:{expectedRevision:saved.revision,policy:draft.policy,...schedule,...timer}};
}
const scheduleInvalid=(auto?:AutoUpdate)=>!!auto&&auto.channel!==undefined&&(!Number.isInteger(auto.intervalHours)||auto.intervalHours!<1||auto.intervalHours!>720||(typeof auto.window==="string"&&!validWindow(auto.window)));
const policyLabels={install:'companionAutoUpdateInstall',notify:'companionAutoUpdateNotify',off:'companionAutoUpdateOff'} as const;
const policyHints={install:'companionAutoUpdateInstallHint',notify:'companionAutoUpdateNotifyHint',off:'companionAutoUpdateOffHint'} as const;
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
      const value=parseCompanionSettings(await invoke("update_companion_settings",{sessionId,settings:{expectedRevision:settings.revision,transcriptDiscoveryEnabled:draft.transcriptDiscoveryEnabled,recordedUsageEnabled:draft.recordedUsageEnabled,deviceToolsEnabled:draft.deviceToolsEnabled,...autoUpdateChange(settings.autoUpdate,draft.autoUpdate)}}));
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
      {draft.autoUpdate&&<fieldset className="companion-auto-update" disabled={busy || !visible}>
        <legend>{t('companionAutoUpdate')}</legend>
        <p>{t('companionAutoUpdateHint')}</p>
        {policies.map(policy=><label key={policy}><input type="radio" name="companion-auto-update" value={policy} checked={draft.autoUpdate?.policy===policy} onChange={()=>{setSaved(false);setDraft({...draft,autoUpdate:{...draft.autoUpdate!,policy}});}}/>{t(policyLabels[policy])}</label>)}
        <p>{t(policyHints[draft.autoUpdate.policy])}</p>
        {draft.autoUpdate.channel!==undefined&&<CompanionUpdateSchedule auto={draft.autoUpdate} onChange={next=>{setSaved(false);setDraft({...draft,autoUpdate:next});}}/>}
      </fieldset>}
      <button type="submit" disabled={scheduleInvalid(draft.autoUpdate)}>{t('companionSave')}</button>
    </fieldset></form>}
    {saved&&<p role="status">{t('companionSaved')}</p>}
    <p className="agent-note">{t('companionIndependent')}</p>
  </section>;
}

/** Which releases, how often and when: shown only for a companion that has scheduled checks, with what its last check found. */
function CompanionUpdateSchedule({auto,onChange}:{auto:AutoUpdate;onChange:(next:AutoUpdate)=>void}) {
  const off=auto.policy==='off';
  const [from,until]=(auto.window??defaultWindow).split('-');
  const check=auto.lastCheck;
  return <>
    {check?.available&&check.latest?<p role="status" className="companion-update-badge" data-update-available={check.latest}>{t('companionAutoUpdateAvailable',{version:check.latest})}</p>
      :<p className="agent-note">{check?t('companionAutoUpdateCurrent',{at:new Date(check.at).toLocaleString()}):t('companionAutoUpdateNeverChecked')}</p>}
    <label>{t('companionAutoUpdateChannel')}
      <select value={auto.channel} disabled={off} onChange={event=>onChange({...auto,channel:event.target.value as Channel})}>
        <option value="stable">{t('companionAutoUpdateChannelStable')}</option>
        <option value="prerelease">{t('companionAutoUpdateChannelPrerelease')}</option>
      </select>
    </label>
    <label>{t('companionAutoUpdateInterval')}
      <input type="number" min={1} max={720} step={1} value={Number.isNaN(auto.intervalHours)?'':auto.intervalHours??24} disabled={off} aria-invalid={scheduleInvalid(auto)||undefined} onChange={event=>onChange({...auto,intervalHours:event.target.valueAsNumber})}/>
    </label>
    <label><input type="checkbox" checked={typeof auto.window==='string'} disabled={off} onChange={event=>onChange({...auto,window:event.target.checked?defaultWindow:null})}/>{t('companionAutoUpdateWindow')}</label>
    {typeof auto.window==='string'&&<>
      <label>{t('companionAutoUpdateWindowFrom')}<input type="time" value={from} disabled={off} onChange={event=>onChange({...auto,window:`${event.target.value}-${until}`})}/></label>
      <label>{t('companionAutoUpdateWindowUntil')}<input type="time" value={until} disabled={off} onChange={event=>onChange({...auto,window:`${from}-${event.target.value}`})}/></label>
      <p>{t('companionAutoUpdateWindowHint')}</p>
    </>}
    {auto.timer?.supported&&<>
      <label><input type="checkbox" checked={auto.timer.enabled} disabled={off&&!auto.timer.enabled} onChange={event=>onChange({...auto,timer:{...auto.timer!,enabled:event.target.checked}})}/>{t('companionAutoUpdateTimer')}</label>
      <p>{t(auto.timer.drift?'companionAutoUpdateTimerDrift':'companionAutoUpdateTimerHint')}</p>
    </>}
  </>;
}

import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "./SessionTools";

type Settings = { schemaVersion:1; revision:number; transcriptDiscoveryEnabled:boolean; recordedUsageEnabled:boolean; deviceToolsEnabled:boolean };
export function parseCompanionSettings(value:unknown):Settings {
  if (!value || typeof value!=="object") throw new Error("Unsupported companion settings. Update the host companion.");
  const settings=value as Settings;
  const fields=["schemaVersion","revision","transcriptDiscoveryEnabled","recordedUsageEnabled","deviceToolsEnabled"];
  if (Object.keys(settings).some(key=>!fields.includes(key)) || settings.schemaVersion!==1 || !Number.isSafeInteger(settings.revision) || settings.revision<0 || [settings.transcriptDiscoveryEnabled,settings.recordedUsageEnabled,settings.deviceToolsEnabled].some(value=>typeof value!=="boolean")) throw new Error("Unsupported companion settings. Update the host companion.");
  return settings;
}
export default function CompanionSettingsPanel({sessionId}:{sessionId:string}) {
  const invoke = useProtectedInvoke();
  const [settings,setSettings]=useState<Settings>();
  const [draft,setDraft]=useState<Settings>();
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [saved,setSaved]=useState(false);
  const request=useRef(0);
  async function refresh() {
    const current=++request.current;setBusy(true);setError("");setSaved(false);
    try { const value=parseCompanionSettings(await invoke("get_companion_settings",{sessionId})); if(current===request.current){setSettings(value);setDraft(value);} }
    catch(error){if(current===request.current){setSettings(undefined);setDraft(undefined);setError(errorMessage(error));}}
    finally {if(current===request.current)setBusy(false);}
  }
  useEffect(()=>{setSettings(undefined);setDraft(undefined);void refresh();return()=>{request.current++;};},[sessionId]);
  async function save() {
    if(!settings || !draft || busy)return;
    const current=++request.current;setBusy(true);setError("");setSaved(false);
    try {
      const value=parseCompanionSettings(await invoke("update_companion_settings",{sessionId,settings:{expectedRevision:settings.revision,transcriptDiscoveryEnabled:draft.transcriptDiscoveryEnabled,recordedUsageEnabled:draft.recordedUsageEnabled,deviceToolsEnabled:draft.deviceToolsEnabled}}));
      if(current===request.current){setSettings(value);setDraft(value);setSaved(true);}
    } catch(error){if(current===request.current)setError(`${errorMessage(error)} Refresh host settings before retrying; another client may have changed them.`);}
    finally {if(current===request.current)setBusy(false);}
  }
  return <section className="tool-panel" aria-label="Host companion settings">
    <div className="tool-bar"><h3>Host companion settings</h3><button disabled={busy} onClick={()=>void refresh()}>Refresh host settings</button></div>
    <p className="agent-note">Saved on this host for this operating-system user. Changes apply to new companion operations. Existing previews and streams continue until stopped.</p>
    {busy&&<p role="status">Reading or saving host settings…</p>}
    {error&&<p role="alert" className="inline-error">{error}</p>}
    {!settings&&!busy&&<p>Host settings require a companion version with settings support.</p>}
    {draft&&<form className="form-stack" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy}>
      <legend>Companion operations</legend>
      <label><input type="checkbox" checked={draft.transcriptDiscoveryEnabled} onChange={event=>{setSaved(false);setDraft({...draft,transcriptDiscoveryEnabled:event.target.checked});}}/>Transcript discovery</label>
      <p>Allow listing known local transcript metadata. Reading an explicitly selected transcript remains available.</p>
      <label><input type="checkbox" checked={draft.recordedUsageEnabled} onChange={event=>{setSaved(false);setDraft({...draft,recordedUsageEnabled:event.target.checked});}}/>Recorded usage inspection</label>
      <p>Allow the usage command to inspect selected transcript counters and recorded provider windows. This does not enable background collection.</p>
      <label><input type="checkbox" checked={draft.deviceToolsEnabled} onChange={event=>{setSaved(false);setDraft({...draft,deviceToolsEnabled:event.target.checked});}}/>Device tools</label>
      <p>Allow new device inventory, capture, preview streams and control operations.</p>
      <button type="submit">Save host settings</button>
    </fieldset></form>}
    {saved&&<p role="status">Host settings saved for new operations.</p>}
    <p className="agent-note">Port discovery is a separate SSH feature and is not changed here. Agent approvals and lifecycle reporting are unchanged.</p>
  </section>;
}

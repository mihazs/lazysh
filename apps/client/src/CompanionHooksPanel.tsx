import {useMountedAccess,useProtectedApi} from './access';
import {api as nativeApi} from './bridge';
import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {useEffect,useRef,useState} from 'react';
type Agent='claude'|'codex'|'opencode';
type Status={supported:boolean;state:null|'prepared'|'configured'|'removed'|'conflict';installPlan?:string;removePlan?:string};
export function parseHookStatus(value:unknown):Status {
  if(!value || typeof value!=='object')throw new LocalUiError('hooksInvalid');
  const v=value as Record<string,unknown>;
  if(v.schemaVersion!==1 || typeof v.supported!=='boolean' || v.reporting!=='notChecked' || v.trust!=='notChecked')throw new LocalUiError('hooksInvalid');
  if(!v.supported){if(v.reason!=='HooksAclUnsupported')throw new LocalUiError('hooksInvalid');return {supported:false,state:null};}
  if(![null,'prepared','configured','removed','conflict'].includes(v.state as null))throw new LocalUiError('hooksInvalid');
  if(v.state==='conflict')return {supported:true,state:'conflict'};
  if(![v.installPlan,v.removePlan].every(plan=>typeof plan==='string' && /^[a-f0-9]{64}$/.test(plan)))throw new LocalUiError('hooksInvalid');
  return {supported:true,state:v.state as Status['state'],installPlan:v.installPlan as string,removePlan:v.removePlan as string};
}
export default function CompanionHooksPanel({sessionId,visible}:{sessionId:string;visible:boolean}) {
  useUi();const api=useProtectedApi(nativeApi),{access,mounted}=useMountedAccess();
  const [agent,setAgent]=useState<Agent>('codex'),[profile,setProfile]=useState(''),[status,setStatus]=useState<Status>(),[busy,setBusy]=useState(false),[error,setError]=useState<UiErrorCause>(''),[uncertain,setUncertain]=useState(false);
  const revision=useRef(0),flight=useRef<number|null>(null);
  const selection=useRef({sessionId,visible,agent,profile});selection.current={sessionId,visible,agent,profile};
  useEffect(()=>{revision.current++;flight.current=null;setBusy(false);setStatus(undefined);setError('');setUncertain(false);},[sessionId,visible,agent,profile]);
  async function run(action:'status'|'install'|'remove') {
    if(flight.current!==null || !visible || !access.current())return;
    const expectedPlan=action==='install'?status?.installPlan:status?.removePlan;
    if(action!=='status' && !expectedPlan)return;
    const id=++revision.current;flight.current=id;setBusy(true);setError('');setUncertain(false);
    const owns=()=>mounted.current && access.current() && revision.current===id && selection.current.visible && selection.current.sessionId===sessionId && selection.current.agent===agent && selection.current.profile===profile;
    try {
      const response=await api.companionHooks(sessionId,{agent,action,profileRoot:profile,...(action==='status'?{}:{expectedPlan})});
      if(!owns())return;
      if(action==='status')setStatus(parseHookStatus(response));
      else {
        setStatus(undefined);
        const value=response as {schemaVersion?:unknown;outcome?:{status?:unknown};reporting?:unknown;trust?:unknown};
        if(value?.schemaVersion!==1 || value.reporting!=='notChecked' || value.trust!=='notChecked' || !['configured','reused','removed','absent','uncertain'].includes(value.outcome?.status as string))throw new LocalUiError('hooksInvalid');
        if(value.outcome?.status==='uncertain')setUncertain(true);
        else {const refreshed=await api.companionHooks(sessionId,{agent,action:'status',profileRoot:profile});if(owns())setStatus(parseHookStatus(refreshed));}
      }
    } catch(error){if(owns()){setStatus(undefined);setError(captureUiError(error));}}
    finally {if(owns())setBusy(false);if(flight.current===id)flight.current=null;}
  }
  return <details className="companion-install" hidden={!visible} aria-label={t('hooksTitle')}>
    <summary>{t('hooksTitle')}</summary>
    <div className="tool-bar">
      <label>{t('hooksProvider')}<select value={agent} disabled={busy} onChange={e=>setAgent(e.target.value as Agent)}><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="opencode">OpenCode</option></select></label>
      <label>{t('hooksProfile')}<input value={profile} disabled={busy} autoCapitalize="none" autoCorrect="off" placeholder={agent==='codex'?'/home/user/.codex':agent==='claude'?'/home/user/.claude':'/home/user/.config/opencode'} onChange={e=>setProfile(e.target.value)}/></label>
      <button className="subtle-button" disabled={busy || !profile.startsWith('/')} onClick={()=>void run('status')}>{t('hooksInspect')}</button>
    </div>
    {status && <p className="agent-note" role="status">{t(!status.supported?'hooksUnsupported':status.state==='conflict'?'hooksConflict':status.state==='configured'?'hooksConfigured':'hooksNotConfigured')}</p>}
    {status?.supported && status.state!=='conflict' && <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={()=>void run('install')}>{t('hooksInstall')}</button><button className="subtle-button" disabled={busy} onClick={()=>void run('remove')}>{t('hooksRemove')}</button></div>}
    {uncertain && <p className="agent-note" role="alert">{t('hooksUncertain')}</p>}
    {error && <p className="agent-note inline-error" role="alert">{uiErrorText(error)}</p>}
    <p className="agent-note">{t('hooksTrust')}</p>
  </details>;
}

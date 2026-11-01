import {useMountedAccess,useProtectedApi} from './access';
import {api as nativeApi} from './bridge';
import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {useEffect,useRef,useState} from 'react';
type Agent='claude'|'codex'|'droid'|'gemini'|'cursor'|'opencode'|'cline'|'copilot';
const providers={claude:'Claude Code',codex:'Codex',droid:'Droid',gemini:'Gemini CLI',cursor:'Cursor CLI',opencode:'OpenCode',cline:'Cline',kimi:'Kimi',copilot:'GitHub Copilot',amp:'Amp',aider:'Aider'} as const;
type DetectedAgent=keyof typeof providers;
type Profile={path:string|null;source:string;state:'directory'|'missing'|'unavailable'|'invalid'};
type Discovery={schemaVersion:1|2;supported:boolean;managedSetupSupported:boolean;agents:{agent:DetectedAgent;setup:'managed'|'manual'|'healthOnly';executable:{path:string;source:'path'|'codexStandalone'}|null;profiles:Profile[]}[];truncated:boolean};
const managed=new Set<string>(['claude','codex','droid','gemini','cursor','opencode','cline']);
function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new LocalUiError('hooksInvalid');return value as Record<string,unknown>;}
function closed(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).some(key=>!keys.includes(key)))throw new LocalUiError('hooksInvalid');}
function boundedText(value:unknown,maximum=4096):value is string{return typeof value==='string'&&value.length>0&&value.length<=maximum&&!/[\x00-\x1f\x7f]/.test(value);}
function absoluteProfile(value:string){return boundedText(value)&&value.startsWith('/')&&!value.split('/').some(part=>part==='.'||part==='..');}
export function parseHookDiscovery(value:unknown,expectedVersion:1|2=1):Discovery {
  const v=object(value);closed(v,['schemaVersion','supported','managedSetupSupported','agents','truncated']);
  if(v.schemaVersion!==expectedVersion||typeof v.supported!=='boolean'||typeof v.managedSetupSupported!=='boolean'||typeof v.truncated!=='boolean'||!Array.isArray(v.agents)||v.agents.length>11||(!v.supported&&(v.managedSetupSupported||v.agents.length)))throw new LocalUiError('hooksInvalid');
  const seen=new Set<string>();
  const agents=v.agents.map(raw=>{
    const a=object(raw),id=a.agent;closed(a,['agent','setup','executable','profiles']);
    if(typeof id!=='string'||!Object.hasOwn(providers,id)||seen.has(id)||a.setup!==((managed.has(id)||(expectedVersion===2&&id==='copilot'))?'managed':id==='aider'?'healthOnly':'manual')||!Array.isArray(a.profiles)||a.profiles.length>8)throw new LocalUiError('hooksInvalid');
    seen.add(id);
    let executable:Discovery['agents'][number]['executable']=null;
    if(a.executable!==null){const e=object(a.executable);closed(e,['path','source']);if(!boundedText(e.path)||!absoluteProfile(e.path)||!['path','codexStandalone'].includes(e.source as string)||(e.source==='codexStandalone'&&id!=='codex'))throw new LocalUiError('hooksInvalid');executable={path:e.path,source:e.source as 'path'|'codexStandalone'};}
    const paths=new Set<string>();
    const profiles=a.profiles.map(rawProfile=>{const p=object(rawProfile);closed(p,['path','source','state']);if(!['directory','missing','unavailable','invalid'].includes(p.state as string)||!boundedText(p.source,64)||(p.path!==null&&!boundedText(p.path))||((p.state==='directory'||p.state==='missing')&&(typeof p.path!=='string'||!absoluteProfile(p.path))))throw new LocalUiError('hooksInvalid');const key=JSON.stringify([p.path,p.source]);if(paths.has(key))throw new LocalUiError('hooksInvalid');paths.add(key);return {path:p.path,source:p.source,state:p.state} as Profile;});
    return {agent:id as DetectedAgent,setup:a.setup as Discovery['agents'][number]['setup'],executable,profiles};
  });
  const result:Discovery={schemaVersion:expectedVersion,supported:v.supported,managedSetupSupported:v.managedSetupSupported,agents,truncated:v.truncated};
  if(new TextEncoder().encode(JSON.stringify(result)).length>65536)throw new LocalUiError('hooksInvalid');
  return result;
}
type Status={supported:boolean;reason?:'HooksAclUnsupported'|'HooksDroidStandaloneRequired';state:null|'prepared'|'configured'|'removed'|'conflict';installPlan?:string;removePlan?:string};
export function parseHookStatus(value:unknown):Status {
  if(!value || typeof value!=='object')throw new LocalUiError('hooksInvalid');
  const v=value as Record<string,unknown>;
  if(v.schemaVersion!==1 || typeof v.supported!=='boolean' || v.reporting!=='notChecked' || v.trust!=='notChecked')throw new LocalUiError('hooksInvalid');
  if(!v.supported){if(v.reason!=='HooksAclUnsupported' && v.reason!=='HooksDroidStandaloneRequired')throw new LocalUiError('hooksInvalid');return {supported:false,state:null,reason:v.reason};}
  if(![null,'prepared','configured','removed','conflict'].includes(v.state as null))throw new LocalUiError('hooksInvalid');
  if(v.state==='conflict')return {supported:true,state:'conflict'};
  if(![v.installPlan,v.removePlan].every(plan=>typeof plan==='string' && /^[a-f0-9]{64}$/.test(plan)))throw new LocalUiError('hooksInvalid');
  return {supported:true,state:v.state as Status['state'],installPlan:v.installPlan as string,removePlan:v.removePlan as string};
}
export default function CompanionHooksPanel({sessionId,visible,reveal}:{sessionId:string;visible:boolean;reveal?:Readonly<{sessionId:string}>}) {
  useUi();const api=useProtectedApi(nativeApi),{access,mounted}=useMountedAccess();
  const [agent,setAgent]=useState<Agent|''>(''),[profile,setProfile]=useState(''),[status,setStatus]=useState<Status>(),[busy,setBusy]=useState(false),[error,setError]=useState<UiErrorCause>(''),[uncertain,setUncertain]=useState(false);
  const [opened,setOpened]=useState(false),[discovery,setDiscovery]=useState<Discovery>(),[detecting,setDetecting]=useState(false),[discoveryError,setDiscoveryError]=useState(false);
  const discoveryRevision=useRef(0);
  const revision=useRef(0),flight=useRef<number|null>(null);
  const disclosure=useRef<HTMLDetailsElement>(null),inspect=useRef<HTMLButtonElement>(null),focusInspection=useRef(false);
  const selection=useRef({sessionId,visible,agent,profile});selection.current={sessionId,visible,agent,profile};
  useEffect(()=>{
    const current=selection.current;
    if(!reveal || reveal.sessionId!==current.sessionId || !current.visible || !mounted.current || !access.current())return;
    if(disclosure.current){disclosure.current.open=true;setOpened(true);}
    disclosure.current?.querySelector('summary')?.focus();
  },[reveal]);
  useEffect(()=>{revision.current++;flight.current=null;setBusy(false);setStatus(undefined);setError('');setUncertain(false);},[sessionId,visible,agent,profile]);
  useEffect(()=>{
    const id=++discoveryRevision.current;setDiscovery(undefined);setDiscoveryError(false);setDetecting(false);
    if(!visible||!opened||!access.current())return;
    const owns=()=>mounted.current&&access.current()&&id===discoveryRevision.current&&selection.current.visible&&selection.current.sessionId===sessionId&&disclosure.current?.open;
    setDetecting(true);
    void api.companionHookDiscovery(sessionId,2).then(value=>{if(owns())setDiscovery(parseHookDiscovery(value,2));}).catch(()=>{if(owns())setDiscoveryError(true);}).finally(()=>{if(owns())setDetecting(false);});
    return ()=>{discoveryRevision.current++;};
  },[sessionId,visible,opened]);
  useEffect(()=>{setAgent('');setProfile('');},[sessionId]);
  useEffect(()=>{if(!focusInspection.current)return;focusInspection.current=false;if(visible&&access.current()&&disclosure.current?.open)inspect.current?.focus();},[agent,profile]);
  function selectDetected(candidate:Discovery['agents'][number],target:Profile){
    if(busy||!visible||!disclosure.current?.open||!access.current()||!discovery?.managedSetupSupported||candidate.setup!=='managed'||target.state!=='directory'||!target.path||!absoluteProfile(target.path))return;
    revision.current++;setStatus(undefined);setError('');setUncertain(false);
    if(agent===candidate.agent&&profile===target.path){focusInspection.current=false;setAgent('');setProfile('');return;}
    focusInspection.current=true;setAgent(candidate.agent as Agent);setProfile(target.path);
  }
  const copilotSupported=discovery?.schemaVersion===2&&discovery.supported&&discovery.managedSetupSupported;
  const providerAllowed=agent!=='copilot'||copilotSupported;
  async function run(action:'status'|'install'|'remove') {
    if(!providerAllowed || flight.current!==null || !visible || !access.current() || !agent || !absoluteProfile(profile) || discovery?.managedSetupSupported===false)return;
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
  return <details ref={disclosure} className="companion-install" onToggle={()=>setOpened(disclosure.current?.open??false)} hidden={!visible} aria-label={t('hooksTitle')}>
    <summary>{t('hooksTitle')}</summary>
    <section aria-label={t('hooksDetected')}>
      {detecting&&<p className="agent-note" role="status">{t('hooksDetecting')}</p>}
      {discoveryError&&<p className="agent-note" role="status">{t('hooksDetectionUnavailable')}</p>}
      {discovery&&!discovery.supported&&<p className="agent-note">{t('hooksDetectionUnavailable')}</p>}
      {discovery?.supported&&<>
        {!discovery.managedSetupSupported&&<p className="agent-note">{t('hooksUnsupported')}</p>}
        {discovery.agents.length===0&&<p className="agent-note">{t('hooksNoneDetected')}</p>}
        <div role="list" aria-label={t('hooksDetected')} style={{display:'grid',gap:6,maxHeight:'min(34dvh, 260px)',overflowY:'auto',overscrollBehavior:'contain'}}>
          {discovery.agents.flatMap(candidate=>(candidate.profiles.length?candidate.profiles:[{path:null,source:'',state:'unavailable'} as Profile]).map((target,index)=>{
            const enabled=discovery.managedSetupSupported&&candidate.setup==='managed'&&target.state==='directory'&&!!target.path&&absoluteProfile(target.path);
            return <div role="listitem" key={`${candidate.agent}:${index}`}><button type="button" className="subtle-button" style={{display:'block',width:'100%',minHeight:44,textAlign:'left',overflowWrap:'anywhere',whiteSpace:'normal',lineHeight:1.4,borderColor:agent===candidate.agent&&profile===target.path?'var(--theme-accent)':undefined}} disabled={busy||!enabled} aria-pressed={agent===candidate.agent&&profile===target.path} onClick={()=>selectDetected(candidate,target)}>
              <strong>{providers[candidate.agent]}</strong>{' · '}{t(candidate.executable?'hooksExecutableFound':'hooksExecutableMissing')}
              <br/>{target.path&&<code>{target.path}</code>}{target.path&&' · '}{target.source&&<>{target.source} · </>}{t(target.state==='directory'?'hooksProfileFound':target.state==='missing'?'hooksProfileMissing':'hooksProfileUnavailable')}
              {candidate.setup!=='managed'&&<> · {t(candidate.setup==='healthOnly'?'hooksHealthOnly':'hooksManualOnly')}</>}
            </button></div>;
          }))}
        </div>
        {discovery.truncated&&<p className="agent-note">{t('hooksDiscoveryTruncated')}</p>}
      </>}
    </section>
    <p className="agent-note">{t('hooksManualPath')}</p>
    <div className="tool-bar">
      <label>{t('hooksProvider')}<select value={agent} disabled={busy} onChange={e=>setAgent(e.target.value as Agent|'')}><option value="">{t('hooksChooseProvider')}</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="droid">Droid</option><option value="gemini">Gemini CLI</option><option value="cursor">Cursor CLI</option><option value="opencode">OpenCode</option><option value="cline">Cline CLI</option><option value="copilot" disabled={!copilotSupported}>GitHub Copilot CLI</option></select></label>
      <label>{t('hooksProfile')}<input value={profile} disabled={busy} autoCapitalize="none" autoCorrect="off" placeholder={!agent?t('hooksProfilePlaceholder'):agent==='codex'?'/home/user/.codex':agent==='claude'?'/home/user/.claude':agent==='droid'?'/home/user/.factory':agent==='gemini'?'/home/user/.gemini':agent==='cursor'?'/home/user/.cursor':agent==='cline'?'/home/user/.cline':agent==='copilot'?'/home/user/.copilot':'/home/user/.config/opencode'} onChange={e=>setProfile(e.target.value)}/></label>
      <button ref={inspect} className="subtle-button" disabled={busy || !providerAllowed || !agent || !absoluteProfile(profile) || discovery?.managedSetupSupported===false} onClick={()=>void run('status')}>{t('hooksInspect')}</button>
    </div>
    {agent==='copilot'&&!copilotSupported&&<p className="agent-note" role="status">{t('hooksCopilotCapability')}</p>}
    {status && <p className="agent-note" role="status">{t(!status.supported?(status.reason==='HooksDroidStandaloneRequired'?'hooksDroidStandaloneRequired':'hooksUnsupported'):status.state==='conflict'?'hooksConflict':status.state==='configured'?'hooksConfigured':'hooksNotConfigured')}</p>}
    {status?.supported && providerAllowed && discovery?.managedSetupSupported!==false && status.state!=='conflict' && <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={()=>void run('install')}>{t('hooksInstall')}</button><button className="subtle-button" disabled={busy} onClick={()=>void run('remove')}>{t('hooksRemove')}</button></div>}
    {uncertain && <p className="agent-note" role="alert">{t('hooksUncertain')}</p>}
    {error && <p className="agent-note inline-error" role="alert">{uiErrorText(error)}</p>}
    <p className="agent-note">{t(status?.supported && status.state==='configured' ? agent==='codex'?'hooksCodexGuide':agent==='claude'?'hooksClaudeGuide':agent==='opencode'?'hooksOpenCodeGuide':agent==='cline'?'hooksClineGuide':agent==='copilot'?'hooksCopilotGuide':'hooksTrust' : 'hooksTrust')}</p>
  </details>;
}

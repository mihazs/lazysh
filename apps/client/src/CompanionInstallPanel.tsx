import {useEffect,useRef,useState} from 'react';
import {api as nativeApi} from './bridge';
import {useMountedAccess,useProtectedApi} from './access';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {formatNumber,t,useUi} from './i18n/core';

const stages={detecting:'companionInstallDetecting',checkingRelease:'companionInstallRelease',downloading:'companionInstallDownloading',uploading:'companionInstallUploading',verifying:'companionInstallVerifying',selfTesting:'companionInstallSelfTesting',installing:'companionInstallInstalling',checkingInstalled:'companionInstallChecking',cleaningUp:'companionInstallFinishing'} as const;
type Stage=keyof typeof stages;
const cleanupReasons={admission:['disconnected'],ownership:['unowned'],closeUpload:['missing','request','timeout'],directory:['missing','identity','request','timeout'],verifyFile:['missing','identity','hash','request','timeout'],removeFile:['missing','request','timeout'],removeDirectory:['missing','request','timeout']} as const;
type CleanupFailure={stage:keyof typeof cleanupReasons;reason:typeof cleanupReasons[keyof typeof cleanupReasons][number]};
type Result={schemaVersion:1;status:'installed'|'reused'|'rolledBack'|'uncertain';version:string;path:string;cleanup:'complete'|'residue';cleanupFailure?:CleanupFailure;reason?:'committedDurabilityUnknown'|'commitResponseLost'|'verificationUnavailable'};
const failures={companion_install_busy:'companionInstallAlreadyRunning',companion_install_unsupported:'companionInstallUnsupported',companion_release_unavailable:'companionInstallUnavailable',companion_newer_installed:'companionInstallNewer',
  companion_host_network:'companionInstallHostNetwork',companion_host_tool_missing:'companionInstallHostTools',companion_verification_failed:'companionInstallVerification',companion_self_test_failed:'companionInstallSelfTest',
  companion_rolled_back:'companionInstallRolledBack',companion_no_previous:'companionInstallNoPrevious',companion_update_unsupported:'companionInstallRollbackUnsupported',companion_host_busy:'companionInstallHostBusy',companion_unsafe_location:'companionInstallUnsafe'} as const;
/** Only a host that cannot download (no route to GitHub, or no downloader or digest tool) is offered the upload from this device. */
const fallbackKinds:readonly string[]=['companion_host_network','companion_host_tool_missing'];
const details=['dns','connect','timeout','tls','http','rateLimited','interrupted','digestMismatch','sizeMismatch','pinMismatch','redirectRefused','insecureUrl','commitMismatch','noDownloader','noDigestTool'] as const;

const failureKinds=['companion_install_busy','companion_install_unsupported','companion_release_unavailable','companion_newer_installed','companion_installer_invalid','companion_staging','companion_install_timeout','companion_host_network','companion_host_tool_missing','companion_verification_failed','companion_self_test_failed','companion_rolled_back','companion_host_busy','companion_unsafe_location','companion_no_previous','companion_update_unsupported','disconnected','app_locked','ssh_error','remote_command_failed','invalid_output','output_too_large','timeout'] as const;
type FailureKind=typeof failureKinds[number]|'other'|'none';
type Route='host'|'device'|'rollback';
type Observation={phase:Stage|'preflight'|'unavailable';failure:FailureKind;outcome:'idle'|'pending'|'failed'|Result['status'];reason:NonNullable<Result['reason']>|'none';route:Route|'none';detail:typeof details[number]|'none';recheck?:string};
const initialObservation:Observation={phase:'unavailable',failure:'none',outcome:'idle',reason:'none',route:'none',detail:'none'};
export function companionInstallFailure(error:unknown):{phase?:Observation['phase'];failure:FailureKind;detail:Observation['detail'];recheck?:string} {
  if(!error || typeof error!=='object')return {failure:'other',detail:'none'};
  const value=error as {kind?:unknown;phase?:unknown;message?:unknown;detail?:unknown};
  const phase=value.phase===null?'preflight':companionInstallStage({stage:value.phase});
  const recheck=value.kind==='companion_release_unavailable' && phase==='verifying' && typeof value.message==='string'
    && value.message===value.message.trim() && /^lazysh-tag-recheck-v1:(?:transport:(?:timeout|connect|redirect|body|decode|request|other)|status:(?:[1-5][0-9]{2}|other)|body|json|ref|type|sha)$/.test(value.message)?value.message:undefined;
  const detail=(details as readonly unknown[]).includes(value.detail)?value.detail as typeof details[number]:'none';
  return {...(recheck?{recheck}:{}),phase:phase==='cleaningUp'?undefined:phase,failure:failureKinds.includes(value.kind as typeof failureKinds[number])?value.kind as FailureKind:'other',detail};
}

type Progress={stage:Stage;bytes?:number;total?:number};
/** One progress event: a known stage, plus the host's byte counts only for its own download. */
export function companionInstallProgress(value:unknown):Progress|undefined {
  if(!value || typeof value!=='object')return;
  const keys=Object.keys(value).join(',');
  const {stage,bytes,total}=value as {stage:unknown;bytes?:unknown;total?:unknown};
  if((keys!=='stage' && keys!=='stage,bytes,total') || typeof stage!=='string' || !Object.hasOwn(stages,stage))return;
  if(keys==='stage')return {stage:stage as Stage};
  return stage==='downloading' && Number.isSafeInteger(bytes) && Number.isSafeInteger(total) && (bytes as number)>=0 && (bytes as number)<=(total as number)?{stage,bytes:bytes as number,total:total as number}:undefined;
}
export function companionInstallStage(value:unknown):Stage|undefined {
  return companionInstallProgress(value)?.stage;
}
export function parseCompanionInstall(value:unknown):Result {
  if(!value || typeof value!=='object')throw new LocalUiError('companionInstallInvalid');
  const result=value as Result;
  const detail=result.cleanupFailure;
  const validCleanup=detail && typeof detail==='object' && !Array.isArray(detail)
    && Object.keys(detail).length===2 && Object.keys(detail).every(key=>key==='stage'||key==='reason')
    && Object.hasOwn(cleanupReasons,detail.stage) && (cleanupReasons[detail.stage] as readonly unknown[]).includes(detail.reason);
  if(Object.keys(result).some(key=>!['schemaVersion','status','version','path','cleanup','cleanupFailure','reason'].includes(key))
    || result.schemaVersion!==1 || !['installed','reused','rolledBack','uncertain'].includes(result.status)
    || typeof result.version!=='string' || result.version.length>64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(result.version)
    || typeof result.path!=='string' || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(result.path)
    || new TextEncoder().encode(result.path).length>4096 || /[\x00-\x1f\x7f-\x9f]/.test(result.path)
    || !['complete','residue'].includes(result.cleanup)
    || (Object.hasOwn(result,'cleanupFailure') && (result.cleanup!=='residue' || !validCleanup))
    || (result.status==='uncertain' ? !['committedDurabilityUnknown','commitResponseLost','verificationUnavailable'].includes(result.reason??'') : Object.hasOwn(result,'reason')))
    throw new LocalUiError('companionInstallInvalid');
  return result;
}

const checkStates=['notInstalled','available','upToDate','newer'] as const;
const checkMessages={notInstalled:'companionCheckNotInstalled',available:'companionCheckAvailable',upToDate:'companionCheckUpToDate',newer:'companionCheckNewer'} as const;
const resultMessages={installed:'companionInstallDone',reused:'companionInstallReused',rolledBack:'companionInstallRestored'} as const;
type Check={via:'update'|'bootstrap';installed:string|null;previous:string|null;latest:string;state:typeof checkStates[number]};
const plainVersion=(value:unknown)=>typeof value==='string' && value.length<=64 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);
/** The result of Check for updates: versions and a closed state, nothing else, so host text can never reach the panel. */
export function parseCompanionCheck(value:unknown):Check {
  const check=value as Partial<Check>&{schemaVersion?:unknown};
  if(!value || typeof value!=='object' || Object.keys(check).sort().join(',')!=='installed,latest,previous,schemaVersion,state,via'
    || check.schemaVersion!==1 || !['update','bootstrap'].includes(check.via as string) || !plainVersion(check.latest)
    || (check.installed!==null && !plainVersion(check.installed)) || (check.previous!==null && !plainVersion(check.previous))
    || !(checkStates as readonly unknown[]).includes(check.state))throw new LocalUiError('companionInstallInvalid');
  return check as Check;
}
export default function CompanionInstallPanel({sessionId,visible=true,ready=false,onInstalled}:{sessionId:string;visible?:boolean;ready?:boolean;onInstalled:()=>void}) {
  useUi();const api=useProtectedApi(nativeApi);const {access,mounted}=useMountedAccess();
  const [stage,setStage]=useState<Stage>();const [counted,setCounted]=useState<{bytes:number;total:number}>();const [fallback,setFallback]=useState(false);const [checked,setChecked]=useState<Check>();const [checking,setChecking]=useState(false);const [result,setResult]=useState<Result>();const [error,setError]=useState<UiErrorCause>('');
  const [observation,setObservation]=useState<Observation>(initialObservation);
  const revision=useRef(0),pending=useRef<number|null>(null);
  const scope=useRef({sessionId,visible});scope.current={sessionId,visible};
  useEffect(()=>{setStage(undefined);setCounted(undefined);setFallback(false);setChecked(undefined);setChecking(false);setResult(undefined);setError('');setObservation(initialObservation);return()=>{revision.current++;pending.current=null;};},[sessionId,visible]);
  async function install(route:Route) {
    if(!visible || !access.current() || pending.current!==null)return;
    const current=++revision.current;pending.current=current;
    const owns=()=>mounted.current && access.current() && scope.current.visible && scope.current.sessionId===sessionId && revision.current===current && pending.current===current;
    setStage('detecting');setCounted(undefined);setFallback(false);setChecked(undefined);setResult(undefined);setError('');setObservation({...initialObservation,route,outcome:'pending'});
    try {
      const value=parseCompanionInstall(await ({host:api.installCompanion,device:api.installCompanionFromDevice,rollback:api.rollbackCompanion}[route])(sessionId,event=>{
        const next=companionInstallProgress(event);if(owns() && next){
          setStage(next.stage);setCounted(next.bytes===undefined?undefined:{bytes:next.bytes,total:next.total!});
          if(next.stage!=='cleaningUp')setObservation(previous=>({...previous,phase:next.stage}));
        }
      }));
      if(owns()){
        setResult(value);setObservation(previous=>({...previous,outcome:value.status,reason:value.reason??'none',...(value.status==='uncertain'?{phase:value.reason==='verificationUnavailable'?'checkingInstalled':'installing'}:{})}));
        if(value.status!=='uncertain')onInstalled();
      }
    } catch(error){
      const kind=error && typeof error==='object' && 'kind' in error?error.kind:undefined;
      if(owns()){
        const failure=companionInstallFailure(error);
        setObservation(previous=>({...previous,...(failure.phase?{phase:failure.phase}:{}),failure:failure.failure,detail:failure.detail,recheck:failure.recheck,outcome:'failed'}));
        setFallback(route==='host' && fallbackKinds.includes(failure.failure));
        setError(typeof kind==='string' && Object.hasOwn(failures,kind)?new LocalUiError(failures[kind as keyof typeof failures]):captureUiError(error));
      }
    }
    finally {if(owns()){setStage(undefined);setCounted(undefined);}if(pending.current===current)pending.current=null;}
  }
  async function check() {
    if(!visible || !access.current() || pending.current!==null)return;
    const current=++revision.current;pending.current=current;
    const owns=()=>mounted.current && access.current() && scope.current.visible && scope.current.sessionId===sessionId && revision.current===current && pending.current===current;
    setChecking(true);setChecked(undefined);setResult(undefined);setError('');setFallback(false);
    try {
      const value=parseCompanionCheck(await api.checkCompanionUpdate(sessionId));
      if(owns())setChecked(value);
    } catch(error){
      const kind=error && typeof error==='object' && 'kind' in error?error.kind:undefined;
      if(owns())setError(typeof kind==='string' && Object.hasOwn(failures,kind)?new LocalUiError(failures[kind as keyof typeof failures]):captureUiError(error));
    }
    finally {if(owns())setChecking(false);if(pending.current===current)pending.current=null;}
  }
  const busy=!!stage || checking;
  return <details data-install-recheck={observation.recheck} data-install-phase={observation.phase} data-install-failure={observation.failure} data-install-route={observation.route} data-install-detail={observation.detail} data-install-outcome={observation.outcome} data-install-reason={observation.reason} data-install-cleanup-stage={result?.cleanupFailure?.stage??'none'} data-install-cleanup-reason={result?.cleanupFailure?.reason??'none'} className="companion-install" hidden={!visible} open={!ready || !!stage || !!result || !!error} aria-label={t('companionInstallTitle')}>
    <summary>{t('companionInstallTitle')}</summary>
    <div className="tool-bar"><button className="subtle-button" disabled={!visible || busy || !access.current()} onClick={()=>void install('host')}>{stage?t('companionInstallBusy'):t(ready?'companionInstallUpdate':'companionInstallButton')}</button></div>
    <div className="companion-actions">
      <button className="subtle-button" disabled={!visible || busy || !access.current()} onClick={()=>void check()}>{t(checking?'companionCheckBusy':'companionCheckButton')}</button>
      {checked?.previous && <button className="subtle-button" disabled={!visible || busy || !access.current()} onClick={()=>void install('rollback')}>{t('companionRollbackButton',{version:checked.previous})}</button>}
    </div>
    {checked && <p className="agent-note" role="status">{t(checkMessages[checked.state],{installed:checked.installed??'',latest:checked.latest})}</p>}
    {stage && <p className="agent-note" role="status">{counted?t('companionInstallDownloadingBytes',{done:formatNumber(counted.bytes/1_048_576,{maximumFractionDigits:1}),total:formatNumber(counted.total/1_048_576,{maximumFractionDigits:1})}):t(stages[stage])}</p>}
    {error && <p className="agent-note inline-error" role="alert">{uiErrorText(error)}</p>}
    {fallback && !stage && <div className="companion-fallback">
      <p className="agent-note">{t('companionInstallFallbackNote')}</p>
      <button className="subtle-button" disabled={!visible || !access.current()} onClick={()=>void install('device')}>{t('companionInstallFallbackButton')}</button>
    </div>}
    {result && <div className="agent-note" role={result.status==='uncertain'?'alert':'status'}>
      <p>{result.status==='uncertain'?t('companionInstallUncertain'):t(resultMessages[result.status],{version:result.version})}</p>
      <code>{result.path}</code>
      {result.cleanup==='residue' && <p>{t('companionInstallResidue')}</p>}
    </div>}
  </details>;
}

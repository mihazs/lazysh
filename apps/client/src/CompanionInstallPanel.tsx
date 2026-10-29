import {useEffect,useRef,useState} from 'react';
import {api as nativeApi} from './bridge';
import {useMountedAccess,useProtectedApi} from './access';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {t,useUi} from './i18n/core';

const stages={detecting:'companionInstallDetecting',checkingRelease:'companionInstallRelease',downloading:'companionInstallDownloading',uploading:'companionInstallUploading',verifying:'companionInstallVerifying',installing:'companionInstallInstalling',checkingInstalled:'companionInstallChecking',cleaningUp:'companionInstallFinishing'} as const;
type Stage=keyof typeof stages;
type Result={schemaVersion:1;status:'installed'|'reused'|'uncertain';version:string;path:string;cleanup:'complete'|'residue';reason?:'committedDurabilityUnknown'|'commitResponseLost'|'verificationUnavailable'};
const failures={companion_install_busy:'companionInstallAlreadyRunning',companion_install_unsupported:'companionInstallUnsupported',companion_release_unavailable:'companionInstallUnavailable',companion_newer_installed:'companionInstallNewer'} as const;

export function companionInstallStage(value:unknown):Stage|undefined {
  if(!value || typeof value!=='object' || Object.keys(value).join(',')!=='stage')return;
  const stage=(value as {stage:unknown}).stage;
  return typeof stage==='string' && Object.hasOwn(stages,stage)?stage as Stage:undefined;
}
export function parseCompanionInstall(value:unknown):Result {
  if(!value || typeof value!=='object')throw new LocalUiError('companionInstallInvalid');
  const result=value as Result;
  if(Object.keys(result).some(key=>!['schemaVersion','status','version','path','cleanup','reason'].includes(key))
    || result.schemaVersion!==1 || !['installed','reused','uncertain'].includes(result.status)
    || typeof result.version!=='string' || result.version.length>64 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(result.version)
    || typeof result.path!=='string' || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(result.path)
    || new TextEncoder().encode(result.path).length>4096 || /[\x00-\x1f\x7f-\x9f]/.test(result.path)
    || !['complete','residue'].includes(result.cleanup)
    || (result.status==='uncertain' ? !['committedDurabilityUnknown','commitResponseLost','verificationUnavailable'].includes(result.reason??'') : Object.hasOwn(result,'reason')))
    throw new LocalUiError('companionInstallInvalid');
  return result;
}

export default function CompanionInstallPanel({sessionId,visible=true,ready=false,onInstalled}:{sessionId:string;visible?:boolean;ready?:boolean;onInstalled:()=>void}) {
  useUi();const api=useProtectedApi(nativeApi);const {access,mounted}=useMountedAccess();
  const [stage,setStage]=useState<Stage>();const [result,setResult]=useState<Result>();const [error,setError]=useState<UiErrorCause>('');
  const revision=useRef(0),pending=useRef<number|null>(null);
  const scope=useRef({sessionId,visible});scope.current={sessionId,visible};
  useEffect(()=>{setStage(undefined);setResult(undefined);setError('');return()=>{revision.current++;pending.current=null;};},[sessionId,visible]);
  async function install() {
    if(!visible || !access.current() || pending.current!==null)return;
    const current=++revision.current;pending.current=current;
    const owns=()=>mounted.current && access.current() && scope.current.visible && scope.current.sessionId===sessionId && revision.current===current && pending.current===current;
    setStage('detecting');setResult(undefined);setError('');
    try {
      const value=parseCompanionInstall(await api.installCompanion(sessionId,event=>{
        const next=companionInstallStage(event);if(owns() && next)setStage(next);
      }));
      if(owns()){setResult(value);if(value.status!=='uncertain')onInstalled();}
    } catch(error){
      const kind=error && typeof error==='object' && 'kind' in error?error.kind:undefined;
      if(owns())setError(typeof kind==='string' && Object.hasOwn(failures,kind)?new LocalUiError(failures[kind as keyof typeof failures]):captureUiError(error));
    }
    finally {if(owns())setStage(undefined);if(pending.current===current)pending.current=null;}
  }
  return <details className="companion-install" hidden={!visible} open={!ready || !!stage || !!result || !!error} aria-label={t('companionInstallTitle')}>
    <summary>{t('companionInstallTitle')}</summary>
    <div className="tool-bar"><button className="subtle-button" disabled={!visible || !!stage || !access.current()} onClick={()=>void install()}>{stage?t('companionInstallBusy'):t(ready?'companionInstallUpdate':'companionInstallButton')}</button></div>
    {stage && <p className="agent-note" role="status">{t(stages[stage])}</p>}
    {error && <p className="agent-note inline-error" role="alert">{uiErrorText(error)}</p>}
    {result && <div className="agent-note" role={result.status==='uncertain'?'alert':'status'}>
      <p>{result.status==='uncertain'?t('companionInstallUncertain'):t(result.status==='reused'?'companionInstallReused':'companionInstallDone',{version:result.version})}</p>
      <code>{result.path}</code>
      {result.cleanup==='residue' && <p>{t('companionInstallResidue')}</p>}
    </div>}
  </details>;
}

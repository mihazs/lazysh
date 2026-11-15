import {useEffect,useRef,useState} from 'react';
import {api as nativeApi} from './bridge';
import {useMountedAccess,useProtectedApi} from './access';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {t,useUi} from './i18n/core';
import {parseCompanionInstall} from './CompanionInstallPanel';

/** Why an install or removal was refused, from the closed kinds the native side reports; anything else is shown generically. */
const failures={
  companion_install_busy:'managedHerdrAlreadyRunning',herdr_host_busy:'managedHerdrAlreadyRunning',
  companion_install_unsupported:'managedHerdrUnsupported',herdr_unsupported_host:'managedHerdrUnsupported',herdr_architecture_mismatch:'managedHerdrUnsupported',
  companion_release_unavailable:'managedHerdrUnavailable',herdr_unsafe_location:'managedHerdrUnsafe',
  herdr_staged_mismatch:'managedHerdrVerification',herdr_self_test_failed:'managedHerdrVerification',
  herdr_stale_plan:'managedHerdrStale',herdr_host_tool_missing:'managedHerdrHostTools',
  herdr_installed_mismatch:'managedHerdrUncertain',herdr_installer_invalid:'managedHerdrUncertain',
} as const;
type Outcome={status:'installed'|'reused'|'uncertain'|'removed'|'absent';version?:string;path:string;residue?:boolean};
const hostPath=/^\/[^\x00-\x1f\x7f-\x9f]{1,4095}$/;
export function parseManagedHerdrInstall(value:unknown):Outcome {
  try {
    const result=parseCompanionInstall(value);
    if(hostPath.test(result.path))return {status:result.status,version:result.version,path:result.path,residue:result.cleanup==='residue'};
  } catch {/* The same invalid answer below. */}
  throw new LocalUiError('managedHerdrInvalid');
}
export function parseManagedHerdrRemoval(value:unknown):Outcome {
  const result=value as {schemaVersion?:unknown;status?:unknown;path?:unknown}|null;
  if(!result || typeof result!=='object' || Object.keys(result).sort().join()!=='path,schemaVersion,status' || result.schemaVersion!==1
    || (result.status!=='removed' && result.status!=='absent') || typeof result.path!=='string' || !hostPath.test(result.path))throw new LocalUiError('managedHerdrInvalid');
  return {status:result.status,path:result.path};
}
const messages={installed:'managedHerdrDone',reused:'managedHerdrReused',uncertain:'managedHerdrUncertain',removed:'managedHerdrRemoved',absent:'managedHerdrAbsent'} as const;

/** The explicit, per-host install and removal of the managed Herdr; nothing about the system Herdr or its servers changes. */
export default function ManagedHerdrPanel({sessionId}:{sessionId:string}) {
  useUi();const api=useProtectedApi(nativeApi);const {access,mounted}=useMountedAccess();
  const [busy,setBusy]=useState<'install'|'remove'>();const [outcome,setOutcome]=useState<Outcome>();const [error,setError]=useState<UiErrorCause>('');
  const revision=useRef(0),pending=useRef(false);
  useEffect(()=>{setBusy(undefined);setOutcome(undefined);setError('');pending.current=false;return()=>{revision.current++;};},[sessionId]);
  async function run(action:'install'|'remove') {
    if(pending.current || !access.current())return;
    const current=++revision.current;pending.current=true;
    const owns=()=>mounted.current && access.current() && revision.current===current;
    setBusy(action);setOutcome(undefined);setError('');
    try {
      const value=action==='install'?parseManagedHerdrInstall(await api.installManagedHerdr(sessionId,()=>{})):parseManagedHerdrRemoval(await api.removeManagedHerdr(sessionId));
      if(owns())setOutcome(value);
    } catch(failure) {
      const kind=failure && typeof failure==='object' && 'kind' in failure?failure.kind:undefined;
      if(owns())setError(typeof kind==='string' && Object.hasOwn(failures,kind)?new LocalUiError(failures[kind as keyof typeof failures]):captureUiError(failure));
    }
    finally {if(revision.current===current)pending.current=false;if(owns())setBusy(undefined);}
  }
  return <details className="managed-herdr" aria-label={t('managedHerdrTitle')} open={!!busy || !!outcome || !!error}>
    <summary>{t('managedHerdrTitle')}</summary>
    <p className="security-note">{t('managedHerdrNote')}</p>
    <div className="tool-bar">
      <button className="subtle-button" disabled={!!busy || !access.current()} onClick={()=>void run('install')}>{busy==='install'?t('managedHerdrWorking'):t('managedHerdrInstall')}</button>
      <button className="subtle-button" disabled={!!busy || !access.current()} onClick={()=>void run('remove')}>{busy==='remove'?t('managedHerdrWorking'):t('managedHerdrRemove')}</button>
    </div>
    {error && <p className="agent-note inline-error" role="alert">{uiErrorText(error)}</p>}
    {outcome && <div className="agent-note" role={outcome.status==='uncertain'?'alert':'status'}>
      <p>{t(messages[outcome.status],{version:outcome.version??''})}</p>
      <code>{outcome.path}</code>
      {outcome.residue && <p>{t('companionInstallResidue')}</p>}
    </div>}
  </details>;
}

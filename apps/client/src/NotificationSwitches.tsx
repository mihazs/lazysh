import {useEffect,useRef,useState} from 'react';
import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {useProtectedInvoke} from './access';
import {useHostSwitchStatus} from './hostSwitchStatus';

type Policy={schemaVersion:1;revision:number;nestedAgentSuppressionEnabled:boolean;suppressWhileDesktopUnlocked:boolean};
const fields=['schemaVersion','revision','nestedAgentSuppressionEnabled','suppressWhileDesktopUnlocked'];
export function parseNotificationPolicy(value:unknown):Policy {
  const policy=value as Policy|null;
  if(!policy || typeof policy!=='object' || Array.isArray(policy) || Object.keys(policy).some(key=>!fields.includes(key)) || policy.schemaVersion!==1 || !Number.isSafeInteger(policy.revision) || policy.revision<0
    || typeof policy.nestedAgentSuppressionEnabled!=='boolean' || typeof policy.suppressWhileDesktopUnlocked!=='boolean')throw new LocalUiError('companionUnsupported');
  return policy;
}
/** The native layer answers a companion that predates `settings notifications` with this failure kind. */
const outdated=(failure:unknown)=>!!failure && typeof failure==='object' && 'kind' in failure && failure.kind==='notification_policy_companion_required';

/**
 * The two notification switches the host companion keeps in their own file with their own revision, so they are
 * read and saved by their own commands and never travel with the three host switches. Nothing is offered unless the
 * companion answers `settings notifications show`.
 */
export default function NotificationSwitches({sessionId,visible,reload}:{sessionId:string;visible:boolean;reload:number}) {
  useUi();
  const invoke=useProtectedInvoke();
  const [policy,setPolicy]=useState<Policy>();
  const [draft,setDraft]=useState({nested:false,unlocked:false});
  const {outdatedCompanion,setOutdatedCompanion,error,setError,busy,setBusy,saved,setSaved}=useHostSwitchStatus();
  const request=useRef(0);
  const pendingSave=useRef<Promise<unknown>|undefined>(undefined);
  const owns=(current:number)=>current===request.current;
  function adopt(value:Policy) {setPolicy(value);setDraft({nested:value.nestedAgentSuppressionEnabled,unlocked:value.suppressWhileDesktopUnlocked});}
  async function load() {
    const current=++request.current;setBusy(true);setError('');setSaved(false);setOutdatedCompanion(false);
    try {
      await pendingSave.current?.catch(()=>undefined);
      if(!owns(current))return;
      const value=parseNotificationPolicy(await invoke('get_notification_policy',{sessionId}));
      if(owns(current))adopt(value);
    } catch(failure) {
      if(!owns(current))return;
      setPolicy(undefined);
      if(outdated(failure))setOutdatedCompanion(true);
      else setError(captureUiError(failure));
    } finally {if(owns(current))setBusy(false);}
  }
  // A hidden panel or another session retires whatever is in flight; showing the panel again reads the host again.
  useEffect(()=>{
    request.current++;setBusy(false);
    if(visible){setPolicy(undefined);void load();}
    return()=>{request.current++;};
  },[sessionId,visible,reload]);
  async function save() {
    if(!policy || busy || pendingSave.current)return;
    const current=++request.current;setBusy(true);setError('');setSaved(false);
    let pending:Promise<unknown>|undefined;
    try {
      pending=invoke('update_notification_policy',{sessionId,policy:{expectedRevision:policy.revision,nestedAgentSuppressionEnabled:draft.nested,suppressWhileDesktopUnlocked:draft.unlocked}});
      pendingSave.current=pending;
      const value=parseNotificationPolicy(await pending);
      if(owns(current)){adopt(value);setSaved(true);}
    } catch(failure) {if(owns(current))setError({refresh:captureUiError(failure)});}
    finally {if(pendingSave.current===pending)pendingSave.current=undefined;if(owns(current))setBusy(false);}
  }
  const failure=error&&<p role="alert" className="inline-error">{typeof error==='object'&&'refresh' in error?t('companionRefreshWarning',{error:uiErrorText(error.refresh)}):uiErrorText(error)}</p>;
  if(outdatedCompanion)return <p role="status">{t('notificationsUnsupported')}</p>;
  if(!policy)return <>{failure}</>;
  return <form className="form-stack" onSubmit={event=>{event.preventDefault();void save();}}><fieldset disabled={busy || !visible}>
    <legend>{t('notificationsLegend')}</legend>
    <label><input type="checkbox" checked={draft.nested} onChange={event=>{setSaved(false);setDraft({...draft,nested:event.target.checked});}}/>{t('notificationsNested')}</label>
    <p>{t('notificationsNestedHint')}</p>
    <label><input type="checkbox" checked={draft.unlocked} onChange={event=>{setSaved(false);setDraft({...draft,unlocked:event.target.checked});}}/>{t('notificationsUnlocked')}</label>
    <p>{t('notificationsUnlockedHint')}</p>
    {failure}
    <button type="submit">{t('notificationsSave')}</button>
    {saved&&<p role="status">{t('notificationsSaved')}</p>}
  </fieldset></form>;
}

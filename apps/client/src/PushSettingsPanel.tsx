import './PushSettingsPanel.css';
import {RefreshCw} from 'lucide-react';
import {t,useUi} from './i18n/core';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';

type RegistrationStatus = {
  provider: 'apns' | 'fcm' | 'unifiedpush' | 'none';
  availableProviders?: ('fcm'|'unifiedpush')[];
  supported: boolean;
  configured: boolean;
  enabled: boolean;
  tokenPresent: boolean;
  busy: boolean;
  displaySupported?: boolean;
  displayEnabled?: boolean;
  reason: string;
};

export default function PushSettingsPanel() {
  useUi();
  const invoke = useProtectedInvoke();
  const [status, setStatus] = useState<RegistrationStatus>();
  const [pending, setPending] = useState(false);
  const [activeCommand, setActiveCommand] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<''|'pushPauseFailed'|'pushOperationFailed'>('');
  const request = useRef(0);

  async function run(command: string,args?:Record<string,unknown>) {
    const current = ++request.current;
    setPending(true); setActiveCommand(command); setError('');
    if (command === 'push_registration_provider') setConsent(false);
    try {
      const next = await invoke<RegistrationStatus>(command,args);
      if (request.current === current) { setStatus(next); setConsent(false); }
    } catch {
      if (request.current === current) {
        setError(command === 'push_registration_disable'
          ? 'pushPauseFailed'
          : 'pushOperationFailed');
        // A failed asynchronous registration/revocation can still change native state.
        try {
          const next = await invoke<RegistrationStatus>('push_registration_status');
          if (request.current === current) setStatus(next);
        } catch { /* Keep the prior status and the actionable error. */ }
      }
    } finally { if (request.current === current) { setPending(false); setActiveCommand(''); } }
  }

  useEffect(() => {
    if (isTauri()) void run('push_registration_status');
    return () => { request.current++; };
  }, []);

  const busy = pending || status?.busy === true;
  const apple = status?.provider === 'apns';
  const unified = status?.provider === 'unifiedpush';
  const provider = apple ? 'Apple APNs' : unified ? 'UnifiedPush' : 'Google Firebase';
  const choices=[...new Set(status?.availableProviders??[])].filter(provider=>provider==='fcm'||provider==='unifiedpush');
  const choosingDisabled=busy||status?.enabled===true||status?.tokenPresent===true;
  const registering = ['push_registration_register','push_registration_enroll'].includes(activeCommand);
  const registerAction=<button type="button" onClick={() => void run('push_registration_register')} disabled={busy || (!status?.enabled && !consent)}>
    {status?.enabled ? t('pushRefreshDevice') : t('pushRegister')}
  </button>;
  const connectAction=<button type="button" className="primary-button" onClick={() => void run('push_registration_enroll')} disabled={busy || !consent}>{t('pushConnectRelay')}</button>;
  return <section className="tool-panel push-settings-panel" aria-label={t('pushTitle')}>
    <header><h3>{t('pushTitle')}</h3><button type="button" className="icon-button" aria-label={t('pushRefresh')} title={t('pushRefresh')} onClick={() => void run('push_registration_status')} disabled={!isTauri() || pending}><RefreshCw size={18} aria-hidden="true"/></button></header>
    {choices.length>1&&<label className="push-provider"><span>{t('pushSetupService')}</span><select aria-label={t('pushProvider')} value={status?.provider} disabled={choosingDisabled} onChange={event=>void run('push_registration_provider',{provider:event.target.value})}>{choices.map(choice=><option key={choice} value={choice}>{choice==='unifiedpush'?'UnifiedPush':'Google Firebase'}</option>)}</select></label>}
    {choices.length>1&&choosingDisabled&&<p>{t('pushProviderChoiceHint')}</p>}
    <p role="status">{!isTauri() ? t('pushNativeRequired') : status?.provider === 'none' ? t('pushUnavailable') : status?.reason ?? t('pushInspecting')}</p>
    {status && status.provider !== 'none' && <p className="push-privacy">{t('pushPrivacy',{provider})}</p>}
    {unified && status?.supported && !status.configured && <p>{t('pushUnifiedPrerequisite')}</p>}
    {status?.supported && status.configured && !status.enabled && <label className="push-consent">
      <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} />
      {t('pushConsent',{provider})}
    </label>}
    <div className="tool-actions">
      {!unified && status?.supported && status.configured && <div className="push-step">{!status.enabled&&<span>{t('pushSetupDevice')}</span>}{registerAction}</div>}
      {unified && status?.supported && status.configured && !status.enabled && !status.tokenPresent && <div className="push-step"><span>{t('pushSetupDelivery')}</span><p>{t('pushUnifiedEnrollment')}</p>{connectAction}</div>}
      {status?.supported && (status.enabled || status.tokenPresent || registering) && <button type="button" onClick={() => void run('push_registration_disable')} disabled={pending && !registering}>
        {apple ? t('pushDisableApns') : status.enabled || registering ? t(unified ? 'pushUnifiedPause' : 'pushPause') : t(unified ? 'pushUnifiedRetry' : 'pushRetryRevocation')}
      </button>}
      {unified && status?.enabled && !status.displaySupported && <p>{t('pushUnifiedPauseBeforeConnect')}</p>}
      {unified && status?.supported && status.configured && !status.enabled && status.tokenPresent && <details className="push-step" open><summary>{t('pushSetupDelivery')}</summary><p>{t('pushUnifiedEnrollment')}</p>{connectAction}</details>}
      {unified && status?.supported && status.configured && <details className="push-step"><summary>{t('pushRegistrationOnly')}</summary><p>{t('pushScope',{provider})}</p>{registerAction}</details>}
      {unified && status?.displaySupported && <details className="push-step" open={status.enabled&&!status.displayEnabled}><summary>{t('pushSetupDisplay')}</summary><button type="button" onClick={() => void run('push_registration_display')} disabled={busy}>
        {t('pushReviewDisplay')}
      </button></details>}
    </div>
    {apple && <p>{t('pushApnsHint')}</p>}
    <details className="push-help"><summary>{t('pushSetupHelp')}</summary>{status && status.provider !== 'none' && <p>{t('pushScope',{provider})}</p>}{unified && <><p>{t('pushUnifiedSetup')}</p><p>{t('pushUnifiedHint')}</p></>}</details>
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}

import {t,useUi} from './i18n/core';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';

type RegistrationStatus = {
  provider: 'apns' | 'fcm' | 'unifiedpush' | 'none';
  supported: boolean;
  configured: boolean;
  enabled: boolean;
  tokenPresent: boolean;
  busy: boolean;
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

  async function run(command: string) {
    const current = ++request.current;
    setPending(true); setActiveCommand(command); setError('');
    try {
      const next = await invoke<RegistrationStatus>(command);
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
  return <section className="tool-panel" aria-label={t('pushTitle')}>
    <h3>{t('pushTitle')}</h3>
    {status && status.provider !== 'none' && <p>{t('pushScope',{provider})}</p>}
    <p role="status">{!isTauri() ? t('pushNativeRequired') : status?.provider === 'none' ? t('pushUnavailable') : status?.reason ?? t('pushInspecting')}</p>
    {status && status.provider !== 'none' && <p>{t('pushPrivacy',{provider})}</p>}
    {status?.supported && status.configured && !status.enabled && <label>
      <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} />
      {t('pushConsent',{provider})}
    </label>}
    <div className="tool-actions">
      <button type="button" onClick={() => void run('push_registration_status')} disabled={!isTauri() || pending}>{t('pushRefresh')}</button>
      {status?.supported && status.configured && <button type="button" onClick={() => void run('push_registration_register')} disabled={busy || (!status.enabled && !consent)}>
        {status.enabled ? t('pushRefreshDevice') : t('pushRegister')}
      </button>}
      {status?.supported && (status.enabled || status.tokenPresent || activeCommand === 'push_registration_register') && <button type="button" onClick={() => void run('push_registration_disable')} disabled={pending && activeCommand !== 'push_registration_register'}>
        {apple ? t('pushDisableApns') : status.enabled || activeCommand === 'push_registration_register' ? t(unified ? 'pushUnifiedPause' : 'pushPause') : t(unified ? 'pushUnifiedRetry' : 'pushRetryRevocation')}
      </button>}
    </div>
    {apple && <p>{t('pushApnsHint')}</p>}
    {unified && <p>{t('pushUnifiedHint')}</p>}
    {error && <p role="alert">{t(error)}</p>}
  </section>;
}

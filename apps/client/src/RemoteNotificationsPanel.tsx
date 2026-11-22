import './PushSettingsPanel.css';
import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import { t, useUi } from './i18n/core';
import { useProtectedInvoke } from './access';

type Status = {
  supported: boolean;
  configured: boolean;
  enabled: boolean;
  running: boolean;
  origin: string | null;
  error: string | null;
};
const errorKeys = {
  origin: 'remoteNotifErrorOrigin',
  token: 'remoteNotifErrorToken',
  unauthorized: 'remoteNotifErrorUnauthorized',
  unreachable: 'remoteNotifErrorUnreachable',
  invalid: 'remoteNotifErrorInvalid',
  storage: 'remoteNotifErrorStorage',
  credentials: 'remoteNotifErrorCredentials',
  notification_permission: 'remoteNotifErrorPermission',
  notification_failed: 'remoteNotifErrorPermission',
} as const;
/** The native side reports finite codes; anything else shows the generic text, never raw error text. */
const errorText = (failure: unknown) => {
  const code = typeof failure === 'string' ? failure : failure instanceof Error ? failure.message : '';
  return t(code in errorKeys ? errorKeys[code as keyof typeof errorKeys] : 'remoteNotifErrorGeneric');
};

/** Desktop only: receives the relay's remote "needs you" events from the user's own Gotify server. */
export default function RemoteNotificationsPanel() {
  useUi();
  const invoke = useProtectedInvoke();
  const [status, setStatus] = useState<Status>();
  const [origin, setOrigin] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const alive = useRef(true);

  async function run(command: string, args?: Record<string, unknown>) {
    setBusy(true); setFailure(undefined);
    try {
      const next = await invoke<Status>(command, args);
      if (alive.current) { setStatus(next); setToken(''); }
    } catch (error) {
      if (alive.current) setFailure(error);
    } finally { if (alive.current) setBusy(false); }
  }
  async function connect() {
    // The OS permission is asked only now, by the explicit opt-in, never on mount.
    try {
      if (!await isPermissionGranted() && await requestPermission() !== 'granted') { setFailure('notification_permission'); return; }
    } catch { setFailure('notification_permission'); return; }
    await run('remote_notifications_configure', { origin: origin.trim(), token: token.trim() });
  }

  useEffect(() => {
    alive.current = true;
    if (isTauri()) void invoke<Status>('remote_notifications_status').then(next => { if (alive.current) setStatus(next); }).catch(() => undefined);
    return () => { alive.current = false; };
  }, []);

  if (!status?.supported) return null;
  const shown = failure === undefined ? status.error : failure;
  return <section className="tool-panel push-settings-panel remote-notifications" aria-label={t('remoteNotifTitle')}>
    <header><h3>{t('remoteNotifTitle')}</h3></header>
    <p>{t('remoteNotifIntro')}</p>
    {!status.configured && <fieldset disabled={busy}>
      <label>{t('remoteNotifOrigin')}
        <input type="url" placeholder="https://gotify.example.com" value={origin} onChange={event => setOrigin(event.target.value)} />
      </label>
      <label>{t('remoteNotifToken')}
        <input type="password" autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} maxLength={512} />
      </label>
      <p>{t('remoteNotifTokenHint')}</p>
      <button type="button" className="primary-button" disabled={!origin.trim() || !token} onClick={() => void connect()}>{t('remoteNotifConnect')}</button>
    </fieldset>}
    {status.configured && <>
      <p role="status">{t(status.running ? 'remoteNotifReceiving' : status.enabled ? 'remoteNotifStopped' : 'remoteNotifPaused', { origin: status.origin ?? '' })}</p>
      <div className="tool-actions">
        {status.enabled
          ? <button type="button" disabled={busy} onClick={() => void run('remote_notifications_pause')}>{t('remoteNotifPause')}</button>
          : <button type="button" disabled={busy} onClick={() => void run('remote_notifications_resume')}>{t('remoteNotifResume')}</button>}
        <button type="button" disabled={busy} onClick={() => void run('remote_notifications_forget')}>{t('remoteNotifForget')}</button>
      </div>
      <p>{t('remoteNotifForgetHint')}</p>
    </>}
    {shown ? <p role="alert">{errorText(shown)}</p> : null}
  </section>;
}

import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';

type RegistrationStatus = {
  supported: boolean;
  configured: boolean;
  enabled: boolean;
  tokenPresent: boolean;
  busy: boolean;
  reason: string;
};

export default function PushSettingsPanel() {
  const [status, setStatus] = useState<RegistrationStatus>();
  const [pending, setPending] = useState(false);
  const [activeCommand, setActiveCommand] = useState('');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
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
          ? 'Token revocation could not finish. Refresh status and retry when online.'
          : 'Native push registration is unavailable or the operation failed. Refresh status and retry.');
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
  return <section className="tool-panel" aria-label="Remote push registration">
    <h3>Remote push registration</h3>
    <p>Register this Android device with Google Firebase only if this build has a configured Firebase project. Registration alone does not connect a delivery service or send host events.</p>
    <p role="status">{!isTauri() ? 'Remote push registration requires the native app.' : status?.reason ?? 'Inspecting native push configuration…'}</p>
    <p>This control does not upload SSH credentials, transcripts, prompts or host addresses. Firebase receives a device registration identifier and application configuration. Local inbox notifications work separately.</p>
    {status?.supported && status.configured && !status.enabled && <label>
      <input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} />
      I agree to contact Google Firebase to register this device.
    </label>}
    <div className="tool-actions">
      <button type="button" onClick={() => void run('push_registration_status')} disabled={!isTauri() || pending}>Refresh registration status</button>
      {status?.supported && status.configured && <button type="button" onClick={() => void run('push_registration_register')} disabled={busy || (!status.enabled && !consent)}>
        {status.enabled ? 'Refresh device registration' : 'Register this device'}
      </button>}
      {status?.supported && (status.enabled || status.tokenPresent || activeCommand === 'push_registration_register') && <button type="button" onClick={() => void run('push_registration_disable')} disabled={pending && activeCommand !== 'push_registration_register'}>
        {status.enabled || activeCommand === 'push_registration_register' ? 'Pause and revoke token' : 'Retry token revocation'}
      </button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </section>;
}

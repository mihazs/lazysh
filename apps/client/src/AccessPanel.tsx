import { useState } from 'react';
import { accessControl, accessSnapshot, applyAccessStatus, useAccessSnapshot } from './access';

export default function AccessPanel() {
  const { status } = useAccessSnapshot();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function configure(enabled: boolean) {
    if (!status?.supported || busy) return;
    const epoch = accessSnapshot().epoch;
    setBusy(true); setError('');
    try {
      const value = await accessControl.configure(enabled);
      // A later native lock event wins over any older configure response.
      if (accessSnapshot().epoch === epoch) applyAccessStatus(value);
    } catch {
      if (accessSnapshot().epoch === epoch) setError('Device authentication did not complete. App lock settings were not changed.');
    } finally { if (accessSnapshot().epoch === epoch) setBusy(false); }
  }
  return <section aria-label="App lock settings"><h3>App lock</h3>
    <p>Require device authentication when returning to lazysh. Native device security protects access; changing this setting requires fresh authentication.</p>
    {status?.supported && <p>Disable app lock before changing enrolled biometrics. This preview has no recovery option if the device proof becomes invalid, and the app can remain locked.</p>}
    <label><input type="checkbox" checked={status?.enabled ?? false} disabled={!status?.supported || busy}
      onChange={event => void configure(event.target.checked)} />Lock when returning to the app</label>
    {!status?.supported && <p>{status?.reason || 'App lock is unavailable on this platform.'}</p>}
    {busy && <p role="status">Waiting for device authentication…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

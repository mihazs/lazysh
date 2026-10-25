import { useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { captureAccess, useProtectedInvoke } from './access';

type Icon = 'default' | 'amber';
type IconStatus = { available: boolean; current: Icon | 'unknown'; reason: string };
const unavailable: IconStatus = { available: false, current: 'unknown', reason: 'Alternate Home Screen icons require the iOS app.' };
function parseStatus(value: unknown): IconStatus {
  if (!value || typeof value !== 'object') throw new Error('Cannot read the current app icon.');
  const row = value as Record<string, unknown>;
  if (typeof row.available !== 'boolean' || typeof row.current !== 'string' || !['default', 'amber', 'unknown'].includes(String(row.current))
    || typeof row.reason !== 'string' || row.reason.length > 512) throw new Error('Cannot read the current app icon.');
  return row as IconStatus;
}
export default function AppIconPanel() {
  const invoke = useProtectedInvoke();
  const lease = useRef(captureAccess()).current;
  const alive = useRef(true);
  const [status, setStatus] = useState<IconStatus>();
  const [choice, setChoice] = useState<Icon>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const changing = useRef(false);
  const currentRequest = (request: number) => alive.current && lease.current() && generation.current === request;
  async function read() {
    if (!alive.current || !lease.current()) return;
    const current = ++generation.current;
    try {
      const actual = isTauri() ? parseStatus(await invoke('app_icon_status')) : unavailable;
      if (currentRequest(current)) { setStatus(actual); if (actual.current !== 'unknown') setChoice(actual.current); }
    } catch { if (currentRequest(current)) { setStatus(undefined); setError('Cannot read the current app icon. Try refreshing.'); } }
  }
  useEffect(() => {
    alive.current = true;
    void read();
    const resumed = () => { if (!document.hidden && !changing.current) void read(); };
    window.addEventListener('focus', resumed);
    document.addEventListener('visibilitychange', resumed);
    return () => { alive.current = false; generation.current++; window.removeEventListener('focus', resumed); document.removeEventListener('visibilitychange', resumed); };
  }, []);
  async function apply() {
    if (!alive.current || !lease.current() || changing.current || !status?.available) return;
    changing.current = true; setBusy(true); setError('');
    const current = ++generation.current;
    try {
      const actual = parseStatus(await invoke('set_app_icon', {icon: choice}));
      if (currentRequest(current)) { setStatus(actual); if (actual.current !== 'unknown') setChoice(actual.current); }
    } catch (error) {
      if (currentRequest(current)) {
        setError(error instanceof Error ? error.message : typeof error === 'string' ? error : 'iOS could not change the app icon.');
        await read();
      }
    } finally { if (alive.current && lease.current()) { changing.current = false; setBusy(false); } }
  }
  return <fieldset><legend>App icon</legend>
    <p>{status?.reason ?? 'Reading the current iOS icon…'}</p>
    {error && <p role="alert">{error}</p>}
    <p role="status">{`Current icon: ${status ? {default: 'Default', amber: 'Amber', unknown: 'Unknown — refresh before changing'}[status.current] : 'Unknown'}`}</p>
    <label>Home Screen icon<select value={choice} disabled={!status?.available || busy} onChange={event => setChoice(event.target.value as Icon)}>
      <option value="default">Default</option><option value="amber">Amber</option>
    </select></label>
    <button disabled={!status?.available || busy || status.current === choice} onClick={() => void apply()}>{busy ? 'Changing icon…' : 'Apply app icon'}</button>
    <button disabled={busy} onClick={() => { setError(''); void read(); }}>Refresh app icon</button>
    <p>Device-local iOS setting. It does not change terminal themes or sync to other devices.</p>
  </fieldset>;
}

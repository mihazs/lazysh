import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { errorMessage } from './SessionTools';
import { validateCloudSnapshot, validCloudOrigin, type CloudSnapshot } from './cloudVoice';

export default function CloudVoiceSettingsPanel({ snapshot, onSnapshot, disabled, onBusy }: {
  snapshot?: CloudSnapshot; onSnapshot: (snapshot: CloudSnapshot | undefined) => void;
  disabled: boolean; onBusy: (busy: boolean) => void;
}) {
  const [origin, setOrigin] = useState('');
  const [token, setToken] = useState('');
  const [configured, setConfigured] = useState(false);
  const [savedOrigin, setSavedOrigin] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  async function check(enroll = false, expectedOrigin = enroll ? origin : savedOrigin) {
    const current = ++generation.current;
    setChecking(true); onBusy(true); setError(''); onSnapshot(undefined);
    try {
      const value = validateCloudSnapshot(await invoke<CloudSnapshot>(enroll ? 'voice_cloud_enroll' : 'voice_cloud_refresh', enroll ? { origin, token } : undefined));
      if (current !== generation.current) return;
      if (value.origin !== expectedOrigin) throw new Error('Cloud service origin did not match the configured device.');
      setOrigin(value.origin); setSavedOrigin(value.origin); setConfigured(true); onSnapshot(value);
    } catch (e) { if (current === generation.current) setError(errorMessage(e)); }
    finally { if (current === generation.current) { setToken(''); setChecking(false); onBusy(false); } }
  }
  useEffect(() => {
    const clearToken = () => setToken('');
    const hidden = () => { if (document.visibilityState !== 'visible') clearToken(); };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', clearToken);
    const current = ++generation.current;
    onSnapshot(undefined); setChecking(true); onBusy(true);
    void invoke<{configured: boolean; origin?: string}>('voice_cloud_status').then(async status => {
      if (current !== generation.current) return;
      if (!status || typeof status.configured !== 'boolean' || (status.origin !== undefined && !validCloudOrigin(status.origin)) || (status.configured && !status.origin))
        throw new Error('Invalid Cloud configuration status.');
      setConfigured(status.configured); setOrigin(status.origin ?? ''); setSavedOrigin(status.origin ?? '');
      if (status.configured) await check(false, status.origin);
    }).catch(e => { if (current === generation.current) setError(errorMessage(e)); }).finally(() => {
      if (current === generation.current) { setChecking(false); onBusy(false); }
    });
    return () => {
      generation.current++; onBusy(false);
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', clearToken);
    };
  }, []);
  async function forget() {
    const current = ++generation.current;
    setChecking(true); onBusy(true); onSnapshot(undefined); setToken(''); setError('');
    try {
      await invoke('voice_cloud_forget');
      if (current === generation.current) { setConfigured(false); setOrigin(''); }
    } catch (e) { if (current === generation.current) setError(errorMessage(e)); }
    finally { if (current === generation.current) { setChecking(false); onBusy(false); } }
  }
  return <fieldset disabled={disabled || checking}>
    <legend>Cloud service</legend>
    <p>Cloud sends recorded audio to your configured service and its transcription provider. Metadata checks confirm service capabilities and audio quota, not provider account validity.</p>
    <label>Cloud service origin<input type="url" value={origin} placeholder="https://voice.example.com" onChange={event => {
      setOrigin(event.target.value); setToken(''); onSnapshot(undefined);
    }}/></label>
    <label>Device token<input type="password" autoComplete="off" value={token} onChange={event => {setToken(event.target.value); onSnapshot(undefined);}}/></label>
    <p>Import the 64-character device token issued by your administrator. Tokens are stored in the native credential vault.</p>
    <button disabled={!validCloudOrigin(origin) || !/^[0-9a-fA-F]{64}$/.test(token)} onClick={() => void check(true)}>Verify and save Cloud device</button>
    <button disabled={!configured || !!token || origin !== savedOrigin} onClick={() => void check()}>Refresh Cloud service</button>
    <button disabled={!configured} onClick={() => void forget()}>Forget Cloud device</button>
    {checking && <p role="status">Checking Cloud service…</p>}
    {error && <p role="alert">{error}</p>}
    {snapshot && <>
      <p>Service: {snapshot.origin} · Model: {snapshot.capabilities.model}</p>
      <p>Last checked: {new Date(snapshot.checkedAt).toLocaleString()}</p>
      <p>Service audio quota remaining: device {(snapshot.quota.deviceRemainingSamples / 16000).toFixed(1)} seconds; shared {(snapshot.quota.globalRemainingSamples / 16000).toFixed(1)} seconds.</p>
      <p>Service audio quota totals: device {(snapshot.quota.deviceLimitSamples / 16000).toFixed(1)} seconds; shared {(snapshot.quota.globalLimitSamples / 16000).toFixed(1)} seconds.</p>
      <p>Quota window (UTC): {new Date(snapshot.quota.windowStart * 1000).toISOString()} – {new Date(snapshot.quota.windowEnd * 1000).toISOString()}</p>
    </>}
  </fieldset>;
}

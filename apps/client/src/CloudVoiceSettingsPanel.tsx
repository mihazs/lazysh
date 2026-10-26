import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';

import {t, useUi, formatDateTime, formatNumber} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { validateCloudSnapshot, validCloudOrigin, type CloudSnapshot } from './cloudVoice';

export default function CloudVoiceSettingsPanel({ snapshot, onSnapshot, disabled, onBusy }: {
  snapshot?: CloudSnapshot; onSnapshot: (snapshot: CloudSnapshot | undefined) => void;
  disabled: boolean; onBusy: (busy: boolean) => void;
}) {
  useUi();
  const invoke = useProtectedInvoke();
  const [origin, setOrigin] = useState('');
  const [token, setToken] = useState('');
  const [configured, setConfigured] = useState(false);
  const [savedOrigin, setSavedOrigin] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<UiErrorCause>('');
  const generation = useRef(0);
  async function check(enroll = false, expectedOrigin = enroll ? origin : savedOrigin) {
    const current = ++generation.current;
    setChecking(true); onBusy(true); setError(''); onSnapshot(undefined);
    try {
      const value = validateCloudSnapshot(await invoke<CloudSnapshot>(enroll ? 'voice_cloud_enroll' : 'voice_cloud_refresh', enroll ? { origin, token } : undefined));
      if (current !== generation.current) return;
      if (value.origin !== expectedOrigin) throw new LocalUiError('cloudOriginMismatch');
      setOrigin(value.origin); setSavedOrigin(value.origin); setConfigured(true); onSnapshot(value);
    } catch (e) { if (current === generation.current) setError(captureUiError(e)); }
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
        throw new LocalUiError('cloudInvalidStatus');
      setConfigured(status.configured); setOrigin(status.origin ?? ''); setSavedOrigin(status.origin ?? '');
      if (status.configured) await check(false, status.origin);
    }).catch(e => { if (current === generation.current) setError(captureUiError(e)); }).finally(() => {
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
    } catch (e) { if (current === generation.current) setError(captureUiError(e)); }
    finally { if (current === generation.current) { setChecking(false); onBusy(false); } }
  }
  const checkedAt = snapshot ? new Date(snapshot.checkedAt) : undefined;
  return <fieldset disabled={disabled || checking}>
    <legend>{t('cloudSettingsTitle')}</legend>
    <p>{t('cloudSettingsPrivacy')}</p>
    <label>{t('cloudSettingsOrigin')}<input type="url" value={origin} placeholder="https://voice.example.com" onChange={event => {
      setOrigin(event.target.value); setToken(''); onSnapshot(undefined);
    }}/></label>
    <label>{t('cloudSettingsToken')}<input type="password" autoComplete="off" value={token} onChange={event => {setToken(event.target.value); onSnapshot(undefined);}}/></label>
    <p>{t('cloudSettingsTokenHint')}</p>
    <button disabled={!validCloudOrigin(origin) || !/^[0-9a-fA-F]{64}$/.test(token)} onClick={() => void check(true)}>{t('cloudSettingsVerify')}</button>
    <button disabled={!configured || !!token || origin !== savedOrigin} onClick={() => void check()}>{t('cloudSettingsRefresh')}</button>
    <button disabled={!configured} onClick={() => void forget()}>{t('cloudSettingsForget')}</button>
    {checking && <p role="status">{t('cloudSettingsChecking')}</p>}
    {error && <p role="alert">{uiErrorText(error)}</p>}
    {snapshot && <>
      <p>{t('cloudSettingsServiceModel',{origin:snapshot.origin,model:snapshot.capabilities.model})}</p>
      <p>{t('cloudSettingsChecked',{time:checkedAt && Number.isFinite(checkedAt.getTime()) ? formatDateTime(checkedAt) : t('unavailable')})}</p>
      <p>{t('cloudSettingsRemaining',{device:formatNumber(snapshot.quota.deviceRemainingSamples / 16000,{minimumFractionDigits:1,maximumFractionDigits:1}),shared:formatNumber(snapshot.quota.globalRemainingSamples / 16000,{minimumFractionDigits:1,maximumFractionDigits:1})})}</p>
      <p>{t('cloudSettingsTotals',{device:formatNumber(snapshot.quota.deviceLimitSamples / 16000,{minimumFractionDigits:1,maximumFractionDigits:1}),shared:formatNumber(snapshot.quota.globalLimitSamples / 16000,{minimumFractionDigits:1,maximumFractionDigits:1})})}</p>
      <p>{t('cloudSettingsWindow',{start:new Date(snapshot.quota.windowStart * 1000).toISOString(),end:new Date(snapshot.quota.windowEnd * 1000).toISOString()})}</p>
    </>}
  </fieldset>;
}

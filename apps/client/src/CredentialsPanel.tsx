import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';

import type { Credentials } from './bridge';

type KeyInfo = { publicKey: string; fingerprint: string; algorithm: string };
type GeneratedKey = { privateKey: string; info: KeyInfo };

export default function CredentialsPanel({ onUse }: { onUse: (credentials: Credentials) => void }) {
  useUi();
  const invoke = useProtectedInvoke();
  const [mode, setMode] = useState<'generate' | 'import'>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [info, setInfo] = useState<KeyInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiErrorCause>('');
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);

  function reset() { request.current++; setInfo(undefined); setBusy(false); setError(''); }
  async function inspect() {
    const current = ++request.current;
    setBusy(true); setError(''); setInfo(undefined);
    try {
      if (mode === 'generate') {
        const key = await invoke<GeneratedKey>('generate_identity', { passphrase });
        if (current !== request.current) return;
        setPrivateKey(key.privateKey); setInfo(key.info);
      } else {
        const key = await invoke<KeyInfo>('inspect_identity', { privateKey, passphrase: passphrase || null });
        if (current !== request.current) return;
        setInfo(key);
      }
    } catch (e) { if (current === request.current) setError(captureUiError(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function copyPublicKey() {
    if (!info) return;
    setError('');
    try { await navigator.clipboard.writeText(info.publicKey); }
    catch { setError(new LocalUiError('credentialsCopyFailed')); }
  }

  return <section className="tool-panel" aria-label={t('credentialsRegion')}>
    <h3>{t('credentialsHeading')}</h3>
    <p>{t('credentialsHint')}</p>
    <label>{t('credentialsSource')}<select value={mode} onChange={event => { reset(); setMode(event.target.value as typeof mode); setPrivateKey(''); setPassphrase(''); }}><option value="generate">{t('credentialsGenerateOption')}</option><option value="import">{t('credentialsImportOption')}</option></select></label>
    {mode === 'import' && <label>{t('appPrivateKey')}<textarea value={privateKey} maxLength={65536} autoComplete="off" spellCheck={false} onChange={event => { reset(); setPrivateKey(event.target.value); }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label>}
    <label>{t('credentialsPassphrase')}<input type="password" value={passphrase} maxLength={1024} autoComplete="new-password" onChange={event => { reset(); setPassphrase(event.target.value); }} /></label>
    {mode === 'generate' && <p>{t('credentialsPassphraseHint')}</p>}
    <button type="button" disabled={busy || (mode === 'generate' ? new TextEncoder().encode(passphrase).length < 12 : !privateKey.trim())} onClick={() => void inspect()}>{busy ? t('credentialsPreparing') : mode === 'generate' ? t('credentialsGenerate') : t('credentialsInspect')}</button>
    {error && <p role="alert" className="inline-error">{uiErrorText(error)}</p>}
    {info && <div className="identity-details"><p>{info.algorithm} · <code>{info.fingerprint}</code></p><label>{t('credentialsPublicKey')}<textarea readOnly value={info.publicKey} spellCheck={false} /></label><button type="button" onClick={() => void copyPublicKey()}>{t('credentialsCopyPublic')}</button><button type="button" onClick={() => { onUse({ privateKey, passphrase }); setPrivateKey(''); setPassphrase(''); setInfo(undefined); }}>{t('credentialsUse')}</button></div>}
    <p>{t('credentialsMemory')}</p>
  </section>;
}

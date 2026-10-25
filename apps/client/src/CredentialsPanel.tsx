import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { Credentials } from './bridge';
import { errorMessage } from './SessionTools';

type KeyInfo = { publicKey: string; fingerprint: string; algorithm: string };
type GeneratedKey = { privateKey: string; info: KeyInfo };

export default function CredentialsPanel({ onUse }: { onUse: (credentials: Credentials) => void }) {
  const [mode, setMode] = useState<'generate' | 'import'>('generate');
  const [privateKey, setPrivateKey] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [info, setInfo] = useState<KeyInfo>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    } catch (e) { if (current === request.current) setError(errorMessage(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function copyPublicKey() {
    if (!info) return;
    setError('');
    try { await navigator.clipboard.writeText(info.publicKey); }
    catch { setError('Could not copy the public key. Select and copy it manually.'); }
  }

  return <section className="tool-panel" aria-label="SSH key management">
    <h3>SSH identities</h3>
    <p>Generate an encrypted Ed25519 identity or inspect an existing private key. Copy the public key to your host’s authorized keys.</p>
    <label>Identity source<select value={mode} onChange={event => { reset(); setMode(event.target.value as typeof mode); setPrivateKey(''); setPassphrase(''); }}><option value="generate">Generate Ed25519</option><option value="import">Import private key</option></select></label>
    {mode === 'import' && <label>Private key<textarea value={privateKey} maxLength={65536} autoComplete="off" spellCheck={false} onChange={event => { reset(); setPrivateKey(event.target.value); }} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" /></label>}
    <label>Key passphrase<input type="password" value={passphrase} maxLength={1024} autoComplete="new-password" onChange={event => { reset(); setPassphrase(event.target.value); }} /></label>
    {mode === 'generate' && <p>New identities require a passphrase of at least 12 bytes.</p>}
    <button type="button" disabled={busy || (mode === 'generate' ? new TextEncoder().encode(passphrase).length < 12 : !privateKey.trim())} onClick={() => void inspect()}>{busy ? 'Preparing identity…' : mode === 'generate' ? 'Generate encrypted identity' : 'Inspect identity'}</button>
    {error && <p role="alert" className="inline-error">{error}</p>}
    {info && <div className="identity-details"><p>{info.algorithm} · <code>{info.fingerprint}</code></p><label>Public key<textarea readOnly value={info.publicKey} spellCheck={false} /></label><button type="button" onClick={() => void copyPublicKey()}>Copy public key</button><button type="button" onClick={() => { onUse({ privateKey, passphrase }); setPrivateKey(''); setPassphrase(''); setInfo(undefined); }}>Use for connection</button></div>}
    <p>Keys stay in memory here. Save credentials for a host using its connection dialog to use the OS credential store.</p>
  </section>;
}

import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { errorMessage } from './SessionTools';

type Action = { type: 'newTab'; name: string; directory: string } | { type: 'goToTab'; index: number } | { type: 'nextTab' | 'previousTab' | 'zoomPane' } | { type: 'newPane'; horizontal: boolean; directory: string };
export default function ZellijPanel({ sessionId, name, projectDirectory = '.' }: { sessionId: string; name: string; projectDirectory?: string }) {
  const invoke = useProtectedInvoke();
  const [title, setTitle] = useState('');
  const [directory, setDirectory] = useState('.');
  const [tab, setTab] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const lock = useRef(false);
  useEffect(() => setDirectory(projectDirectory), [projectDirectory]);
  async function run(action: Action) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await invoke('zellij_action', { sessionId, name, action }); setMessage('Action sent to Zellij.'); }
    catch (e) { setError(errorMessage(e)); }
    finally { lock.current = false; setBusy(false); }
  }
  function create(event: FormEvent) { event.preventDefault(); if (title.trim()) void run({ type: 'newTab', name: title, directory }); }
  return <section aria-label={`Zellij ${name} controls`}><h3>Zellij: {name}</h3><p>Pane controls apply to the focused pane in this named session.</p>
    {error && <p className="inline-error" role="alert">{error}</p>}{(busy || message) && <p role="status">{busy ? 'Sending action…' : message}</p>}
    <form onSubmit={create}><label>New tab name<input value={title} maxLength={200} disabled={busy} required onChange={e => setTitle(e.target.value)} /></label><label>Zellij project directory<input value={directory} maxLength={4096} disabled={busy} required onChange={e => setDirectory(e.target.value)} /></label><button className="subtle-button" disabled={busy || !title.trim()} type="submit">Create Zellij tab</button></form>
    <div className="tool-bar"><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'previousTab' })}>Previous Zellij tab</button><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'nextTab' })}>Next Zellij tab</button></div>
    <form onSubmit={e => { e.preventDefault(); void run({ type: 'goToTab', index: tab }); }}><label>Tab number<input type="number" min={1} max={1000} value={tab} disabled={busy} onChange={e => setTab(Number(e.target.value))} /></label><button className="subtle-button" disabled={busy || !Number.isInteger(tab) || tab < 1 || tab > 1000}>Select Zellij tab</button></form>
    <div className="tool-bar"><button className="subtle-button" disabled={busy || !directory} onClick={() => void run({ type: 'newPane', horizontal: true, directory })}>Split Zellij right</button><button className="subtle-button" disabled={busy || !directory} onClick={() => void run({ type: 'newPane', horizontal: false, directory })}>Split Zellij down</button><button className="subtle-button" disabled={busy} onClick={() => void run({ type: 'zoomPane' })}>Zoom Zellij pane</button></div>
  </section>;
}

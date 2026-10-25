import { useEffect, useRef, useState } from 'react';
import { api as nativeApi, type TmuxJumpSnapshot } from './bridge';
import { captureAccess, useProtectedApi } from './access';
import { errorMessage } from './SessionTools';

export default function TmuxJumpPanel({ sessionId, onClose, onJump }: {
  sessionId: string; onClose: () => void; onJump: (snapshot: TmuxJumpSnapshot) => void;
}) {
  const api = useProtectedApi(nativeApi);
  const access = useRef(captureAccess()).current;
  const [snapshot, setSnapshot] = useState<TmuxJumpSnapshot | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState(() => {
    try { const value = localStorage.getItem('lazysh.multiplexer.layout'); return ['list', 'accordion', 'grid'].includes(value ?? '') ? value! : 'list'; }
    catch { return 'list'; }
  });
  const revision = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const request = ++revision.current;
    if (!access.current()) return;
    setSnapshot(null); setBusy(true); setError(''); pending.current = true;
    void api.tmuxJumpSnapshot(sessionId).then(value => {
      if (access.current() && revision.current === request) setSnapshot(value);
    }).catch(reason => {
      if (access.current() && revision.current === request) setError(errorMessage(reason));
    }).finally(() => {
      if (access.current() && revision.current === request) { pending.current = false; setBusy(false); }
    });
    return () => { revision.current++; };
  }, [sessionId]);
  useEffect(() => {
    if (!access.current()) return;
    try { localStorage.setItem('lazysh.multiplexer.layout', layout); } catch { /* Layout works without persistence. */ }
  }, [layout]);
  async function jump(targetSessionId: string, windowId: string) {
    if (!access.current() || pending.current || !snapshot) return;
    if (snapshot.current.sessionId === targetSessionId && snapshot.current.windowId === windowId) { onClose(); return; }
    pending.current = true; setBusy(true); setError('');
    const request = revision.current;
    try {
      const result = await api.tmuxJump(sessionId, snapshot.generation, targetSessionId, windowId);
      if (access.current() && revision.current === request) { onJump(result); onClose(); }
    } catch (reason) {
      if (access.current() && revision.current === request) {
        // Never allow another action against a failed or retired binding's snapshot.
        setSnapshot(null); setError(errorMessage(reason));
      }
    } finally {
      if (access.current() && revision.current === request) { pending.current = false; setBusy(false); }
    }
  }
  return <section className="multiplexer-panel" aria-label="tmux Jump To">
    <div className="tool-bar"><label>Jump To layout<select value={layout} onChange={event => { if (access.current()) setLayout(event.target.value); }}>
      <option value="list">List</option><option value="accordion">Accordion</option><option value="grid">Grid</option>
    </select></label></div>
    {busy && <p role="status">Reading tmux destinations…</p>}
    {error && <p role="alert">Jump To unavailable: {error}</p>}
    <div className={`mux-list mux-layout-${layout}`}>{snapshot?.sessions.map(session => <details key={`${layout}:${session.id}`} open={layout !== 'accordion' || session.id === snapshot.current.sessionId}>
      <summary>{session.name}</summary>
      {session.windows.map(window => {
        const current = session.id === snapshot.current.sessionId && window.id === snapshot.current.windowId;
        return <div className="mux-row" key={window.id}><button className="subtle-button" disabled={busy} aria-current={current ? 'location' : undefined} onClick={() => void jump(session.id, window.id)}>
          {window.index}: {window.name}{current ? ' · Current' : ''}
        </button></div>;
      })}
    </details>)}</div>
    <p>Jumping changes this client's session and the destination session's current window.</p>
  </section>;
}

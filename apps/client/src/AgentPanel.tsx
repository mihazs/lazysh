import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';

import { Bot, RefreshCw } from 'lucide-react';
import ApprovalPanel from './ApprovalPanel';
import CompanionSettingsPanel from './CompanionSettingsPanel';

type AgentState = 'working' | 'needs_attention' | 'done';
type AgentSession = {
  sessionId: string;
  agent: string;
  project: string;
  state: AgentState;
  updatedAt: string;
  summary: string;
  paneId: string | null;
  eventCount: number;
};
const states: AgentState[] = ['needs_attention', 'working', 'done'];
const names: Record<AgentState, string> = { needs_attention: 'Needs you', working: 'Working', done: 'Done' };

export function parseSnapshot(value: unknown): AgentSession[] {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('sessions' in value) || !Array.isArray(value.sessions) || value.sessions.length > 100) {
    throw new Error('Unsupported agent snapshot. Update the host companion.');
  }
  return value.sessions.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid agent session.');
    const row = item as Record<string, unknown>;
    for (const key of ['sessionId', 'agent', 'project', 'updatedAt', 'summary']) {
      if (typeof row[key] !== 'string' || row[key].length > 4096) throw new Error('Invalid agent session.');
    }
    if (!states.includes(row.state as AgentState) || !Number.isFinite(Date.parse(row.updatedAt as string)) || !Number.isSafeInteger(row.eventCount) || Number(row.eventCount) < 1 || (row.paneId !== null && typeof row.paneId !== 'string')) {
      throw new Error('Invalid agent session.');
    }
    return row as AgentSession;
  });
}

export function AgentPanel({ sessionId }: { sessionId: string }) {
  const invoke = useProtectedInvoke();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadedSessionId, setLoadedSessionId] = useState<string>();
  const request = useRef(0);

  async function refresh() {
    const current = ++request.current;
    setBusy(true); setError('');
    try {
      const value = await invoke<unknown>('agent_snapshot', { sessionId });
      const rows = parseSnapshot(value);
      if (current === request.current) { setSessions(rows); setLoaded(true); setLoadedSessionId(sessionId); }
    } catch (e) {
      if (current === request.current) setError(e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e));
    } finally { if (current === request.current) setBusy(false); }
  }
  useEffect(() => { setSessions([]); setLoaded(false); void refresh(); return () => { request.current++; }; }, [sessionId]);

  return <section className="tool-panel" aria-label="Agent activity">
    <ApprovalPanel sessionId={sessionId} />
    {loaded && loadedSessionId === sessionId && !error && <CompanionSettingsPanel key={sessionId} sessionId={sessionId} />}
    <div className="tool-bar"><h3>Agent activity</h3><button className="subtle-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />{busy ? 'Refreshing…' : 'Refresh'}</button></div>
    <p className="agent-note">Last reported events from this host. Respond to agent prompts in the terminal.</p>
    {error && <div className="agent-setup"><p className="inline-error" role="alert">{error}</p><h3>Connect your agents.</h3><p>Install the optional <code>lazysh-agent</code> companion on this host and enable its lifecycle hooks. Your terminal works independently.</p><p>See <code>docs/companion.md</code> in the lazysh repository for setup.</p></div>}
    {busy && <p className="loading" role="status">Reading events over SSH…</p>}
    {!busy && !error && loaded && sessions.length === 0 && <div className="panel-empty"><Bot size={28} /><h3>No agent events yet.</h3><p>The companion is connected. Start an agent<br />with lifecycle hooks to see its activity here.</p></div>}
    {sessions.length > 0 && <div className="agent-board">{states.map(state => <section key={state} aria-label={names[state]} className="agent-column"><h4>{names[state]} <span>{sessions.filter(s => s.state === state).length}</span></h4>{sessions.filter(s => s.state === state).map(s => <article className="agent-card" key={`${s.agent}:${s.sessionId}`}><strong><Bot size={16} /> {s.agent}</strong><p>{s.summary}</p><code title={s.project}>{s.project}</code><small>Reported <time dateTime={s.updatedAt}>{new Date(s.updatedAt).toLocaleString()}</time></small>{s.paneId && <small>Pane {s.paneId} · {s.eventCount} events</small>}</article>)}</section>)}</div>}
  </section>;
}

export default AgentPanel;

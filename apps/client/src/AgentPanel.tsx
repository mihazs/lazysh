import {t, useUi, formatDateTime, formatNumber} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';

import { Bot, RefreshCw } from 'lucide-react';
import ApprovalPanel from './ApprovalPanel';
import KeepAwakeControl from './KeepAwakeControl';
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
const names = {needs_attention:'agentsNeedsYou',working:'agentsWorking',done:'agentsDone'} as const;

export function parseSnapshot(value: unknown): AgentSession[] {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('sessions' in value) || !Array.isArray(value.sessions) || value.sessions.length > 100) {
    throw new LocalUiError('agentsUnsupportedSnapshot');
  }
  return value.sessions.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new LocalUiError('agentsInvalidSession');
    const row = item as Record<string, unknown>;
    for (const key of ['sessionId', 'agent', 'project', 'updatedAt', 'summary']) {
      if (typeof row[key] !== 'string' || row[key].length > 4096) throw new LocalUiError('agentsInvalidSession');
    }
    if (!states.includes(row.state as AgentState) || !Number.isFinite(Date.parse(row.updatedAt as string)) || !Number.isSafeInteger(row.eventCount) || Number(row.eventCount) < 1 || (row.paneId !== null && typeof row.paneId !== 'string')) {
      throw new LocalUiError('agentsInvalidSession');
    }
    return row as AgentSession;
  });
}

export function AgentPanel({ sessionId }: { sessionId: string }) {
  useUi();
  const invoke = useProtectedInvoke();
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<UiErrorCause>('');
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
      if (current === request.current) setError(captureUiError(e));
    } finally { if (current === request.current) setBusy(false); }
  }
  useEffect(() => { setSessions([]); setLoaded(false); void refresh(); return () => { request.current++; }; }, [sessionId]);

  return <section className="tool-panel" aria-label={t('agentsTitle')}>
    <KeepAwakeControl sessionId={sessionId} />
    <ApprovalPanel sessionId={sessionId} />
    {loaded && loadedSessionId === sessionId && !error && <CompanionSettingsPanel key={sessionId} sessionId={sessionId} />}
    <div className="tool-bar"><h3>{t('agentsTitle')}</h3><button className="subtle-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />{busy ? t('agentsRefreshing') : t('agentsRefresh')}</button></div>
    <p className="agent-note">{t('agentsReportedHint')}</p>
    {error && <div className="agent-setup"><p className="inline-error" role="alert">{uiErrorText(error)}</p><h3>{t('agentsConnect')}</h3><p>{t('agentsSetup')}</p><p>{t('agentsSetupDocs',{path:'docs/companion.md'})}</p></div>}
    {busy && <p className="loading" role="status">{t('agentsReading')}</p>}
    {!busy && !error && loaded && sessions.length === 0 && <div className="panel-empty"><Bot size={28} /><h3>{t('agentsEmpty')}</h3><p>{t('agentsEmptyHint')}</p></div>}
    {sessions.length > 0 && <div className="agent-board">{states.map(state => <section key={state} aria-label={t(names[state])} className="agent-column"><h4>{t(names[state])} <span>{formatNumber(sessions.filter(s => s.state === state).length)}</span></h4>{sessions.filter(s => s.state === state).map(s => <article className="agent-card" key={`${s.agent}:${s.sessionId}`}><strong><Bot size={16} /> {s.agent}</strong><p>{s.summary}</p><code title={s.project}>{s.project}</code><small><time dateTime={s.updatedAt}>{t('agentsReported',{time:formatDateTime(new Date(s.updatedAt))})}</time></small>{s.paneId && <small>{t('agentsPaneEvents',{pane:s.paneId,events:formatNumber(s.eventCount)})}</small>}</article>)}</section>)}</div>}
  </section>;
}

export default AgentPanel;

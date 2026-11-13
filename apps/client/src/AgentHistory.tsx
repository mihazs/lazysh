import {useEffect, useState} from 'react';
import {formatRelativeTime} from './relativeTime';
import {t} from './i18n/core';

export type HistoryItem = {agent: 'claude' | 'codex'; sessionId: string; path: string; title?: string; modifiedAt: string; bytes: number};
const agents = [['claude', 'Claude Code'], ['codex', 'Codex']] as const;
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value) ? value : undefined;

/** Keeps the rows of a companion reply that are well formed; a malformed row is dropped on its own. */
export function parseHistory(value: unknown, agent: HistoryItem['agent']): HistoryItem[] {
  const sessions = (value as {schemaVersion?: unknown; sessions?: unknown} | null)?.sessions;
  if (!Array.isArray(sessions)) throw new Error('history');
  return sessions.slice(0, 100).flatMap((row): HistoryItem[] => {
    const item = row as Record<string, unknown> | null;
    const sessionId = text(item?.sessionId, 128), path = text(item?.path, 4096), modifiedAt = text(item?.modifiedAt, 64);
    if (!item || !sessionId || !path || !modifiedAt || Number.isNaN(Date.parse(modifiedAt)) || item.agent !== agent) return [];
    return [{agent, sessionId, path, modifiedAt, bytes: typeof item.bytes === 'number' ? item.bytes : 0, ...(text(item.title, 200) ? {title: text(item.title, 200)} : {})}];
  });
}

/** The earlier Claude Code and Codex sessions of the folder, newest first. Opening one reads it; nothing is replayed or resumed from here. */
export default function AgentHistory({sessionId, folder, invoke, onOpen, onClose}: {sessionId: string; folder: string; invoke: Invoke; onOpen: (item: HistoryItem) => void; onClose: () => void}) {
  const [state, setState] = useState<{kind: 'loading'} | {kind: 'failed'} | {kind: 'ready'; items: HistoryItem[]}>({kind: 'loading'});
  useEffect(() => {
    let alive = true;
    setState({kind: 'loading'});
    void Promise.all(agents.map(([agent]) => invoke<unknown>('agent_history', {sessionId, agent, folder}).then(reply => parseHistory(reply, agent))))
      .then(lists => alive && setState({kind: 'ready', items: lists.flat().sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt))}), () => alive && setState({kind: 'failed'}));
    return () => {alive = false;};
  }, [sessionId, folder, invoke]);
  return <section className="agent-view-picker agent-history" aria-label={t('agentHistoryTitle')}>
    <h3>{t('agentHistoryTitle')}</h3>
    {state.kind === 'loading' && <p role="status">{t('agentHistoryLoading')}</p>}
    {state.kind === 'failed' && <p role="alert">{t('agentHistoryFailed')}</p>}
    {state.kind === 'ready' && !state.items.length && <p role="status">{t('agentHistoryEmpty')}</p>}
    {state.kind === 'ready' && state.items.map(item => <button type="button" key={`${item.agent}:${item.sessionId}`} onClick={() => onOpen(item)}>
      {agents.find(([agent]) => agent === item.agent)![1]} · {item.title ?? item.sessionId.slice(0, 8)} · {formatRelativeTime(item.modifiedAt)}
    </button>)}
    <button type="button" className="subtle-button" onClick={onClose}>{t('agentHistoryClose')}</button>
  </section>;
}

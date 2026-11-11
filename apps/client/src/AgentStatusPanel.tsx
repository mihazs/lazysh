import {useId, useMemo, useState} from 'react';
import {ChevronDown, ChevronRight} from 'lucide-react';
import {deriveStatus, runningOf, type StatusItem, type StatusKind} from './agentStatus';
import {formatNumber, t} from './i18n/core';
import {formatCountdown, useNow} from './relativeTime';
import './AgentStatusPanel.css';

type Shape = Parameters<typeof deriveStatus>[0];
const shown = 3;
const kinds = {shell: 'agentStatusShells', monitor: 'agentStatusMonitors', agent: 'agentStatusAgents', workflow: 'agentStatusWorkflows'} as const;
const states = {running: 'agentStatusRunning', done: 'agentStatusDone', failed: 'agentStatusFailed', stopped: 'agentStatusStopped'} as const;

function Row({item, now}: {item: StatusItem; now: number}) {
  const end = item.endedAt ?? now, elapsed = item.startedAt !== undefined && end >= item.startedAt ? formatCountdown(end - item.startedAt) : undefined;
  return <li data-state={item.state}>
    <span className="agent-status-label">{item.label || t(kinds[item.kind], {count: 1})}</span>
    {item.type && <span className="agent-status-type">{item.type}</span>}
    <span className="agent-status-meta">{[t(states[item.state]), elapsed, item.tokens !== undefined && t('agentStatusTokens', {tokens: formatNumber(item.tokens, {notation: 'compact'})})].filter(Boolean).join(' · ')}</span>
    {item.detail && item.kind !== 'agent' && <small>{item.detail}</small>}
  </li>;
}

/** The area under the prompt in the Claude Code TUI: counters for background shells and monitors that open their list, and the
 * tree of sub-agents and workflows. Compact (one row) until opened; nothing while no background work runs. */
export default function AgentStatusPanel({messages}: {messages: Shape}) {
  const items = useMemo(() => deriveStatus(messages), [messages]);
  const live = items.some(item => item.state === 'running');
  const now = useNow(1000, live);
  const [open, setOpen] = useState(false), [more, setMore] = useState(false), [viewer, setViewer] = useState<StatusKind>();
  const treeId = useId(), viewerId = useId();
  if (!live) return null;
  const counters = (['shell', 'monitor'] as const).map(kind => [kind, runningOf(items, kind)] as const).filter(([, count]) => count > 0);
  const tree = items.filter(item => item.kind === 'agent' || item.kind === 'workflow').sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  const rows = more ? tree : tree.slice(0, shown);
  const listed = items.filter(item => item.kind === viewer);
  return <section className="agent-status" aria-label={t('agentStatusTitle')}>
    <div className="agent-status-bar">
      <button type="button" className="agent-status-toggle" aria-expanded={open} aria-controls={treeId} onClick={() => setOpen(value => !value)}>
        {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <span>{t('agentStatusRunningCount', {count: items.filter(item => item.state === 'running').length})}</span>
      </button>
      {counters.map(([kind, count]) => <button key={kind} type="button" className="agent-status-counter" aria-expanded={viewer === kind} aria-controls={viewerId}
        onClick={() => setViewer(current => current === kind ? undefined : kind)}>{t(kinds[kind], {count})}</button>)}
    </div>
    <div id={treeId} hidden={!open}>{open && <>
      {tree.length > 0 && <ul className="agent-status-tree">{rows.map(item => <Row key={item.id} item={item} now={now} />)}</ul>}
      {tree.length > shown && <button type="button" className="subtle-button" onClick={() => setMore(value => !value)}>{more ? t('agentStatusFewer') : t('agentStatusMore', {count: tree.length - shown})}</button>}
    </>}</div>
    <div id={viewerId} hidden={!viewer}>{viewer && <ul className="agent-status-tree" aria-label={t(kinds[viewer], {count: listed.length})}>{listed.map(item => <Row key={item.id} item={item} now={now} />)}</ul>}</div>
  </section>;
}

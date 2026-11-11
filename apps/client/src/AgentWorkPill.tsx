import {useId, useMemo, useState} from 'react';
import {Activity} from 'lucide-react';
import {settleWork, type WorkItem, type WorkKind, type WorkState} from './agentWork';
import {formatCountdown, useNow} from './relativeTime';
import {t} from './i18n/core';
import './AgentWork.css';

const kinds: WorkKind[] = ['agent', 'shell', 'monitor'];
const kindTitle = {agent: 'agentWorkAgents', shell: 'agentWorkShells', monitor: 'agentWorkMonitors'} as const;
const stateText = {running: 'agentWorkRunning', done: 'agentWorkDone', failed: 'agentWorkFailed', stopped: 'agentWorkStopped', unknown: 'agentWorkUnknown'} as const satisfies Record<WorkState, string>;

export function WorkRow({item, now, onOpen}: {item: WorkItem; now: number; onOpen?: (item: WorkItem) => void}) {
  const start = Date.parse(item.startedAt ?? ''), end = item.endedAt ? Date.parse(item.endedAt) : item.state === 'running' ? now : NaN;
  const elapsed = end >= start ? formatCountdown(end - start) : undefined;
  const more = item.command || item.events.length > 0 || item.summary;
  const head = <>
    <span className="agent-work-state" data-state={item.state}>{t(stateText[item.state])}</span>
    <strong>{item.title}</strong>
    {item.subtitle && <small>{item.subtitle}</small>}
    {elapsed && <small>{elapsed}</small>}
    {item.last && <span className="agent-work-last">{item.last}</span>}
  </>;
  return <li>{more
    ? <details><summary>{head}</summary>
      {item.command && <pre>{item.command}</pre>}
      {item.summary && <p>{item.summary}</p>}
      {item.events.length > 0 && <pre aria-label={t('agentWorkOutput')}>{item.events.join('\n')}</pre>}
    </details>
    : <div className="agent-work-head">{head}</div>}
    {item.childPath && onOpen && <button type="button" className="agent-work-open" onClick={() => onOpen(item)}>{t('agentWorkOpen')}</button>}</li>;
}

/** One recorded task where its call is in the conversation, in place of the raw tool block. */
export function WorkInline({item, onOpen}: {item: WorkItem; onOpen?: (item: WorkItem) => void}) {
  const now = useNow(1000, item.state === 'running');
  return <ul className="agent-work-inline"><WorkRow item={settleWork([item], now)[0]} now={now} onOpen={onOpen} /></ul>;
}

/** "2 running": sub-agents, background shells and monitors the conversation recorded, listed above the composer. */
export default function AgentWorkPill({work, onOpen}: {work?: readonly WorkItem[]; onOpen?: (item: WorkItem) => void}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const now = useNow(1000, open);
  const items = useMemo(() => settleWork(work ?? []), [work, now]);
  if (!items.length) return null;
  const count = (state: WorkState) => items.filter(item => item.state === state).length;
  const running = count('running'), unknown = count('unknown');
  const label = running ? t('agentWorkRunningCount', {count: running}) : unknown ? t('agentWorkUnknownCount', {count: unknown}) : t('agentWorkFinishedCount', {count: items.length});
  return <div className="agent-work">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)} data-running={running > 0 || undefined}>
      <Activity size={16} aria-hidden="true" /><span>{label}</span>
    </button>
    <div id={id} hidden={!open}>{open && kinds.map(kind => {
      const group = items.filter(item => item.kind === kind);
      return group.length > 0 && <section key={kind} aria-label={t(kindTitle[kind])}>
        <h5>{t(kindTitle[kind])}</h5>
        <ul>{group.map(item => <WorkRow key={item.id} item={item} now={now} onOpen={onOpen} />)}</ul>
      </section>;
    })}</div>
  </div>;
}

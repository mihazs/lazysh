import {useEffect, useMemo, useRef, useState} from 'react';
import {invoke} from '@tauri-apps/api/core';
import {Bot, RefreshCw} from 'lucide-react';
import {formatNumber, t, useUi} from './i18n/core';
import {captureUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {captureAccess} from './access';
import {isArchived, readArchives} from './agentArchive';
import {readHostNames, withNames} from './agentSessionNames';
import {parseReports, projectGroups, reportKey, reportLabel, reportedStateNames, states, type AgentSession, type AgentState} from './agentReports';
import {ReportRowContent, SearchField, StateFilter} from './AgentReportParts';
import {dispatchInboxOpen} from './notificationStore';
import {pathBasename, useNow} from './relativeTime';

/** One connected host: the session that reads its companion and the saved host that owns its archive. */
export type BoardHost = Readonly<{sessionId: string; hostKey: string; hostLabel: string}>;
type HostResult = Readonly<{rows: readonly AgentSession[]; error: UiErrorCause}>;

// The same budget as the inbox monitor: up to 32 hosts, four reads at once. The board polls as often as a single host's board.
const maxHosts = 32;
const parallelReads = 4;
const pollMs = 5000;
// Reads outlive a board unmount. Share slots across instances until the real IPC settles.
const activeReads = new Set<string>();
const schedulers = new Set<() => void>();

/** One connection per saved host: two sessions of a host reach the same companion, so the first one reads for both. */
export function distinctHosts(hosts: readonly BoardHost[]): BoardHost[] {
  return hosts.filter((host, index) => hosts.findIndex(other => other.hostKey === host.hostKey) === index);
}

/**
 * Reported activity of every connected host, grouped by state, then host, then project. Each host is read, archived and
 * opened through its own connection; a host that fails shows its own error and never empties the others.
 * Archiving stays on each host's own board, so this board only hides what that board archived.
 */
export default function AllHostsBoard({hosts, visible, onOpen}: {hosts: readonly BoardHost[]; visible: boolean; onOpen: () => void}) {
  useUi();
  const [access] = useState(captureAccess);
  const shown = hosts.slice(0, maxHosts);
  const signature = shown.map(host => host.sessionId).join('\n');
  const current = useRef(shown);
  current.current = shown;
  const [results, setResults] = useState<Readonly<Record<string, HostResult>>>({});
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AgentState | 'all'>('all');
  const pending = useRef<BoardHost[]>([]);
  const visibility = useRef(visible);
  visibility.current = visible;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    schedulers.add(pump);
    return () => { mounted.current = false; pending.current = []; schedulers.delete(pump); };
  }, []);

  function pump() {
    if (!mounted.current || !visibility.current || document.hidden || !access.current()) {
      pending.current = [];
      if (mounted.current) setBusy(activeReads.size > 0);
      return;
    }
    while (activeReads.size < parallelReads && pending.current.length > 0) {
      const host = pending.current.shift()!;
      if (!current.current.some(item => item.sessionId === host.sessionId) || activeReads.has(host.sessionId)) continue;
      activeReads.add(host.sessionId);
      void (async () => {
        let result: HostResult;
        // Hold the slot until native IPC settles, even if the lease changes meanwhile. The wrapper
        // rejects early on an epoch change; this read uses the captured headers and checks the lease
        // before dispatch (in pump) and again before publishing its result.
        try { result = {rows: parseReports(await invoke('agent_snapshot', {sessionId: host.sessionId}, {headers: access.headers})), error: ''}; }
        catch (error) { result = {rows: [], error: captureUiError(error)}; }
        activeReads.delete(host.sessionId);
        if (mounted.current && access.current() && current.current.some(item => item.sessionId === host.sessionId)) setResults(previous => ({...previous, [host.sessionId]: result}));
        for (const schedule of schedulers) schedule();
      })();
    }
    if (mounted.current) setBusy(activeReads.size > 0 || pending.current.length > 0);
  }

  function refresh() {
    if (!visibility.current || document.hidden || !access.current()) return;
    for (const host of current.current) {
      if (!activeReads.has(host.sessionId) && !pending.current.some(item => item.sessionId === host.sessionId)) pending.current.push(host);
    }
    pump();
  }
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [visible, signature]);

  // Read once per host set: nothing here writes an archive or a name, and the host boards own their changes.
  const archives = useMemo(() => readArchives(shown.map(host => host.hostKey)), [signature]);
  const names = useMemo(() => readHostNames(shown.map(host => host.hostKey)), [signature]);
  const entries = shown.flatMap(host => results[host.sessionId]?.error === '' ? withNames(results[host.sessionId].rows, names[host.hostKey] ?? {}).map(row => ({host, row})) : []);
  const listed = entries.filter(({host, row}) => !isArchived(archives[host.hostKey] ?? [], row));
  const term = query.trim().toLowerCase();
  const matching = listed.filter(({host, row}) => [row.agent, row.project, row.summary, row.title ?? '', host.hostLabel].some(value => value.toLowerCase().includes(term)));
  const rows = matching.filter(({row}) => filter === 'all' || row.state === filter);
  const now = useNow(30000, visible && rows.length > 0);
  const failures = shown.filter(host => results[host.sessionId]?.error);
  const answered = shown.every(host => results[host.sessionId]);
  const archived = entries.length - listed.length;

  return <>
    <div className="tool-bar"><h3>{t('agentsScopeAll')}</h3><SearchField query={query} onChange={setQuery}/><button type="button" className="icon-button agent-tool" title={t('agentsRefresh')} disabled={busy} aria-busy={busy} onClick={() => void refresh()}><RefreshCw size={18} aria-hidden="true"/><span className="sr-only">{t('agentsRefresh')}</span></button></div>
    {failures.map(host => <p key={host.sessionId} className="inline-error agent-host-error" role="alert"><strong>{host.hostLabel}</strong> {uiErrorText(results[host.sessionId].error)}</p>)}
    <div className="agent-discovery">
      <StateFilter filter={filter} onChange={setFilter} count={state => matching.filter(({row}) => state === 'all' || row.state === state).length}/>
      <p className="agent-result-count" role="status">{t('agentsResultCount', {shown: formatNumber(rows.length), total: formatNumber(listed.length)})}</p>
      {(query !== '' || filter !== 'all') && <button className="subtle-button" onClick={() => { setQuery(''); setFilter('all'); }}>{t('agentsClearFilters')}</button>}
      {hosts.length > shown.length && <p className="agent-note">{t('agentsHostsLimited', {shown: formatNumber(shown.length), total: formatNumber(hosts.length)})}</p>}
      {archived > 0 && <p className="agent-note">{t('agentsAllHostsArchived', {total: formatNumber(archived)})}</p>}
      {listed.length > 0 && rows.length === 0 && <div className="panel-empty"><h4>{t('agentsNoMatches')}</h4><p>{t('agentsNoMatchesHint')}</p></div>}
    </div>
    {!answered && <p className="loading" role="status">{t('agentsReading')}</p>}
    {answered && entries.length === 0 && failures.length === 0 && <div className="panel-empty"><Bot size={28}/><h3>{t('agentsEmpty')}</h3><p>{t('agentsEmptyHint')}</p></div>}
    {rows.length > 0 && <div className="agent-board">{states.filter(state => rows.some(({row}) => row.state === state)).map(state => <section key={state} aria-label={t(reportedStateNames[state])} className="agent-column status-group" data-state={state}>
      <h4>{t(reportedStateNames[state])} <span className="status-group-count">{formatNumber(rows.filter(({row}) => row.state === state).length)}</span></h4>
      {shown.filter(host => rows.some(entry => entry.host === host && entry.row.state === state)).map(host => {
        const own = rows.filter(entry => entry.host === host && entry.row.state === state).map(entry => entry.row);
        return <section key={host.sessionId} className="agent-host-group" aria-label={host.hostLabel}>
          <h5 className="agent-project-heading"><span className="agent-project-name" title={host.hostLabel}>{host.hostLabel}</span><span className="status-group-count">{formatNumber(own.length)}</span></h5>
          {projectGroups(own).map(([project, group]) => <section key={project} className="agent-project-group" aria-label={t('agentsProjectGroup', {project: pathBasename(project), host: host.hostLabel})}>
            <h6 className="agent-project-heading"><span className="agent-project-name" title={project}>{pathBasename(project)}</span><span className="status-group-count">{formatNumber(group.length)}</span></h6>
            {group.map(row => <article className="agent-card" key={reportKey(row)}><button type="button" className="agent-report-row" aria-label={t('agentsOpenReport', {agent: reportLabel(row), project: row.project, host: host.hostLabel})} onClick={() => { dispatchInboxOpen({sessionId: host.sessionId, paneId: row.paneId, state: row.state, agent: row.agent}, 'activity'); onOpen(); }}><ReportRowContent row={row} now={now}/></button></article>)}
          </section>)}
        </section>;
      })}
    </section>)}</div>}
  </>;
}

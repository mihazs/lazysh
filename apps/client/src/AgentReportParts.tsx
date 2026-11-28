import type {ReactNode} from 'react';
import {ChevronRight, Search} from 'lucide-react';
import {formatDateTime, formatNumber, t} from './i18n/core';
import {StatusRing, agentKind, reportedTones} from './AgentStatus';
import {formatRelativeTime, pathBasename} from './relativeTime';
import {reportedStateNames, states, type AgentSession, type AgentState} from './agentReports';

/** What every board row shows: the session's name when it has one, the summary, its project, the agent, and a trailing detail. */
export function ReportSummary({row, children}: {row: AgentSession; children: ReactNode}) {
  return <span className="agent-row-body">{row.title ? <><span className="agent-row-summary" title={row.title}>{row.title}</span><span className="agent-row-detail">{row.summary}</span></> : <span className="agent-row-summary">{row.summary}</span>}<span className="row-tags"><span className="row-tag" data-tone="project" title={row.project}>{pathBasename(row.project)}</span><strong className="row-tag" data-agent-kind={agentKind(row.agent)}>{row.agent}</strong>{children}</span></span>;
}

/** The inside of a board row's button: status ring, summary, recency and the chevron. */
export function ReportRowContent({row, now}: {row: AgentSession; now: number}) {
  return <><StatusRing tone={reportedTones[row.state]}/><ReportSummary row={row}><small><time dateTime={row.updatedAt} title={t('agentsReported', {time: formatDateTime(new Date(row.updatedAt))})}>{formatRelativeTime(row.updatedAt, now)}</time></small></ReportSummary><ChevronRight className="row-chevron" size={18} aria-hidden="true"/></>;
}

export function SearchField({query, onChange}: {query: string; onChange: (query: string) => void}) {
  return <label className="agent-search"><Search size={16} aria-hidden="true"/><span className="sr-only">{t('agentsSearch')}</span><input type="search" value={query} placeholder={t('agentsSearchHint')} onChange={event => onChange(event.target.value)}/></label>;
}

/** The status chips; `count` is left out while the board has nothing to count. */
export function StateFilter({filter, onChange, count}: {filter: AgentState | 'all'; onChange: (state: AgentState | 'all') => void; count?: (state: AgentState | 'all') => number}) {
  return <div className="agent-filters" role="group" aria-label={t('agentsFilterStatus')}>
    {(['all', ...states] as const).map(state => <button type="button" className="filter-chip" key={state} aria-pressed={filter === state} onClick={() => onChange(state)}>{state === 'all' ? t('agentsAll') : t(reportedStateNames[state])} {count && <span>{formatNumber(count(state))}</span>}</button>)}
  </div>;
}

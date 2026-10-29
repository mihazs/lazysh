import {t, useUi, formatDateTime, formatNumber} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {bindProtectedInvoke,captureAccess,type AccessLease} from './access';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Bot, RefreshCw } from 'lucide-react';
import ApprovalPanel from './ApprovalPanel';
import KeepAwakeControl from './KeepAwakeControl';
import CompanionSettingsPanel from './CompanionSettingsPanel';
import './AgentPanel.css';

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
function reportKey(row:AgentSession) {return JSON.stringify([row.agent,row.sessionId]);}
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

export type ReportedHistorySource = Readonly<{
  sessionId:string;agentSessionId:string;path:string;reportedAt:string;paneId:string|null;lease:AccessLease;
}>;
type ReportedHistory = {schemaVersion:1;sessionId:string} & (
  {status:'available';path:string;reportedAt:string;paneId:string|null}|{status:'missing'|'ambiguous'}
);
export function parseReportedHistory(value:unknown, agentSessionId:string):ReportedHistory {
  const invalid=()=>new LocalUiError('agentsHistoryInvalid');
  if(!value || typeof value!=='object')throw invalid();
  const row=value as Record<string,unknown>;
  if(row.schemaVersion!==1 || row.sessionId!==agentSessionId)throw invalid();
  if(row.status==='missing' || row.status==='ambiguous') {
    if(['path','reportedAt','paneId'].some(key=>key in row))throw invalid();
  } else if(row.status==='available') {
    if(typeof row.path!=='string' || !(row.path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(row.path) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(row.path)) || new TextEncoder().encode(row.path).length>4096
      || /[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(row.path)
      || typeof row.reportedAt!=='string' || row.reportedAt.length>64
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(row.reportedAt) || !Number.isFinite(Date.parse(row.reportedAt))
      || !(row.paneId===null || (typeof row.paneId==='string' && new TextEncoder().encode(row.paneId).length<=256 && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(row.paneId))))throw invalid();
  } else throw invalid();
  return row as ReportedHistory;
}

export function AgentPanel({ sessionId,onUseReportedHistory,visible:panelVisible=true }: { sessionId: string;visible?:boolean;onUseReportedHistory?:(source:ReportedHistorySource)=>void }) {
  useUi();
  const visibility=useRef(panelVisible);visibility.current=panelVisible;
  const [access]=useState(captureAccess);
  const invoke=useMemo(()=>bindProtectedInvoke(access),[access]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadedSessionId, setLoadedSessionId] = useState<string>();
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState<AgentState|'all'>('all');
  const [selection,setSelection]=useState<{source:string;key:string}|null>(null);
  const ready=loaded && loadedSessionId===sessionId;
  const reports=ready && !error ? sessions : [];
  const currentReports=useRef(reports);currentReports.current=reports;
  const term=query.trim().toLowerCase();
  const matching=reports.filter(row=>[row.agent,row.project,row.summary].some(value=>value.toLowerCase().includes(term)));
  const visible=matching.filter(row=>filter==='all' || row.state===filter);
  const selected=selection?.source===sessionId ? visible.find(row=>reportKey(row)===selection.key) : undefined;
  useEffect(()=>{if(selection && !selected)setSelection(null);},[selection,selected]);
  const request = useRef(0);
  const historyRequest=useRef(0);
  const historyOwner=useRef<{source:string;key:string}|null>(null);
  const historyFlight=useRef<number|null>(null);
  const [historyBusy,setHistoryBusy]=useState(false);
  const [historyError,setHistoryError]=useState<UiErrorCause>('');
  const [historyStatus,setHistoryStatus]=useState<'missing'|'ambiguous'|''>('');
  const selectedSource=useRef(sessionId);selectedSource.current=sessionId;
  async function useReportedHistory(row:AgentSession) {
    if(!visibility.current || historyFlight.current!==null || !access.current() || row.agent!=='Claude Code' || !onUseReportedHistory)return;
    const current=++historyRequest.current;historyFlight.current=current;
    const source=sessionId;const key=reportKey(row);historyOwner.current={source,key};
    const currentOwner=()=>visibility.current && historyRequest.current===current && selectedSource.current===source && access.current() && currentReports.current.some(value=>reportKey(value)===key);
    setHistoryBusy(true);setHistoryError('');setHistoryStatus('');
    try {
      const result=parseReportedHistory(await invoke('agent_reported_history',{sessionId:source,agentSessionId:row.sessionId}),row.sessionId);
      if(!currentOwner())return;
      if(result.status==='available')onUseReportedHistory(Object.freeze({sessionId:source,agentSessionId:row.sessionId,path:result.path,reportedAt:result.reportedAt,paneId:result.paneId,lease:access}));
      else setHistoryStatus(result.status);
    } catch(error) {if(currentOwner())setHistoryError(captureUiError(error));}
    finally {if(historyFlight.current===current)historyFlight.current=null;if(currentOwner())setHistoryBusy(false);}
  }
  useEffect(()=>{
    historyRequest.current++;historyFlight.current=null;historyOwner.current=null;setHistoryBusy(false);setHistoryError('');setHistoryStatus('');
    return()=>{historyRequest.current++;};
  },[sessionId]);

  useEffect(()=>{
    const owner=historyOwner.current;
    if(owner && (owner.source!==sessionId || !reports.some(row=>reportKey(row)===owner.key))) {
      historyRequest.current++;historyFlight.current=null;historyOwner.current=null;
      setHistoryBusy(false);setHistoryError('');setHistoryStatus('');
    }
  },[sessions,sessionId,error,loadedSessionId]);

  async function refresh() {
    if(!visibility.current || !access.current())return;
    const source=sessionId;
    const current = ++request.current;
    setBusy(true); setError('');
    try {
      const value = await invoke<unknown>('agent_snapshot', { sessionId });
      const rows = parseSnapshot(value);
      if(new Set(rows.map(reportKey)).size!==rows.length)throw new LocalUiError('agentsInvalidSession');
      if (visibility.current && selectedSource.current===source && current === request.current) { setSessions(rows); setLoaded(true); setLoadedSessionId(sessionId); }
    } catch (e) {
      if (visibility.current && selectedSource.current===source && current === request.current) setError(captureUiError(e));
    } finally { if (visibility.current && selectedSource.current===source && current === request.current) setBusy(false); }
  }
  useEffect(()=>{setSessions([]);setLoaded(false);},[sessionId]);
  useEffect(()=>{
    if(panelVisible)void refresh();
    else {setBusy(false);setSelection(null);setHistoryBusy(false);setHistoryError('');setHistoryStatus('');}
    return()=>{request.current++;historyRequest.current++;historyFlight.current=null;historyOwner.current=null;};
  },[sessionId,panelVisible]);

  return <section className="tool-panel agent-panel" hidden={!panelVisible} aria-label={t('agentsTitle')}>
    <KeepAwakeControl sessionId={sessionId} visible={panelVisible} />
    <ApprovalPanel sessionId={sessionId} visible={panelVisible} />
    <div className="tool-bar"><h3>{t('agentsTitle')}</h3><button className="subtle-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />{busy ? t('agentsRefreshing') : t('agentsRefresh')}</button></div>
    <p className="agent-note">{t('agentsReportedHint')}</p>
    {error && <div className="agent-setup"><p className="inline-error" role="alert">{uiErrorText(error)}</p><h3>{t('agentsConnect')}</h3><p>{t('agentsSetup')}</p><p>{t('agentsSetupDocs',{path:'docs/companion.md'})}</p></div>}
    <div className="agent-discovery">
      <label className="agent-search">{t('agentsSearch')}<input type="search" value={query} placeholder={t('agentsSearchHint')} onChange={event=>setQuery(event.target.value)} /></label>
      <div className="agent-filters" role="group" aria-label={t('agentsFilterStatus')}>
        {(['all',...states] as const).map(state=><button type="button" className="subtle-button" key={state} aria-pressed={filter===state} onClick={()=>setFilter(state)}>{state==='all'?t('agentsAll'):t(names[state])} {ready && !error && <span>{formatNumber(state==='all'?matching.length:matching.filter(row=>row.state===state).length)}</span>}</button>)}
      </div>
      {ready && !error && <p className="agent-result-count" role="status">{t('agentsResultCount',{shown:formatNumber(visible.length),total:formatNumber(reports.length)})}</p>}
      {(query!=='' || filter!=='all') && <button className="subtle-button" onClick={()=>{setQuery('');setFilter('all');}}>{t('agentsClearFilters')}</button>}
      {selected && <section className="agent-selected-report" aria-label={t('agentsSelectedReport')}>
        <div className="tool-bar"><h4>{t('agentsSelectedReport')}</h4><button className="subtle-button" onClick={()=>setSelection(null)}>{t('agentsClearSelection')}</button></div>
        <strong>{selected.agent}</strong><p>{selected.summary}</p>
        <dl><dt>{t('agentsReportProject')}</dt><dd><code>{selected.project}</code></dd><dt>{t('agentsFilterStatus')}</dt><dd>{t(names[selected.state])}</dd></dl>
        <details><summary>{t('agentsReportTechnicalDetails')}</summary><dl><dt>{t('agentsReportSession')}</dt><dd><code>{selected.sessionId}</code></dd><dt>{t('agentsReportEvents')}</dt><dd>{formatNumber(selected.eventCount)}</dd>{selected.paneId && <><dt>{t('agentsReportPane')}</dt><dd><code>{selected.paneId}</code></dd></>}</dl></details>
        <p><time dateTime={selected.updatedAt}>{t('agentsReported',{time:formatDateTime(new Date(selected.updatedAt))})}</time></p><p className="agent-report-hint">{t('agentsReportContext')}</p>
      </section>}
      {reports.length>0 && visible.length===0 && <div className="panel-empty"><h4>{t('agentsNoMatches')}</h4><p>{t('agentsNoMatchesHint')}</p></div>}
    </div>
    {historyBusy && <p role="status">{t('agentsHistoryReading')}</p>}
    {historyError && <div><p className="inline-error" role="alert">{uiErrorText(historyError)}</p><p>{t('agentsHistoryManual')}</p></div>}
    {historyStatus && <div><p role="status">{t(historyStatus==='missing'?'agentsHistoryMissing':'agentsHistoryAmbiguous')}</p><p>{t('agentsHistoryManual')}</p></div>}
    {busy && <p className="loading" role="status">{t('agentsReading')}</p>}
    {!busy && !error && ready && reports.length === 0 && <div className="panel-empty"><Bot size={28} /><h3>{t('agentsEmpty')}</h3><p>{t('agentsEmptyHint')}</p></div>}
    {visible.length > 0 && <div className="agent-board">{states.filter(state=>(filter==='all' || state===filter) && visible.some(row=>row.state===state)).map(state => <section key={state} aria-label={t(names[state])} className="agent-column"><h4>{t(names[state])} <span>{formatNumber(visible.filter(s => s.state === state).length)}</span></h4>{visible.filter(s => s.state === state).map(s => <article className="agent-card" data-selected={selected===s} key={reportKey(s)}><strong><Bot size={16} /> {s.agent}</strong><button className="subtle-button" aria-pressed={selected===s} aria-label={t('agentsSelectReport',{agent:s.agent,project:s.project})} onClick={()=>setSelection({source:sessionId,key:reportKey(s)})}>{t('agentsDetails')}</button><p>{s.summary}</p><code title={s.project}>{s.project}</code><small><time dateTime={s.updatedAt}>{t('agentsReported',{time:formatDateTime(new Date(s.updatedAt))})}</time></small>{s.agent==='Claude Code' && onUseReportedHistory && <button className="subtle-button" disabled={historyBusy || !access.current()} onClick={()=>void useReportedHistory(s)}>{t('agentsHistoryUse')}</button>}</article>)}</section>)}</div>}
    {ready && <CompanionSettingsPanel key={sessionId} sessionId={sessionId} visible={panelVisible && !error} />}
  </section>;
}

export default AgentPanel;

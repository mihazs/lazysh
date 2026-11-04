import {t, useUi, formatDateTime, formatNumber} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {bindProtectedInvoke,captureAccess,type AccessLease} from './access';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { ArrowLeft, Bot, ChevronRight, RefreshCw, Search, Settings2 } from 'lucide-react';
import {StatusRing,agentKind,formatRecency,projectName} from './AgentStatus';
import ApprovalPanel from './ApprovalPanel';
import HerdrAgentsPanel from './HerdrAgentsPanel';
import type {ReportedSessionSource} from './HerdrSessionDetails';
import KeepAwakeControl from './KeepAwakeControl';
import CompanionSettingsPanel from './CompanionSettingsPanel';
import CompanionInstallPanel from './CompanionInstallPanel';
import CompanionHooksPanel from './CompanionHooksPanel';
import {captureScrollPosition,restoreScrollPosition,type ScrollPosition} from './scrollReturn';
import './AgentPanel.css';

type AgentState = 'working' | 'needs_attention' | 'done';
export type AgentSession = {
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
const tones = {needs_attention:'attention',working:'working',done:'done'} as const;

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

export function AgentPanel({ sessionId,herdrSession,onUseReportedHistory,onRestoreHostTools,visible:panelVisible=true,showHerdr=true,activityVisible=true,renderNavigation,activityRef,activityId }: { sessionId: string;herdrSession?:string;visible?:boolean;showHerdr?:boolean;activityVisible?:boolean;renderNavigation?:(reports:ReportedSessionSource)=>ReactNode;activityRef?:Ref<HTMLDivElement>;activityId?:string;onRestoreHostTools?:(restored:()=>void)=>void;onUseReportedHistory?:(source:ReportedHistorySource)=>void }) {
  useUi();
  const visibility=useRef(panelVisible);visibility.current=panelVisible;
  const historyVisibility=useRef(activityVisible);historyVisibility.current=activityVisible;
  const [access]=useState(captureAccess);
  const invoke=useMemo(()=>bindProtectedInvoke(access),[access]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [setupSource,setSetupSource]=useState<string>();
  const [hookSetupRequest,setHookSetupRequest]=useState<Readonly<{sessionId:string}>>();
  const [loadedSessionId, setLoadedSessionId] = useState<string>();
  const [query,setQuery]=useState('');
  const [filter,setFilter]=useState<AgentState|'all'>('all');
  const [selection,setSelection]=useState<{source:string;key:string}|null>(null);
  const [mobile,setMobile]=useState(()=>window.matchMedia?.('(max-width: 600px)').matches??false);
  useEffect(()=>{const media=window.matchMedia?.('(max-width: 600px)');if(!media)return;const update=()=>setMobile(media.matches);media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
  const selectedReport=useRef<HTMLElement>(null);
  const reportTrigger=useRef<HTMLButtonElement>(null);
  const reportScroll=useRef<ScrollPosition|null>(null);
  const reportReturn=useRef<{target:HTMLButtonElement|null;scroll:ScrollPosition|null;source:string}|null>(null);
  useEffect(()=>{if(selection && visibility.current && selectedSource.current===selection.source && access.current() && !document.hidden)selectedReport.current?.focus();},[selection]);
  const ready=loaded && loadedSessionId===sessionId;
  const setupOpen=setupSource===sessionId || !!error;
  const reports=ready && !error ? sessions : [];
  const currentReports=useRef(reports);currentReports.current=reports;
  const term=query.trim().toLowerCase();
  const matching=reports.filter(row=>[row.agent,row.project,row.summary].some(value=>value.toLowerCase().includes(term)));
  const visible=matching.filter(row=>filter==='all' || row.state===filter);
  const selected=selection?.source===sessionId ? visible.find(row=>reportKey(row)===selection.key) : undefined;
  useEffect(()=>{if(selection && !selected)setSelection(null);},[selection,selected]);
  const request = useRef(0);
  const snapshotFlight=useRef<number|null>(null);
  const historyRequest=useRef(0);
  const historyOwner=useRef<{source:string;key:string}|null>(null);
  const historyFlight=useRef<number|null>(null);
  const [historyBusy,setHistoryBusy]=useState(false);
  const [historyError,setHistoryError]=useState<UiErrorCause>('');
  const [historyStatus,setHistoryStatus]=useState<'missing'|'ambiguous'|''>('');
  const selectedSource=useRef(sessionId);selectedSource.current=sessionId;
  async function useReportedHistory(row:AgentSession) {
    if(!visibility.current || !historyVisibility.current || historyFlight.current!==null || !access.current() || row.agent!=='Claude Code' || !onUseReportedHistory)return;
    const current=++historyRequest.current;historyFlight.current=current;
    const source=sessionId;const key=reportKey(row);historyOwner.current={source,key};
    const currentOwner=()=>visibility.current && historyVisibility.current && historyRequest.current===current && selectedSource.current===source && access.current() && currentReports.current.some(value=>reportKey(value)===key);
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
  },[sessionId,activityVisible]);

  useEffect(()=>{
    const owner=historyOwner.current;
    if(owner && (owner.source!==sessionId || !reports.some(row=>reportKey(row)===owner.key))) {
      historyRequest.current++;historyFlight.current=null;historyOwner.current=null;
      setHistoryBusy(false);setHistoryError('');setHistoryStatus('');
    }
  },[sessions,sessionId,error,loadedSessionId]);

  async function refresh() {
    if(!visibility.current || !access.current() || snapshotFlight.current!==null)return;
    const source=sessionId;
    const current = ++request.current;
    snapshotFlight.current=current;
    setBusy(true);
    try {
      const value = await invoke<unknown>('agent_snapshot', { sessionId });
      const rows = parseSnapshot(value);
      if(new Set(rows.map(reportKey)).size!==rows.length)throw new LocalUiError('agentsInvalidSession');
      if (visibility.current && selectedSource.current===source && current === request.current) { setSessions(rows); setLoaded(true); setLoadedSessionId(sessionId); setError(''); }
    } catch (e) {
      if (visibility.current && selectedSource.current===source && current === request.current) setError(captureUiError(e));
    } finally {
      if(snapshotFlight.current===current)snapshotFlight.current=null;
      if (visibility.current && selectedSource.current===source && current === request.current) setBusy(false);
    }
  }
  useEffect(()=>{setSessions([]);setLoaded(false);setError('');},[sessionId]);
  useEffect(()=>{
    if(panelVisible && !document.hidden)void refresh();
    else if(!panelVisible) {setBusy(false);setSelection(null);setHistoryBusy(false);setHistoryError('');setHistoryStatus('');}
    const interval=panelVisible ? window.setInterval(()=>{if(!document.hidden)void refresh();},5000) : undefined;
    return()=>{window.clearInterval(interval);request.current++;snapshotFlight.current=null;historyRequest.current++;historyFlight.current=null;historyOwner.current=null;};
  },[sessionId,panelVisible]);

  const reportSource={host:loadedSessionId,available:panelVisible && access.current() && ready && !error,rows:reports,lease:access};
  function closeReport() {
    const target=reportTrigger.current,scroll=reportScroll.current;
    reportScroll.current=null;
    if(!mobile) {setSelection(null);target?.focus();return;}
    reportReturn.current={target,scroll,source:sessionId};
    setSelection(null);
  }
  // Restore in the commit that shows the list again, whichever event scheduled it.
  useLayoutEffect(()=>{
    const pending=reportReturn.current;
    if(!pending || selected)return;
    reportReturn.current=null;
    const {target,scroll,source}=pending;
    if(!visibility.current || !historyVisibility.current || selectedSource.current!==source || !access.current() || document.hidden || !document.hasFocus())return;
    if(document.activeElement!==document.body && document.activeElement!==target)return;
    if(target && (!target.isConnected || target.getClientRects().length===0))return;
    target?.focus({preventScroll:true});
    if(scroll)restoreScrollPosition(scroll);
  },[selected]);
  useEffect(()=>{
    const back=(event:Event)=>{
      if(!selected || !panelVisible || !activityVisible || !access.current() || document.hidden || !document.hasFocus() || !mobile || document.querySelector('[role="dialog"][aria-modal="true"]'))return;
      event.preventDefault();event.stopImmediatePropagation();closeReport();
    };
    window.addEventListener('lazysh-workspace-back',back,true);return()=>window.removeEventListener('lazysh-workspace-back',back,true);
  },[selected,panelVisible,activityVisible,sessionId,mobile]);
  const approvals=<ApprovalPanel sessionId={sessionId} visible={panelVisible} compactEmpty />;
  const panel=<section className="tool-panel agent-panel" data-activity-detail={!!selected || undefined} hidden={!panelVisible} aria-label={t('agentsTitle')}>
    {!renderNavigation&&approvals}
    <div className="tool-bar"><h3>{t('agentsTitle')}</h3><label className="agent-search"><Search size={16} aria-hidden="true"/><span className="sr-only">{t('agentsSearch')}</span><input type="search" value={query} placeholder={t('agentsSearchHint')} onChange={event=>setQuery(event.target.value)} /></label><button type="button" className="icon-button agent-tool" title={t('agentsSetupAction')} aria-expanded={setupOpen} disabled={!!error} onClick={()=>setSetupSource(setupOpen?undefined:sessionId)}><Settings2 size={18} aria-hidden="true"/><span className="sr-only">{t('agentsSetupAction')}</span></button><button className="icon-button agent-tool" title={t('agentsRefresh')} disabled={busy} aria-busy={busy} onClick={() => void refresh()}><RefreshCw size={18} aria-hidden="true"/><span className="sr-only">{t('agentsRefresh')}</span></button></div>
    {error && <div className="agent-setup"><p className="inline-error" role="alert">{uiErrorText(error)}</p><h3>{t('agentsConnect')}</h3><p>{t('agentsSetup')}</p><p>{t('agentsSetupDocs',{path:'docs/companion.md'})}</p></div>}
    <section className="agent-configuration" hidden={!setupOpen} aria-label={t('agentsSetupAction')}>
      <h3>{t('agentsSetupAction')}</h3>
      <p className="agent-note">{t('agentsReportedHint')}</p>
      <KeepAwakeControl sessionId={sessionId} visible={panelVisible} />
      <CompanionInstallPanel sessionId={sessionId} visible={panelVisible} ready={ready && !error} onInstalled={()=>{setSetupSource(sessionId);request.current++;snapshotFlight.current=null;void refresh();}}/>
      <CompanionHooksPanel sessionId={sessionId} visible={panelVisible} reveal={hookSetupRequest}/>
      {ready && <CompanionSettingsPanel key={sessionId} sessionId={sessionId} visible={panelVisible && !error} />}
    </section>
    {showHerdr && <HerdrAgentsPanel sessionId={sessionId} herdrSession={herdrSession} visible={panelVisible} reports={reportSource} onRestoreHostTools={onRestoreHostTools ? restored=>onRestoreHostTools(()=>{restored();void refresh();}) : undefined} />}
    <div className="agent-discovery">
      <div className="agent-filters" role="group" aria-label={t('agentsFilterStatus')}>
        {(['all',...states] as const).map(state=><button type="button" className="filter-chip" key={state} aria-pressed={filter===state} onClick={()=>setFilter(state)}>{state==='all'?t('agentsAll'):t(names[state])} {ready && !error && <span>{formatNumber(state==='all'?matching.length:matching.filter(row=>row.state===state).length)}</span>}</button>)}
      </div>
      {ready && !error && <p className="agent-result-count" role="status">{t('agentsResultCount',{shown:formatNumber(visible.length),total:formatNumber(reports.length)})}</p>}
      {(query!=='' || filter!=='all') && <button className="subtle-button" onClick={()=>{setQuery('');setFilter('all');}}>{t('agentsClearFilters')}</button>}
      {selected && <section ref={selectedReport} tabIndex={-1} className="agent-selected-report" aria-label={t('agentsSelectedReport')}>
        <div className="tool-bar"><button type="button" className="subtle-button agent-report-back" onClick={closeReport}><ArrowLeft size={16} aria-hidden="true"/>{t('navigationBack')}</button><h4>{t('agentsSelectedReport')}</h4><button className="subtle-button agent-report-clear" onClick={closeReport}>{t('agentsClearSelection')}</button></div>
        <strong>{selected.agent}</strong><p>{selected.summary}</p>
        <dl><dt>{t('agentsReportProject')}</dt><dd><code>{selected.project}</code></dd><dt>{t('agentsFilterStatus')}</dt><dd>{t(names[selected.state])}</dd></dl>
        <details><summary>{t('agentsReportTechnicalDetails')}</summary><dl><dt>{t('agentsReportSession')}</dt><dd><code>{selected.sessionId}</code></dd><dt>{t('agentsReportEvents')}</dt><dd>{formatNumber(selected.eventCount)}</dd>{selected.paneId && <><dt>{t('agentsReportPane')}</dt><dd><code>{selected.paneId}</code></dd></>}</dl></details>
        <p><time dateTime={selected.updatedAt}>{t('agentsReported',{time:formatDateTime(new Date(selected.updatedAt))})}</time></p><p className="agent-report-hint">{t('agentsReportContext')}</p>
        {mobile && selected.agent==='Claude Code' && onUseReportedHistory && <button className="subtle-button agent-report-history" disabled={historyBusy || !access.current()} onClick={()=>void useReportedHistory(selected)}>{t('agentsHistoryUse')}</button>}
      </section>}
      {reports.length>0 && visible.length===0 && <div className="panel-empty"><h4>{t('agentsNoMatches')}</h4><p>{t('agentsNoMatchesHint')}</p></div>}
    </div>
    {historyBusy && <p role="status">{t('agentsHistoryReading')}</p>}
    {historyError && <div><p className="inline-error" role="alert">{uiErrorText(historyError)}</p><p>{t('agentsHistoryManual')}</p></div>}
    {historyStatus && <div><p role="status">{t(historyStatus==='missing'?'agentsHistoryMissing':'agentsHistoryAmbiguous')}</p><p>{t('agentsHistoryManual')}</p></div>}
    {busy && !ready && !error && <p className="loading" role="status">{t('agentsReading')}</p>}
    {!error && ready && reports.length === 0 && <div className="panel-empty"><Bot size={28} /><h3>{t('agentsEmpty')}</h3><p>{t('agentsEmptyHint')}</p>{!setupOpen && <button type="button" className="subtle-button" onClick={()=>{if(!visibility.current || selectedSource.current!==sessionId || !access.current())return;setSetupSource(sessionId);setHookSetupRequest({sessionId});}}><Settings2 size={15}/>{t('hooksTitle')}</button>}</div>}
    {visible.length > 0 && <div className="agent-board">{states.filter(state=>(filter==='all' || state===filter) && visible.some(row=>row.state===state)).map(state => <section key={state} aria-label={t(names[state])} className="agent-column status-group" data-state={state}><h4>{t(names[state])} <span className="status-group-count">{formatNumber(visible.filter(s => s.state === state).length)}</span></h4>{visible.filter(s => s.state === state).map(s => <article className="agent-card" data-selected={selected===s} key={reportKey(s)}><button ref={selected===s?reportTrigger:undefined} type="button" className="agent-report-row" aria-pressed={selected===s} aria-label={t('agentsSelectReport',{agent:s.agent,project:s.project})} onClick={event=>{reportTrigger.current=event.currentTarget;reportScroll.current=captureScrollPosition(event.currentTarget);reportReturn.current=null;setSelection({source:sessionId,key:reportKey(s)});}}><StatusRing tone={tones[s.state]}/><span className="agent-row-body"><span className="agent-row-summary">{s.summary}</span><span className="row-tags"><span className="row-tag" data-tone="project" title={s.project}>{projectName(s.project)}</span><strong className="row-tag" data-agent-kind={agentKind(s.agent)}>{s.agent}</strong><small><time dateTime={s.updatedAt} title={t('agentsReported',{time:formatDateTime(new Date(s.updatedAt))})}>{formatRecency(s.updatedAt)}</time></small></span></span><ChevronRight className="row-chevron" size={18} aria-hidden="true"/></button>{s.agent==='Claude Code' && onUseReportedHistory && <button className="text-button" disabled={historyBusy || !access.current()} onClick={()=>void useReportedHistory(s)}>{t('agentsHistoryUse')}</button>}</article>)}</section>)}</div>}
  </section>;
  return renderNavigation?<>{approvals}{renderNavigation(reportSource)}<div ref={activityRef} id={activityId} role="group" aria-label={t('agentsReportedActivity')} tabIndex={-1} className="workspace-navigation-agents" hidden={!panelVisible||!activityVisible}>{panel}</div></>:panel;
}

export default AgentPanel;

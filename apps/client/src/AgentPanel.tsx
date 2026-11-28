import {t, useUi, formatDateTime, formatNumber} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import {bindProtectedInvoke,captureAccess,type AccessLease} from './access';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react';

import { Archive, ArchiveRestore, ArrowLeft, Bot, RefreshCw, Settings2 } from 'lucide-react';
import {pathBasename,useNow} from './relativeTime';
import {companionSourceLabels,type CompanionSource} from './localHost';
import ApprovalPanel from './ApprovalPanel';
import HerdrAgentsPanel from './HerdrAgentsPanel';
import type {ReportedSessionSource} from './HerdrSessionDetails';
import KeepAwakeControl from './KeepAwakeControl';
import CompanionSettingsPanel from './CompanionSettingsPanel';
import CompanionUpdateRow from './CompanionUpdateRow';
import CompanionUpdateConsent,{CompanionConsentSetting} from './CompanionUpdateConsent';
import {companionUpdatedEvent,parseCompanionUpdate,type CompanionUpdate} from './companionUpdate';
import CompanionInstallPanel from './CompanionInstallPanel';
import CompanionHooksPanel from './CompanionHooksPanel';
import {captureScrollPosition,restoreScrollPosition,type ScrollPosition} from './scrollReturn';
import {archiveReport,isArchived,readArchive,reconcileArchive,restoreReport,saveArchive,type ArchivedReport} from './agentArchive';
import {parseLiveAgents,parseReports,projectGroups,reportKey,reportLabel,reportedStateNames,states,type AgentSession,type AgentState,type LiveAgents} from './agentReports';
import AgentRename from './AgentRename';
import {useNames,withNames} from './agentSessionNames';
import AllHostsBoard,{distinctHosts,type BoardHost} from './AllHostsBoard';
import {ReportRowContent,ReportSummary,SearchField,StateFilter} from './AgentReportParts';
import './AgentPanel.css';

export {parseSnapshot,reportedStateNames,type AgentSession} from './agentReports';
const names = reportedStateNames;

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

export function AgentPanel({ sessionId,hostKey,hostLabel,hosts,local,companionSource,herdrSession,onUseReportedHistory,visible:panelVisible=true,showHerdr=true,activityVisible=true,renderNavigation,activityRef,activityId }: { sessionId: string;hostKey?:string;hostLabel?:string;/** Every connected host, to offer the board that merges them. */hosts?:readonly BoardHost[];local?:boolean;companionSource?:CompanionSource;herdrSession?:string;visible?:boolean;showHerdr?:boolean;activityVisible?:boolean;renderNavigation?:(reports:ReportedSessionSource)=>ReactNode;activityRef?:Ref<HTMLDivElement>;activityId?:string;onUseReportedHistory?:(source:ReportedHistorySource)=>void }) {
  useUi();
  const visibility=useRef(panelVisible);visibility.current=panelVisible;
  const historyVisibility=useRef(activityVisible);historyVisibility.current=activityVisible;
  const [access]=useState(captureAccess);
  const invoke=useMemo(()=>bindProtectedInvoke(access),[access]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [liveAgents,setLiveAgents]=useState<LiveAgents>();
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [setupSource,setSetupSource]=useState<string>();
  const [hookSetupRequest,setHookSetupRequest]=useState<Readonly<{sessionId:string}>>();
  const [loadedSessionId, setLoadedSessionId] = useState<string>();
  const archiveHost=hostKey ?? sessionId;
  const [archiveState,setArchive]=useState<{host:string;rows:readonly ArchivedReport[]}>(()=>({host:archiveHost,rows:readArchive(archiveHost)}));
  const archived=archiveState.host===archiveHost ? archiveState.rows : readArchive(archiveHost);
  const [showArchived,setShowArchived]=useState(false);
  const archiveToggle=useRef<HTMLButtonElement>(null);
  const [archiveFocus,setArchiveFocus]=useState(0);
  useEffect(()=>{if(archiveFocus)archiveToggle.current?.focus();},[archiveFocus]);
  function updateArchive(change:(rows:readonly ArchivedReport[])=>readonly ArchivedReport[]) {
    setArchive(previous=>{
      const current=previous.host===archiveHost ? previous.rows : readArchive(archiveHost);
      const rows=change(current);
      if(rows!==current)saveArchive(archiveHost,rows);
      return {host:archiveHost,rows};
    });
  }
  const [query,setQuery]=useState('');
  const [scope,setScope]=useState<'host'|'all'>('host');
  const peers=distinctHosts(hosts??[]);
  const merged=scope==='all' && peers.length>1;
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
  const ownNames=useNames(archiveHost);
  const named=useMemo(()=>withNames(sessions,ownNames),[sessions,ownNames]);
  const reports=ready && !error ? named : [];
  const currentReports=useRef(reports);currentReports.current=reports;
  const archivedReports=reports.filter(row=>isArchived(archived,row));
  const activeReports=reports.filter(row=>!isArchived(archived,row));
  const term=query.trim().toLowerCase();
  const matching=activeReports.filter(row=>[row.agent,row.project,row.summary,row.title??''].some(value=>value.toLowerCase().includes(term)));
  const visible=matching.filter(row=>filter==='all' || row.state===filter);
  const selected=selection?.source===sessionId ? visible.find(row=>reportKey(row)===selection.key) : undefined;
  useEffect(()=>{if(selection && !selected)setSelection(null);},[selection,selected]);
  /** Keeps row recency current between polls while reported activity is on screen. */
  const now=useNow(30000,panelVisible && activityVisible && visible.length>0);
  const request = useRef(0);
  const snapshotFlight=useRef<number|null>(null);
  const [companionUpdate,setCompanionUpdate]=useState<CompanionUpdate|undefined>();
  const lastUpdate=useRef<CompanionUpdate|undefined>(undefined);
  const recoveryRefresh=useRef<string|undefined>(undefined);
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

  /** The host says it is updating its companion to this app's version; once it has, views that waited for it ask again. */
  function noteCompanionUpdate(next:CompanionUpdate|undefined,source:string) {
    const was=lastUpdate.current;lastUpdate.current=next;setCompanionUpdate(next);
    if(next?.state==='done' && was?.state!=='done')window.dispatchEvent(new CustomEvent(companionUpdatedEvent,{detail:{sessionId:source}}));
  }
  async function refresh() {
    if(!visibility.current || document.hidden || !access.current() || snapshotFlight.current!==null)return;
    const source=sessionId;
    const current = ++request.current;
    snapshotFlight.current=current;
    setBusy(true);
    try {
      const value = await invoke<unknown>('agent_snapshot', { sessionId });
      const rows = parseReports(value);
      const live = parseLiveAgents(value);
      if (visibility.current && selectedSource.current===source && current === request.current) { noteCompanionUpdate(parseCompanionUpdate(value),source);setSessions(rows); setLiveAgents(live); setLoaded(true); setLoadedSessionId(sessionId); setError(''); updateArchive(previous=>reconcileArchive(previous,rows)); }
    } catch (e) {
      if (visibility.current && selectedSource.current===source && current === request.current) setError(captureUiError(e));
    } finally {
      if(snapshotFlight.current===current)snapshotFlight.current=null;
      if (visibility.current && selectedSource.current===source && current === request.current) setBusy(false);
      if(recoveryRefresh.current===source && selectedSource.current===source) {recoveryRefresh.current=undefined;void refresh();}
    }
  }
  useEffect(()=>{setSessions([]);setLiveAgents(undefined);setLoaded(false);setError('');lastUpdate.current=undefined;setCompanionUpdate(undefined);},[sessionId]);
  useEffect(()=>{
    if(panelVisible && !document.hidden)void refresh();
    else if(!panelVisible) {setBusy(false);setSelection(null);setHistoryBusy(false);setHistoryError('');setHistoryStatus('');}
    const interval=panelVisible ? window.setInterval(()=>{if(!document.hidden)void refresh();},5000) : undefined;
    const recovered=(event:Event)=>{
      if(!panelVisible || document.hidden || (event as CustomEvent<unknown>).detail!==sessionId)return;
      if(snapshotFlight.current!==null)recoveryRefresh.current=sessionId;else void refresh();
    };
    window.addEventListener('lazysh-host-tools-restored',recovered);
    return()=>{window.removeEventListener('lazysh-host-tools-restored',recovered);window.clearInterval(interval);request.current++;snapshotFlight.current=null;recoveryRefresh.current=undefined;historyRequest.current++;historyFlight.current=null;historyOwner.current=null;};
  },[sessionId,panelVisible]);

  const reportSource={host:loadedSessionId,available:panelVisible && access.current() && ready && !error,rows:reports,lease:access};
  function archive(row:AgentSession) {
    if(!visibility.current || selectedSource.current!==sessionId || !access.current())return;
    if(selected && reportKey(selected)===reportKey(row)) {reportReturn.current=null;reportScroll.current=null;setSelection(null);}
    updateArchive(rows=>archiveReport(rows,row));
    setArchiveFocus(value=>value+1);
  }
  function restore(row:AgentSession) {
    if(!visibility.current || selectedSource.current!==sessionId || !access.current())return;
    updateArchive(rows=>restoreReport(rows,row));
  }
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
  const liveProcesses=ready && !error && <section className="agent-live-processes" aria-label={t('agentsHostProcesses')}>
    <h3>{t('agentsHostProcesses')}</h3>
    {!liveAgents || liveAgents.status==='unsupported' || liveAgents.status==='unavailable' ? <p>{t('agentsHostProcessesUnavailable')}</p> : <>
      <p>{t('agentsHostProcessesIdentity')}</p>
      {liveAgents.status==='truncated' && <p>{t('agentsHostProcessesTruncated')}</p>}
      {liveAgents.processes.length===0 ? <p>{t('agentsHostProcessesEmpty')}</p> : <ul>{liveAgents.processes.map(process=>
        <li key={`${process.pid}:${process.startTime}`}>{process.agent} <small>{t('agentsHostProcessId',{pid:formatNumber(process.pid)})}</small></li>)}</ul>}
    </>}
  </section>;
  const approvals=<ApprovalPanel sessionId={sessionId} visible={panelVisible} compactEmpty />;
  const panel=<section className="tool-panel agent-panel" data-activity-detail={!!selected || undefined} hidden={!panelVisible} aria-label={t('agentsTitle')}>
    {!renderNavigation&&<>{approvals}{liveProcesses}</>}
    {peers.length>1 && <div className="agent-scope" role="group" aria-label={t('agentsScope')}>{(['host','all'] as const).map(value=><button type="button" className="filter-chip" key={value} aria-pressed={merged===(value==='all')} onClick={()=>setScope(value)}>{t(value==='host'?'agentsScopeHost':'agentsScopeAll')}</button>)}</div>}
    {merged ? <AllHostsBoard hosts={peers} visible={panelVisible && activityVisible} onOpen={()=>setScope('host')}/> : <>
    <div className="tool-bar"><h3>{t('agentsTitle')}</h3><SearchField query={query} onChange={setQuery}/><button type="button" className="icon-button agent-tool" title={t('agentsSetupAction')} aria-expanded={setupOpen} disabled={!!error} onClick={()=>setSetupSource(setupOpen?undefined:sessionId)}><Settings2 size={18} aria-hidden="true"/><span className="sr-only">{t('agentsSetupAction')}</span></button><button className="icon-button agent-tool" title={t('agentsRefresh')} disabled={busy} aria-busy={busy} onClick={() => void refresh()}><RefreshCw size={18} aria-hidden="true"/><span className="sr-only">{t('agentsRefresh')}</span></button></div>
    {ready && !error && companionUpdate && <CompanionUpdateRow update={companionUpdate}/>}
    <CompanionUpdateConsent sessionId={sessionId} host={archiveHost} ready={ready && !error && !local} companionReplied={!!companionUpdate} onInstalled={()=>{request.current++;snapshotFlight.current=null;void refresh();}}/>
    {error && <div className="agent-setup"><p className="inline-error" role="alert">{uiErrorText(error)}</p><h3>{t('agentsConnect')}</h3><p>{t(local?'agentsSetupLocal':'agentsSetup')}</p><p>{t('agentsSetupDocs',{path:'docs/companion.md'})}</p></div>}
    <section className="agent-configuration" hidden={!setupOpen} aria-label={t('agentsSetupAction')}>
      <h3>{t('agentsSetupAction')}</h3>
      <p className="agent-note">{t('agentsReportedHint')}</p>
      <KeepAwakeControl sessionId={sessionId} visible={panelVisible} />
      <CompanionConsentSetting host={archiveHost}/>
      {local?<p className="agent-note" data-companion-source={companionSource}>{companionSource?t('companionLocalSource',{source:t(companionSourceLabels[companionSource])}):t('companionLocalNote')}</p>:<CompanionInstallPanel sessionId={sessionId} visible={panelVisible} ready={ready && !error} onInstalled={()=>{setSetupSource(sessionId);request.current++;snapshotFlight.current=null;void refresh();}}/>}
      <CompanionHooksPanel sessionId={sessionId} visible={panelVisible} reveal={hookSetupRequest}/>
      {ready && <CompanionSettingsPanel key={sessionId} sessionId={sessionId} hostKey={archiveHost} visible={panelVisible && !error} />}
    </section>
    {showHerdr && <HerdrAgentsPanel sessionId={sessionId} herdrSession={herdrSession} visible={panelVisible} reports={reportSource} />}
    <div className="agent-discovery">
      <StateFilter filter={filter} onChange={setFilter} count={ready && !error ? state=>state==='all'?matching.length:matching.filter(row=>row.state===state).length : undefined}/>
      {ready && !error && <p className="agent-result-count" role="status">{t('agentsResultCount',{shown:formatNumber(visible.length),total:formatNumber(activeReports.length)})}</p>}
      {(query!=='' || filter!=='all') && <button className="subtle-button" onClick={()=>{setQuery('');setFilter('all');}}>{t('agentsClearFilters')}</button>}
      {selected && <section ref={selectedReport} tabIndex={-1} className="agent-selected-report" aria-label={t('agentsSelectedReport')}>
        <div className="tool-bar"><button type="button" className="subtle-button agent-report-back" onClick={closeReport}><ArrowLeft size={16} aria-hidden="true"/>{t('navigationBack')}</button><h4>{t('agentsSelectedReport')}</h4><button className="subtle-button agent-report-clear" onClick={closeReport}>{t('agentsClearSelection')}</button></div>
        <strong>{selected.title??selected.agent}</strong>{selected.title && <small className="agent-report-vendor">{selected.agent}</small>}<p>{selected.summary}</p>
        <dl><dt>{t('agentsReportProject')}</dt><dd><code>{selected.project}</code></dd><dt>{t('agentsFilterStatus')}</dt><dd>{t(names[selected.state])}</dd></dl>
        <details><summary>{t('agentsReportTechnicalDetails')}</summary><dl><dt>{t('agentsReportSession')}</dt><dd><code>{selected.sessionId}</code></dd><dt>{t('agentsReportEvents')}</dt><dd>{formatNumber(selected.eventCount)}</dd>{selected.paneId && <><dt>{t('agentsReportPane')}</dt><dd><code>{selected.paneId}</code></dd></>}{selected.paneServer && <><dt>{t('agentsReportPaneServer')}</dt><dd><code>{selected.paneServer}</code></dd></>}</dl></details>
        <p><time dateTime={selected.updatedAt}>{t('agentsReported',{time:formatDateTime(new Date(selected.updatedAt))})}</time></p><p className="agent-report-hint">{t('agentsReportContext')}</p>
        <AgentRename key={reportKey(selected)} row={selected} host={archiveHost}/><button type="button" className="subtle-button agent-report-archive" onClick={()=>archive(selected)}><Archive size={15} aria-hidden="true"/>{t('agentsArchive')}</button>
        {mobile && selected.agent==='Claude Code' && onUseReportedHistory && <button className="subtle-button agent-report-history" disabled={historyBusy || !access.current()} onClick={()=>void useReportedHistory(selected)}>{t('agentsHistoryUse')}</button>}
      </section>}
      {activeReports.length>0 && visible.length===0 && <div className="panel-empty"><h4>{t('agentsNoMatches')}</h4><p>{t('agentsNoMatchesHint')}</p></div>}
    </div>
    {historyBusy && <p role="status">{t('agentsHistoryReading')}</p>}
    {historyError && <div><p className="inline-error" role="alert">{uiErrorText(historyError)}</p><p>{t('agentsHistoryManual')}</p></div>}
    {historyStatus && <div><p role="status">{t(historyStatus==='missing'?'agentsHistoryMissing':'agentsHistoryAmbiguous')}</p><p>{t('agentsHistoryManual')}</p></div>}
    {busy && !ready && !error && <p className="loading" role="status">{t('agentsReading')}</p>}
    {!error && ready && reports.length === 0 && <div className="panel-empty"><Bot size={28} /><h3>{t('agentsEmpty')}</h3><p>{t('agentsEmptyHint')}</p>{!setupOpen && <button type="button" className="subtle-button" onClick={()=>{if(!visibility.current || selectedSource.current!==sessionId || !access.current())return;setSetupSource(sessionId);setHookSetupRequest({sessionId});}}><Settings2 size={15}/>{t('hooksTitle')}</button>}</div>}
    {visible.length > 0 && <div className="agent-board">{states.filter(state=>(filter==='all' || state===filter) && visible.some(row=>row.state===state)).map(state => <section key={state} aria-label={t(names[state])} className="agent-column status-group" data-state={state}><h4>{t(names[state])} <span className="status-group-count">{formatNumber(visible.filter(s => s.state === state).length)}</span></h4>{projectGroups(visible.filter(s => s.state === state)).map(([project,rows])=><section key={project} className="agent-project-group" aria-label={hostLabel?t('agentsProjectGroup',{project:pathBasename(project),host:hostLabel}):pathBasename(project)}><h5 className="agent-project-heading"><span className="agent-project-name" title={project}>{pathBasename(project)}</span>{hostLabel && <span className="agent-project-host">{hostLabel}</span>}<span className="status-group-count">{formatNumber(rows.length)}</span></h5>{rows.map(s => <article className="agent-card" data-selected={selected===s} key={reportKey(s)}><button ref={selected===s?reportTrigger:undefined} type="button" className="agent-report-row" aria-pressed={selected===s} aria-label={t('agentsSelectReport',{agent:reportLabel(s),project:s.project})} onClick={event=>{reportTrigger.current=event.currentTarget;reportScroll.current=captureScrollPosition(event.currentTarget);reportReturn.current=null;setSelection({source:sessionId,key:reportKey(s)});}}><ReportRowContent row={s} now={now}/></button><div className="agent-card-actions">{s.agent==='Claude Code' && onUseReportedHistory && <button className="text-button" disabled={historyBusy || !access.current()} onClick={()=>void useReportedHistory(s)}>{t('agentsHistoryUse')}</button>}<button type="button" className="text-button agent-archive" aria-label={t('agentsArchiveReport',{agent:reportLabel(s),project:pathBasename(s.project)})} onClick={()=>archive(s)}><Archive size={14} aria-hidden="true"/>{t('agentsArchive')}</button></div></article>)}</section>)}</section>)}</div>}
    {archivedReports.length>0 && <section className="agent-archived" aria-label={t('agentsArchivedTitle')}>
      <button ref={archiveToggle} type="button" className="subtle-button agent-archive-toggle" aria-expanded={showArchived} onClick={()=>setShowArchived(value=>!value)}><Archive size={15} aria-hidden="true"/>{t('agentsArchived',{total:formatNumber(archivedReports.length)})}</button>
      {showArchived && <><p className="agent-note">{t('agentsArchivedHint')}</p>{archivedReports.map(s=><article className="agent-archived-card" key={reportKey(s)}><ReportSummary row={s}><small>{t(names[s.state])}</small></ReportSummary><button type="button" className="text-button agent-restore" aria-label={t('agentsRestoreReport',{agent:reportLabel(s),project:pathBasename(s.project)})} onClick={()=>restore(s)}><ArchiveRestore size={14} aria-hidden="true"/>{t('agentsRestore')}</button></article>)}</>}
    </section>}
    </>}
  </section>;
  return renderNavigation?<>{approvals}{!activityVisible && panelVisible && liveProcesses}{renderNavigation(reportSource)}<div ref={activityRef} id={activityId} role="group" aria-label={t('agentsReportedActivity')} tabIndex={-1} className="workspace-navigation-agents" hidden={!panelVisible||!activityVisible}>{panel}</div></>:panel;
}

export default AgentPanel;

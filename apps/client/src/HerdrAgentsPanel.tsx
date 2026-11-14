import {t,useUi,formatNumber} from './i18n/core';
import {SshControlClosedError,uiErrorText} from './i18n/localError';
import {useHerdrNavigation,herdrStatusKeys,type LiveAgent,type ReportedSessionRef} from './useHerdrNavigation';
import HerdrSessionDetails,{reportedSessionCounts,type ReportedSessionSource} from './HerdrSessionDetails';
import {useAccessSnapshot} from './access';
import {useEffect,useRef,useState} from 'react';
import type {AccessLease} from './access';
import type {HerdrNavigationTarget} from './bridge';
import {captureUiError,type UiErrorCause} from './i18n/localError';
export {parseHerdrAgents} from './useHerdrNavigation';

type Enter=(name:string,target:HerdrNavigationTarget,owner:AccessLease,current:()=>boolean)=>Promise<void>;
/** Enters one exact Herdr pane; a failure stays beside the button that caused it. */
export function EnterSessionButton({server,target,lease,enabled,owner,onEnterHerdr}:{server:string;target:HerdrNavigationTarget;lease:AccessLease;enabled:boolean;owner:()=>()=>boolean;onEnterHerdr:Enter}) {
  const [entering,setEntering]=useState(false);
  const [error,setError]=useState<UiErrorCause>('');
  return <>
    {error && <p role="alert">{uiErrorText(error)}</p>}
    <button type="button" disabled={entering || !enabled || !lease.current()} onClick={()=>{const owns=owner();setEntering(true);setError('');void onEnterHerdr(server,target,lease,owns).catch(failure=>{if(owns())setError(captureUiError(failure));}).finally(()=>setEntering(false));}}>{t('agentViewEnterSession')}</button>
  </>;
}
/** Live Herdr metadata is independent of companion lifecycle reports and grants no input authority. */
/** `navigation` is a reader its owner already runs (the Agent view keeps one to follow the focused pane); without it the panel reads on its own. */
export default function HerdrAgentsPanel({sessionId,herdrSession,visible,reports,navigation,onRestoreHostTools,onEnterHerdr,onChooseSession}:{sessionId:string;herdrSession?:string;visible:boolean;reports?:ReportedSessionSource;navigation?:ReturnType<typeof useHerdrNavigation>;onRestoreHostTools?:(restored:()=>void)=>void;onEnterHerdr?:Enter;onChooseSession?:(row:LiveAgent&{agent_session:ReportedSessionRef},server:string)=>void}) {
  useUi();
  useAccessSnapshot();
  const own=useHerdrNavigation({sessionId,herdrSession,visible:visible && !navigation,reports});
  const {data:loaded,agentFailure:failure,busy,query,setQuery,lease,refresh,selectServer}=navigation??own;
  const fromAgent=!!onEnterHerdr || !!onChooseSession;
  const data=fromAgent && (!visible || !lease.current())?null:loaded;
  const current=useRef({sessionId,visible,server:data?.server});current.current={sessionId,visible,server:data?.server};
  useEffect(()=>{current.current.visible=visible;return()=>{current.current.visible=false;};},[visible]);
  const references=reportedSessionCounts(data?.rows??[]);
  const rows=data?.rows.filter(row=>[row.name,row.agent,row.cwd,row.pane_id].some(text=>text?.toLowerCase().includes(query.trim().toLowerCase()))).sort((a,b)=>Number(b.agent_status==='blocked')-Number(a.agent_status==='blocked'))??[];
  return <section className="herdr-agents" aria-label={t('herdrAgentsTitle')} aria-busy={busy}>
    <div className="tool-bar"><h3>{t('herdrAgentsTitle')}</h3><button className="subtle-button" disabled={busy} onClick={()=>void refresh()}>{t('herdrAgentsRefresh')}</button></div>
    {busy && !data?.loaded && failure?.host!==sessionId && <p role="status">{t('herdrReading')}</p>}
    {failure?.host===sessionId && <div><p role="status">{t('herdrAgentsUnavailable')} {uiErrorText(failure.cause)}</p>{onRestoreHostTools && failure.cause instanceof SshControlClosedError && <button className="subtle-button" disabled={busy || !visible || !lease.current()} onClick={()=>onRestoreHostTools(()=>void refresh())}>{t('hostToolsRestore')}</button>}</div>}
    {data && <>
      {data.servers.length===0?<p>{t('herdrAgentsNoServers')}</p>:<>
        <details className="herdr-server-setup" open={!data.loaded || !data.server || failure?.host===sessionId ? true : undefined}>
        <summary>{t('herdrAgentsServer')}{data.server ? ` · ${data.server}` : ''}</summary>
        <p>{t('herdrAgentsHint')}</p>
        <label>{t('herdrAgentsServer')}<select value={data.server} disabled={busy || fromAgent} onChange={event=>selectServer(event.target.value)}>
          <option value="">{t('herdrAgentsChoose')}</option>{data.servers.map(name=><option key={name}>{name}</option>)}
        </select></label>
        <p>{t('herdrAgentsScope',{servers:formatNumber(data.servers.length)})}</p>
        </details>
        {data.server && <><label>{t('herdrAgentsSearch')}<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
          {data.loaded && failure?.host!==sessionId && <p role="status">{t('herdrAgentsCount',{shown:formatNumber(rows.length),total:formatNumber(data.rows.length)})}</p>}
          <div className="live-agent-list">{rows.map(row=>{
            const referenceCount=row.agent_session?references.get(JSON.stringify([row.agent_session.agent,row.agent_session.value]))??0:0;
            const reference=row.agent_session;
            const place=[data.server,data.snapshot?.workspaces.find(item=>item.workspace_id===row.workspace_id)?.label??row.workspace_id,data.snapshot?.tabs.find(item=>item.tab_id===row.tab_id)?.label??row.tab_id].join(' · ');
            const summary=<><strong>{row.name??row.agent??row.pane_id}</strong>{row.name && row.agent && <span>{row.agent}</span>}
              <span>{t(herdrStatusKeys[row.agent_status])}</span>{row.cwd && <code>{row.cwd}</code>}<small>{place}</small></>;
            return <article className="agent-card" key={JSON.stringify([sessionId,data.server,row.terminal_id,row.pane_id])}>
            {/* The whole row opens the conversation; without one, the row says why and still offers the exact pane. */}
            {onChooseSession && reference && reference.agent!=='opencode' && referenceCount===1
              ? <button type="button" className="agent-card-summary" disabled={!visible || !lease.current()} onClick={()=>onChooseSession({...row,agent_session:reference},data.server)}>{summary}<span className="agent-row-action">{t('agentViewOpenConversation')}</span></button>
              : <div className="agent-card-summary">{summary}{onChooseSession && <span>{t('agentViewNoReportedConversation')}</span>}</div>}
            {onEnterHerdr && <EnterSessionButton server={data.server} target={{kind:'pane',workspace:row.workspace_id,tab:row.tab_id,pane:row.pane_id,terminal:row.terminal_id}} lease={lease} enabled={visible}
              owner={()=>{const server=data.server;return()=>current.current.sessionId===sessionId && current.current.visible && current.current.server===server && lease.current();}} onEnterHerdr={onEnterHerdr}/>}
            {reference && <HerdrSessionDetails reference={reference} count={referenceCount} sessionId={sessionId} available={visible && lease.current()} reports={reports}/>}
          </article>;})}</div>
        </>}
      </>}
    </>}
  </section>;
}

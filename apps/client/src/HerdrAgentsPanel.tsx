import {t,useUi,formatNumber} from './i18n/core';
import {SshControlClosedError,uiErrorText} from './i18n/localError';
import {useHerdrNavigation,herdrStatusKeys} from './useHerdrNavigation';
import HerdrSessionDetails,{reportedSessionCounts,type ReportedSessionSource} from './HerdrSessionDetails';
import {useAccessSnapshot} from './access';
import {useEffect,useRef,useState} from 'react';
import type {AccessLease} from './access';
import type {HerdrNavigationTarget} from './bridge';
import {captureUiError,type UiErrorCause} from './i18n/localError';
export {parseHerdrAgents} from './useHerdrNavigation';

/** Live Herdr metadata is independent of companion lifecycle reports and grants no input authority. */
export default function HerdrAgentsPanel({sessionId,herdrSession,visible,reports,onRestoreHostTools,onEnterHerdr,onChooseSession}:{sessionId:string;herdrSession?:string;visible:boolean;reports?:ReportedSessionSource;onRestoreHostTools?:(restored:()=>void)=>void;onEnterHerdr?:(name:string,target:HerdrNavigationTarget,owner:AccessLease,current:()=>boolean)=>Promise<void>;onChooseSession?:(agent:'claude'|'codex',id:string,server:string,pane:string,terminal:string)=>void}) {
  useUi();
  useAccessSnapshot();
  const {data:loaded,agentFailure:failure,busy,query,setQuery,lease,refresh,selectServer}=useHerdrNavigation({sessionId,herdrSession,visible,reports});
  const fromAgent=!!onEnterHerdr || !!onChooseSession;
  const data=fromAgent && (!visible || !lease.current())?null:loaded;
  const current=useRef({sessionId,visible,server:data?.server});current.current={sessionId,visible,server:data?.server};
  useEffect(()=>{current.current.visible=visible;return()=>{current.current.visible=false;};},[visible]);
  const [entering,setEntering]=useState(false);
  const [enterError,setEnterError]=useState<UiErrorCause>('');
  const references=reportedSessionCounts(data?.rows??[]);
  const rows=data?.rows.filter(row=>[row.name,row.agent,row.cwd,row.pane_id].some(text=>text?.toLowerCase().includes(query.trim().toLowerCase())))??[];
  return <section className="herdr-agents" aria-label={t('herdrAgentsTitle')} aria-busy={busy}>
    <div className="tool-bar"><h3>{t('herdrAgentsTitle')}</h3><button className="subtle-button" disabled={busy} onClick={()=>void refresh()}>{t('herdrAgentsRefresh')}</button></div>
    {enterError && <p role="alert">{uiErrorText(enterError)}</p>}
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
            return <article className="agent-card" key={JSON.stringify([sessionId,data.server,row.terminal_id,row.pane_id])}>
            <strong>{row.name??row.agent??row.pane_id}</strong>{row.name && row.agent && <p>{row.agent}</p>}
            <p>{t(herdrStatusKeys[row.agent_status])}</p>{row.cwd && <code>{row.cwd}</code>}
            {onChooseSession && row.agent_session && row.agent_session.agent!=='opencode' && referenceCount===1 && <button type="button" disabled={!visible || !lease.current()} onClick={()=>onChooseSession(row.agent_session!.agent as 'claude'|'codex',row.agent_session!.value,data.server,row.pane_id,row.terminal_id)}>{t('agentViewOpenConversation')}</button>}
            {onEnterHerdr && <button type="button" disabled={entering || !visible || !lease.current()} onClick={()=>{const server=data.server;const owns=()=>current.current.sessionId===sessionId && current.current.visible && current.current.server===server && lease.current();setEntering(true);setEnterError('');void onEnterHerdr(server,{kind:'pane',workspace:row.workspace_id,tab:row.tab_id,pane:row.pane_id,terminal:row.terminal_id},lease,owns).catch(error=>{if(owns())setEnterError(captureUiError(error));}).finally(()=>setEntering(false));}}>{t('agentViewEnterSession')}</button>}
            {row.agent_session && <HerdrSessionDetails reference={row.agent_session} count={referenceCount} sessionId={sessionId} available={visible && lease.current()} reports={reports}/>}
            <small>{data.server} · {row.workspace_id} · {row.tab_id} · {row.pane_id}</small>
          </article>;})}</div>
        </>}
      </>}
    </>}
  </section>;
}

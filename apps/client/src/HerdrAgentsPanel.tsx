import {t,useUi,formatNumber} from './i18n/core';
import {SshControlClosedError,uiErrorText} from './i18n/localError';
import {useHerdrNavigation,herdrStatusKeys} from './useHerdrNavigation';
import HerdrSessionDetails,{reportedSessionCounts,type ReportedSessionSource} from './HerdrSessionDetails';
import {useAccessSnapshot} from './access';
export {parseHerdrAgents} from './useHerdrNavigation';

/** Live Herdr metadata is independent of companion lifecycle reports and grants no input authority. */
export default function HerdrAgentsPanel({sessionId,herdrSession,visible,reports,onRestoreHostTools}:{sessionId:string;herdrSession?:string;visible:boolean;reports?:ReportedSessionSource;onRestoreHostTools?:(restored:()=>void)=>void}) {
  useUi();
  useAccessSnapshot();
  const {data,agentFailure:failure,busy,query,setQuery,lease,refresh,selectServer}=useHerdrNavigation({sessionId,herdrSession,visible});
  const references=reportedSessionCounts(data?.rows??[]);
  const rows=data?.rows.filter(row=>[row.name,row.agent,row.cwd,row.pane_id].some(text=>text?.toLowerCase().includes(query.trim().toLowerCase())))??[];
  return <section className="herdr-agents" aria-label={t('herdrAgentsTitle')} aria-busy={busy}>
    <div className="tool-bar"><h3>{t('herdrAgentsTitle')}</h3><button className="subtle-button" disabled={busy} onClick={()=>void refresh()}>{t('herdrAgentsRefresh')}</button></div>
    <p>{t('herdrAgentsHint')}</p>
    {busy && !data?.loaded && failure?.host!==sessionId && <p role="status">{t('herdrReading')}</p>}
    {failure?.host===sessionId && <div><p role="status">{t('herdrAgentsUnavailable')} {uiErrorText(failure.cause)}</p>{onRestoreHostTools && failure.cause instanceof SshControlClosedError && <button className="subtle-button" disabled={busy || !visible || !lease.current()} onClick={()=>onRestoreHostTools(()=>void refresh())}>{t('hostToolsRestore')}</button>}</div>}
    {data && <>
      {data.servers.length===0?<p>{t('herdrAgentsNoServers')}</p>:<>
        <label>{t('herdrAgentsServer')}<select value={data.server} disabled={busy} onChange={event=>selectServer(event.target.value)}>
          <option value="">{t('herdrAgentsChoose')}</option>{data.servers.map(name=><option key={name}>{name}</option>)}
        </select></label>
        <p>{t('herdrAgentsScope',{servers:formatNumber(data.servers.length)})}</p>
        {data.server && <><label>{t('herdrAgentsSearch')}<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
          {data.loaded && failure?.host!==sessionId && <p role="status">{t('herdrAgentsCount',{shown:formatNumber(rows.length),total:formatNumber(data.rows.length)})}</p>}
          <div className="live-agent-list">{rows.map(row=>{
            const referenceCount=row.agent_session?references.get(JSON.stringify([row.agent_session.agent,row.agent_session.value]))??0:0;
            return <article className="agent-card" key={JSON.stringify([sessionId,data.server,row.terminal_id,row.pane_id])}>
            <strong>{row.name??row.agent??row.pane_id}</strong>{row.name && row.agent && <p>{row.agent}</p>}
            <p>{t(herdrStatusKeys[row.agent_status])}</p>{row.cwd && <code>{row.cwd}</code>}
            {row.agent_session && <HerdrSessionDetails reference={row.agent_session} count={referenceCount} sessionId={sessionId} available={visible && lease.current()} reports={reports}/>}
            <small>{data.server} · {row.workspace_id} · {row.tab_id} · {row.pane_id}</small>
          </article>;})}</div>
        </>}
      </>}
    </>}
  </section>;
}

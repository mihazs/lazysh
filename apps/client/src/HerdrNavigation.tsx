import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useAccessSnapshot,type AccessLease} from './access';
import HerdrSessionDetails,{reportedSessionCounts,type ReportedSessionSource} from './HerdrSessionDetails';
import type {HerdrNavigationTarget} from './bridge';
import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,SshControlClosedError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {herdrStatusKeys,useHerdrNavigation,type HerdrTree,type LiveAgent} from './useHerdrNavigation';
import './HerdrNavigation.css';

export type HerdrContentReceipt=Readonly<{host:string;server:string;mode:'spaces'|'agents';identity:object;failed:boolean}>;

const statuses:LiveAgent['agent_status'][]=['blocked','working','done','idle','unknown'];
export default function HerdrNavigation({sessionId,hostLabel,herdrSession,visible,mode,reports,onOpenCompanion,onServerChange,onContentSettled,onNavigate,onAttach,onClose,onRestoreHostTools}:{
  sessionId:string;hostLabel:string;herdrSession?:string;visible:boolean;mode:'spaces'|'agents';reports?:ReportedSessionSource;
  onNavigate:(server:string,target:HerdrNavigationTarget,lease:AccessLease,current:()=>boolean)=>Promise<void>;
  onAttach:(server:string,lease:AccessLease,current:()=>boolean)=>Promise<void>;
  onContentSettled?:(receipt:HerdrContentReceipt)=>void;
  onClose:()=>void;onOpenCompanion?:()=>void;onServerChange?:()=>void;onRestoreHostTools?:(restored:()=>void)=>void;
}) {
  useUi();
  useAccessSnapshot();
  const model=useHerdrNavigation({sessionId,herdrSession,visible});
  const {data,failure,agentFailure,busy,query,setQuery,lease,refresh,selectServer}=model;
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  const [actionBusy,setActionBusy]=useState(false);
  const [actionError,setActionError]=useState<UiErrorCause>('');
  useEffect(()=>setActionError(''),[sessionId,mode,data?.server]);
  const action=useRef(false);
  const current=useRef({sessionId,visible,mode,server:data?.server});current.current={sessionId,visible,mode,server:data?.server};
  useEffect(()=>()=>{current.current={...current.current,visible:false};},[]);
  const settledCallback=useRef(onContentSettled);settledCallback.current=onContentSettled;
  const settledFailure=mode==='agents' && agentFailure?.host===sessionId?agentFailure:failure?.host===sessionId?failure:undefined;
  const settledIdentity=data?.snapshot??settledFailure??(data?.loaded?data:undefined);
  const settledFailed=!!settledFailure;
  useLayoutEffect(()=>{
    if(visible && !busy && lease.current() && !document.hidden && settledIdentity)
      settledCallback.current?.({host:sessionId,server:data?.server??'',mode,identity:settledIdentity,failed:settledFailed});
  },[sessionId,visible,busy,lease,mode,data?.server,settledIdentity,settledFailed]);
  const tree=data?.snapshot;
  const referenceCounts=reportedSessionCounts(data?.rows??[]);
  const term=query.trim().toLocaleLowerCase();
  const match=(...values:(string|null|undefined)[])=>values.some(value=>value?.toLocaleLowerCase().includes(term));
  const working=actionBusy || (busy && !data?.loaded);
  function toggle(id:string) {setCollapsed(previous=>{const next=new Set(previous);if(!next.delete(id))next.add(id);return next;});}
  async function open(target?:HerdrNavigationTarget) {
    const server=data?.server;
    if(!server || !visible || !lease.current() || action.current)return;
    action.current=true;setActionBusy(true);setActionError('');
    const owns=()=>current.current.sessionId===sessionId && current.current.visible && current.current.mode===mode && current.current.server===server && lease.current();
    try {
      if(target)await onNavigate(server,target,lease,owns);else await onAttach(server,lease,owns);
      if(owns()) {await refresh();onClose();}
    } catch(error) {if(owns())setActionError(error && typeof error==='object' && 'kind' in error && error.kind==='herdr_focus_companion_required'?new LocalUiError('herdrNavigationCompanion'):captureUiError(error));}
    finally {action.current=false;if(current.current.sessionId===sessionId)setActionBusy(false);}
  }
  function row(target:HerdrNavigationTarget,label:string,status:LiveAgent['agent_status'],context?:string) {
    return <button className="herdr-navigation-row" disabled={working} onClick={()=>void open(target)}>
      <span><strong>{label}</strong>{context && <small>{context}</small>}</span><small>{t(herdrStatusKeys[status])}</small>
    </button>;
  }
  function panes(tab:HerdrTree['tabs'][number],workspaceLabel:string) {
    return tree?.panes.filter(pane=>pane.tab_id===tab.tab_id && pane.workspace_id===tab.workspace_id).map(pane=>{
      const agent=data?.rows.find(agent=>agent.pane_id===pane.pane_id && agent.terminal_id===pane.terminal_id);
      const label=agent?.name??agent?.agent??pane.pane_id;
      if(term && !match(label,pane.cwd,pane.pane_id,workspaceLabel,tab.label))return null;
      return <li key={pane.pane_id}>{pane.terminal_id?row({kind:'pane',workspace:pane.workspace_id,tab:pane.tab_id,pane:pane.pane_id,terminal:pane.terminal_id},label,pane.agent_status,pane.cwd??undefined):<span>{label} · {t('herdrAgentUnknown')}</span>}</li>;
    });
  }
  const rows=data?.rows.filter(agent=>match(agent.name,agent.agent,agent.cwd,agent.pane_id,
    tree?.workspaces.find(value=>value.workspace_id===agent.workspace_id)?.label,
    tree?.tabs.find(value=>value.tab_id===agent.tab_id)?.label))??[];
  return <section className="herdr-navigation" hidden={!visible} aria-label={t('herdrNavigationTitle')} aria-busy={busy||actionBusy}>
    <header><div><strong>{t('herdrNavigationTitle')}</strong><small>{hostLabel}</small></div><button className="subtle-button" onClick={onClose}>{t('herdrNavigationBack')}</button></header>
    <div className="tool-bar"><button className="subtle-button" disabled={busy||actionBusy} onClick={()=>void refresh()}>{t('herdrRefresh')}</button></div>
    {failure?.host===sessionId && <div><p role="status">{t('herdrAgentsUnavailable')} {uiErrorText(failure.cause)}</p>{onRestoreHostTools && failure.cause instanceof SshControlClosedError && <button className="subtle-button" disabled={working} onClick={()=>onRestoreHostTools(()=>void refresh())}>{t('hostToolsRestore')}</button>}</div>}
    {actionError && <p className="inline-error" role="alert">{uiErrorText(actionError)}</p>}
    {actionError instanceof LocalUiError && actionError.key==='herdrNavigationCompanion' && onOpenCompanion && <button className="subtle-button" onClick={onOpenCompanion}>{t('companionInstallTitle')}</button>}
    {busy && !data?.loaded && <p role="status">{t('herdrReading')}</p>}
    {data?.servers.length===0 && <p>{t('herdrAgentsNoServers')}</p>}
    {!!data?.servers.length && <>
      <details className="herdr-server-setup" open={mode!=='agents' || !data.loaded || !data.server || failure?.host===sessionId || agentFailure?.host===sessionId ? true : undefined}>
      <summary hidden={mode!=='agents'}>{t('herdrAgentsServer')}{data.server ? ` · ${data.server}` : ''}</summary>
      <label>{t('herdrAgentsServer')}<select value={data.server} disabled={working} onChange={event=>{onServerChange?.();selectServer(event.target.value);}}><option value="">{t('herdrAgentsChoose')}</option>{data.servers.map(name=><option key={name}>{name}</option>)}</select></label>
      {data.server && <>
        <p className="muted">{t('herdrNavigationShared')}</p>
        <button className="subtle-button" disabled={working} onClick={()=>void open()}>{t('muxAttachKind',{kind:'Herdr',name:data.server})}</button>
      </>}
      </details>
      {data.server && <>
        <h3>{t(mode==='spaces'?'herdrNavigationSpaces':'herdrAgentsTitle')}</h3>
        <label>{t('herdrNavigationSearch')}<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
        {query && <button className="subtle-button" onClick={()=>setQuery('')}>{t('agentsClearFilters')}</button>}
        {mode==='spaces' && tree && <ul className="herdr-navigation-tree">{tree.workspaces.map(workspace=>{
          const tabs=tree.tabs.filter(tab=>tab.workspace_id===workspace.workspace_id);
          if(term && !match(workspace.label,workspace.workspace_id) && !tabs.some(tab=>match(tab.label,tab.tab_id) || tree.panes.some(pane=>pane.tab_id===tab.tab_id && match(pane.cwd,pane.pane_id,data.rows.find(agent=>agent.pane_id===pane.pane_id)?.name,data.rows.find(agent=>agent.pane_id===pane.pane_id)?.agent))))return null;
          const key=JSON.stringify([data.server,workspace.workspace_id]);
          return <li key={workspace.workspace_id}><div className="herdr-navigation-heading"><button className="subtle-button" aria-expanded={term?true:!collapsed.has(key)} aria-label={t('herdrNavigationCollapse',{name:workspace.label})} onClick={()=>toggle(key)}>{collapsed.has(key)&&!term?'▸':'▾'}</button>{row({kind:'workspace',workspace:workspace.workspace_id},workspace.label,workspace.agent_status)}</div>
            {(term||!collapsed.has(key)) && <ul>{tabs.map(tab=>{
              const tabKey=JSON.stringify([data.server,tab.tab_id]);
              return <li key={tab.tab_id}><div className="herdr-navigation-heading"><button className="subtle-button" aria-expanded={term?true:!collapsed.has(tabKey)} aria-label={t('herdrNavigationCollapse',{name:tab.label})} onClick={()=>toggle(tabKey)}>{collapsed.has(tabKey)&&!term?'▸':'▾'}</button>{row({kind:'tab',workspace:tab.workspace_id,tab:tab.tab_id},tab.label,tab.agent_status)}</div>{(term||!collapsed.has(tabKey)) && <ul>{panes(tab,workspace.label)}</ul>}</li>;
            })}</ul>}
          </li>;
        })}</ul>}
        {mode==='agents' && (agentFailure?<p role="status">{uiErrorText(agentFailure.cause)}</p>:<div>{statuses.map(status=>{
          const matching=rows.filter(agent=>agent.agent_status===status);
          return matching.length>0 && <section key={status} aria-label={t(herdrStatusKeys[status])}><h4>{t(herdrStatusKeys[status])} · {matching.length}</h4>{matching.map(agent=><div key={JSON.stringify([agent.terminal_id,agent.pane_id])}>{row({kind:'pane',workspace:agent.workspace_id,tab:agent.tab_id,pane:agent.pane_id,terminal:agent.terminal_id},agent.name??agent.agent??agent.pane_id,status,[tree?.workspaces.find(value=>value.workspace_id===agent.workspace_id)?.label,tree?.tabs.find(value=>value.tab_id===agent.tab_id)?.label,agent.cwd].filter(Boolean).join(' / '))}{agent.agent_session && <HerdrSessionDetails reference={agent.agent_session} count={referenceCounts.get(JSON.stringify([agent.agent_session.agent,agent.agent_session.value]))??0} sessionId={sessionId} available={visible && lease.current()} reports={reports}/>}</div>)}</section>;
        })}{data.loaded && rows.length===0 && <p>{t('herdrNavigationEmpty')}</p>}</div>)}
      </>}
    </>}
  </section>;
}

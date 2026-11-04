import {ArrowLeft,ChevronDown,ChevronRight,RefreshCw,Settings2,Info} from 'lucide-react';
import {StatusRing,agentKind,type StatusTone} from './AgentStatus';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {useAccessSnapshot,type AccessLease} from './access';
import {HerdrWorkspaceCreate,HerdrWorktreeCreate} from './HerdrWorkspaceCreateDialog';
import HerdrSessionDetails,{reportedSessionCounts,type ReportedSessionSource} from './HerdrSessionDetails';
import type {HerdrNavigationTarget} from './bridge';
import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,SshControlClosedError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {herdrStatusKeys,useHerdrNavigation,type HerdrTree,type LiveAgent} from './useHerdrNavigation';
import './HerdrNavigation.css';
import './HerdrNavigationPresentation.css';

export type HerdrContentReceipt=Readonly<{host:string;server:string;mode:'spaces'|'agents';identity:object;failed:boolean}>;

const statuses:LiveAgent['agent_status'][]=['blocked','working','done','idle','unknown'];
const tones:Record<LiveAgent['agent_status'],StatusTone>={blocked:'attention',working:'working',done:'done',idle:'idle',unknown:'unknown'};
export default function HerdrNavigation({sessionId,hostLabel,herdrSession,visible,mode,reports,onOpenCompanion,onServerChange,onContentSettled,onNavigate,onAttach,onClose,onRestoreHostTools}:{
  sessionId:string;hostLabel:string;herdrSession?:string;visible:boolean;mode:'spaces'|'agents';reports?:ReportedSessionSource;
  onNavigate:(server:string,target:HerdrNavigationTarget,lease:AccessLease,current:()=>boolean)=>Promise<void>;
  onAttach:(server:string,lease:AccessLease,current:()=>boolean)=>Promise<void>;
  onContentSettled?:(receipt:HerdrContentReceipt)=>void;
  onClose:()=>void;onOpenCompanion?:()=>void;onServerChange?:()=>void;onRestoreHostTools?:(restored:()=>void)=>void;
}) {
  useUi();
  useAccessSnapshot();
  const model=useHerdrNavigation({sessionId,herdrSession,visible,reports});
  const {data,failure,agentFailure,busy,query,setQuery,lease,refresh,selectServer}=model;
  const [collapsed,setCollapsed]=useState<Set<string>>(()=>new Set());
  const [setupView,setSetupView]=useState<{host:string;open:boolean}>();
  const setupTrigger=useRef<HTMLButtonElement>(null);
  const setupHeading=useRef<HTMLHeadingElement>(null);
  const setupFocus=useRef<'heading'|'trigger'|undefined>(undefined);
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
  function row(target:HerdrNavigationTarget,label:string,status:LiveAgent['agent_status'],context?:string,kind?:string|null) {
    const selected=target.kind==='workspace'?tree?.workspaces.some(item=>item.workspace_id===target.workspace&&item.focused):target.kind==='tab'?tree?.tabs.some(item=>item.tab_id===target.tab&&item.focused):tree?.panes.some(item=>item.pane_id===target.pane&&item.terminal_id===target.terminal&&item.focused);
    const agentRow=mode==='agents' && target.kind==='pane';
    return <button className="herdr-navigation-row" data-agent-status={status} data-current={selected||undefined} disabled={working} onClick={()=>void open(target)}>
      {agentRow && <StatusRing tone={tones[status]}/>}
      <span><strong>{label}</strong>{context && <small title={context}>{context}</small>}{agentRow && <span className="row-tags" aria-hidden="true">{kind && <span className="row-tag" data-agent-kind={agentKind(kind)}>{kind}</span>}<span className="row-tag-status">{t(herdrStatusKeys[status])}</span></span>}</span><small className={mode==='agents'?'sr-only':undefined}>{t(herdrStatusKeys[status])}</small>
      {agentRow && <ChevronRight className="row-chevron" size={18} aria-hidden="true"/>}
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
  const create={sessionId,server:data?.server??'',lease,tree,reports,disabled:working,onCreated:(workspace:string)=>void open({kind:'workspace',workspace})};
  const failedHere=failure?.host===sessionId || agentFailure?.host===sessionId;
  const needsSetup=!data?.loaded || !data.server || failedHere;
  useEffect(()=>setSetupView(undefined),[sessionId,data?.server,failedHere]);
  const setupRequested=setupView?.host===sessionId && setupView.open;
  const setupOpen=setupView?.host===sessionId?setupView.open:needsSetup;
  function showSetup(open:boolean) {setupFocus.current=open?'heading':'trigger';setSetupView({host:sessionId,open});}
  useLayoutEffect(()=>{
    if(visible && lease.current() && !document.hidden && setupFocus.current)(setupFocus.current==='heading'?setupHeading.current:setupTrigger.current)?.focus();
    setupFocus.current=undefined;
  },[setupOpen,visible,lease]);
  useEffect(()=>{
    const back=(event:Event)=>{if(visible && setupRequested && lease.current() && !document.querySelector('[role="dialog"][aria-modal="true"]')){event.preventDefault();event.stopImmediatePropagation();showSetup(false);}};
    window.addEventListener('lazysh-workspace-back',back,true);
    return()=>window.removeEventListener('lazysh-workspace-back',back,true);
  },[visible,setupRequested,sessionId,lease]);
  const rows=data?.rows.filter(agent=>match(agent.name,agent.agent,agent.cwd,agent.pane_id,
    tree?.workspaces.find(value=>value.workspace_id===agent.workspace_id)?.label,
    tree?.tabs.find(value=>value.tab_id===agent.tab_id)?.label))??[];
  return <section className="herdr-navigation" data-mode={mode} data-setup-view={setupOpen||undefined} hidden={!visible} aria-label={t('herdrNavigationTitle')} aria-busy={busy||actionBusy} onKeyDownCapture={event=>{if(event.key==='Escape' && setupRequested){event.preventDefault();event.stopPropagation();showSetup(false);}}}>
    <header><div><h3 ref={setupHeading} tabIndex={-1}>{t(setupOpen?'herdrAgentsServer':mode==='spaces'?'herdrNavigationSpaces':'herdrAgentsTitle')}</h3><small>{hostLabel}</small></div>{!setupOpen && <button className="icon-button" ref={setupTrigger} title={t('herdrAgentsServer')} aria-label={t('herdrAgentsServer')} onClick={()=>showSetup(true)}><Settings2 size={18} aria-hidden="true"/></button>}{data?.server && mode==='spaces' && <details className="herdr-shared-focus-note muted" onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget))event.currentTarget.open=false;}} onKeyDownCapture={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}><summary aria-label={t('herdrSharedFocusShort')} title={t('herdrSharedFocusShort')}><Info size={17} aria-hidden="true"/></summary><p>{t('herdrNavigationShared')}</p></details>}<button className="icon-button" title={t('herdrRefresh')} disabled={busy||actionBusy} onClick={()=>void refresh()}><RefreshCw size={18} aria-hidden="true"/><span className="sr-only">{t('herdrRefresh')}</span></button><button className="icon-button herdr-navigation-back" title={t(setupRequested?'navigationBack':'herdrNavigationBack')} onClick={()=>setupRequested?showSetup(false):onClose()}><ArrowLeft size={18} aria-hidden="true"/><span className="sr-only">{t(setupRequested?'navigationBack':'herdrNavigationBack')}</span></button></header>
    {failure?.host===sessionId && <div><p role="status">{t('herdrAgentsUnavailable')} {uiErrorText(failure.cause)}</p>{onRestoreHostTools && failure.cause instanceof SshControlClosedError && <button className="subtle-button" disabled={working} onClick={()=>onRestoreHostTools(()=>void refresh())}>{t('hostToolsRestore')}</button>}</div>}
    {actionError && <p className="inline-error" role="alert">{uiErrorText(actionError)}</p>}
    {actionError instanceof LocalUiError && actionError.key==='herdrNavigationCompanion' && onOpenCompanion && <button className="subtle-button" onClick={onOpenCompanion}>{t('companionInstallTitle')}</button>}
    {busy && !data?.loaded && <p role="status">{t('herdrReading')}</p>}
    {data?.servers.length===0 && <p>{t('herdrAgentsNoServers')}</p>}
    {!!data?.servers.length && <>

      <section className="herdr-server-setup" hidden={!setupOpen} aria-label={t('herdrAgentsServer')}>
      <label>{t('herdrAgentsServer')}<select value={data.server} disabled={working} onChange={event=>{onServerChange?.();selectServer(event.target.value);}}><option value="">{t('herdrAgentsChoose')}</option>{data.servers.map(name=><option key={name}>{name}</option>)}</select></label>
      {data.server && <>
        {mode==='agents' && <p className="muted">{t('herdrNavigationShared')}</p>}
        <button className="subtle-button" disabled={working} onClick={()=>void open()}>{t('muxAttachKind',{kind:'Herdr',name:data.server})}</button>
      </>}
      </section>
      <div hidden={setupOpen}>
      {data.server && <>
        <label><span className="sr-only">{t(mode==='agents'?'herdrLiveSearch':'herdrNavigationSearch')}</span><input type="search" placeholder={t(mode==='agents'?'herdrLiveSearch':'herdrNavigationSearch')} value={query} onChange={event=>setQuery(event.target.value)}/></label>
        {query && <button className="subtle-button" onClick={()=>setQuery('')}>{t('agentsClearFilters')}</button>}
        {mode==='spaces' && tree && <HerdrWorkspaceCreate {...create}/>}
        {mode==='spaces' && tree && <ul className="herdr-navigation-tree">{tree.workspaces.map(workspace=>{
          const tabs=tree.tabs.filter(tab=>tab.workspace_id===workspace.workspace_id);
          if(term && !match(workspace.label,workspace.workspace_id) && !tabs.some(tab=>match(tab.label,tab.tab_id) || tree.panes.some(pane=>pane.tab_id===tab.tab_id && match(pane.cwd,pane.pane_id,data.rows.find(agent=>agent.pane_id===pane.pane_id)?.name,data.rows.find(agent=>agent.pane_id===pane.pane_id)?.agent))))return null;
          const key=JSON.stringify([data.server,workspace.workspace_id]);
          return <li key={workspace.workspace_id}><div className="herdr-navigation-heading"><button className="subtle-button" aria-expanded={term?true:!collapsed.has(key)} aria-label={t('herdrNavigationCollapse',{name:workspace.label})} onClick={()=>toggle(key)}>{collapsed.has(key)&&!term?'▸':'▾'}</button>{row({kind:'workspace',workspace:workspace.workspace_id},workspace.label,workspace.agent_status)}<HerdrWorktreeCreate {...create} tree={tree} workspace={workspace}/></div>
            {(term||!collapsed.has(key)) && <ul>{tabs.map(tab=>{
              const tabKey=JSON.stringify([data.server,tab.tab_id]);
              return <li key={tab.tab_id}><div className="herdr-navigation-heading"><button className="subtle-button" aria-expanded={term?true:!collapsed.has(tabKey)} aria-label={t('herdrNavigationCollapse',{name:tab.label})} onClick={()=>toggle(tabKey)}>{collapsed.has(tabKey)&&!term?'▸':'▾'}</button>{row({kind:'tab',workspace:tab.workspace_id,tab:tab.tab_id},tab.label,tab.agent_status)}</div>{(term||!collapsed.has(tabKey)) && <ul>{panes(tab,workspace.label)}</ul>}</li>;
            })}</ul>}
          </li>;
        })}</ul>}
        {mode==='agents' && (agentFailure?<p role="status">{uiErrorText(agentFailure.cause)}</p>:<div className="herdr-status-groups">{statuses.map(status=>{
          const matching=rows.filter(agent=>agent.agent_status===status);
          const key=JSON.stringify(['status',data.server,status]),folded=collapsed.has(key)&&!term,heading=`${t(herdrStatusKeys[status])} · ${matching.length}`;
          return matching.length>0 && <section key={status} className="status-group" data-status={status} aria-label={t(herdrStatusKeys[status])}><h4 aria-label={heading}><button type="button" className="status-group-toggle" aria-label={heading} aria-expanded={!folded} onClick={()=>toggle(key)}><span>{t(herdrStatusKeys[status])}</span><span className="status-group-count">{matching.length}</span>{folded?<ChevronRight size={16} aria-hidden="true"/>:<ChevronDown size={16} aria-hidden="true"/>}</button></h4>{!folded && <div className="status-group-rows">{matching.map(agent=><div className="herdr-agent-row" key={JSON.stringify([agent.terminal_id,agent.pane_id])}>{row({kind:'pane',workspace:agent.workspace_id,tab:agent.tab_id,pane:agent.pane_id,terminal:agent.terminal_id},agent.name??agent.agent??agent.pane_id,status,[tree?.workspaces.find(value=>value.workspace_id===agent.workspace_id)?.label,tree?.tabs.find(value=>value.tab_id===agent.tab_id)?.label,agent.cwd].filter(Boolean).join(' / '),agent.name?agent.agent:null)}{agent.agent_session && <HerdrSessionDetails reference={agent.agent_session} count={referenceCounts.get(JSON.stringify([agent.agent_session.agent,agent.agent_session.value]))??0} sessionId={sessionId} available={visible && lease.current()} reports={reports}/>}</div>)}</div>}</section>;
        })}{data.loaded && rows.length===0 && <p>{t('herdrNavigationEmpty')}</p>}</div>)}
      </>}
      </div>
    </>}
  </section>;
}

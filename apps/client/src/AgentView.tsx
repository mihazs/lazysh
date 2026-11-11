import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {Ellipsis,TerminalSquare} from 'lucide-react';
import ChatPanel, {type BoundConversation} from './ChatPanel';
import HerdrAgentsPanel, {EnterSessionButton} from './HerdrAgentsPanel';
import {parseReportedHistory, parseSnapshot, reportedStateNames, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot, type TerminalInputLabels} from './ChatTerminalInput';
import {StatusRing, herdrTones, reportedTones} from './AgentStatus';
import {herdrStatusKeys} from './useHerdrNavigation';
import {formatRelativeTime, pathBasename} from './relativeTime';
import {bindProtectedInvoke, captureAccess, useAccessSnapshot, type AccessLease} from './access';
import type {HerdrNavigationTarget} from './bridge';
import {formatNumber, t, useUi} from './i18n/core';
import './AgentView.css';

const conversationAgents: Record<string, BoundConversation['agent']> = {'Claude Code': 'claude', Codex: 'codex'};
const agentNames: Record<BoundConversation['agent'], string> = {claude: 'Claude Code', codex: 'Codex'};
type Binding = {kind: 'finding'} | {kind: 'none'} | {kind: 'partial'; row: AgentSession} | {kind: 'bound'; row: AgentSession; conversation: BoundConversation};

/** Another view of the same live session: the agent conversation that hook reports tie to this terminal's pane.
 * It never writes to the terminal; input goes through the confirmed input or Stage like Chat. */
export default function AgentView({sessionId, shown, tmux, herdrSession, terminalInput, onShowTerminal, onEnterHerdr, onOpenCompanion}: {
  sessionId: string; shown: boolean; tmux: boolean; herdrSession?: string; terminalInput?: TerminalInputLabels; onShowTerminal: () => void;
  onEnterHerdr?:(name:string,target:HerdrNavigationTarget,owner:AccessLease,current:()=>boolean)=>Promise<void>;onOpenCompanion?:()=>void;
}) {
  useUi();
  useAccessSnapshot();
  const [access] = useState(captureAccess);
  const invoke = useMemo(() => bindProtectedInvoke(access), [access]);
  const [binding, setBinding] = useState<Binding>({kind: 'finding'});
  const [sessions,setSessions] = useState<AgentSession[]>([]);
  const [selected,setSelected] = useState<{row?:AgentSession;conversation:BoundConversation;title?:string;status?:keyof typeof herdrStatusKeys;enter?:{server:string;target:HerdrNavigationTarget}}>();
  const [selecting,setSelecting] = useState(false);
  const [choosing,setChoosing] = useState(false);
  const [unavailable,setUnavailable] = useState(false);
  const [menu,setMenu] = useState(false);
  const menuId = useId();
  const [usage,setUsage] = useState<Record<string,number|string>>();
  const trackUsage = useCallback((next?:Record<string,number|string>)=>setUsage(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next),[]);
  const request=useRef(0);
  const active=useRef({sessionId,shown});active.current={sessionId,shown};
  const retained = useRef<{id:string;conversation:BoundConversation} | undefined>(undefined);
  useEffect(() => {
    if (!shown) {setSelecting(false);return;}
    // Under Herdr the live agents are the evidence; stale hook reports (no pane identity) are not listed.
    if (herdrSession) {setSessions([]);setBinding({kind:'none'});return;}
    let alive = true, flight = false;
    async function bind() {
      if (flight || document.visibilityState === 'hidden' || !access.current()) return;
      flight = true;
      try {
        const reports = parseSnapshot(await invoke('agent_snapshot', {sessionId}));
        if (!alive || !access.current()) return;
        setSessions(reports.filter(row=>!!conversationAgents[row.agent] && reports.filter(other=>other.sessionId===row.sessionId).length===1));
        // Pane identity is the evidence: only TMUX_PANE ties a hook report to this terminal.
        const pane = tmux ? parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId : undefined;
        const matching = pane === undefined ? [] : reports.filter(row => row.paneId === pane);
        const row = matching.length===1 ? matching[0] : undefined;
        const agent = row && conversationAgents[row.agent];
        let conversation:BoundConversation | undefined;
        if (row && agent) {
          try {
            const history = parseReportedHistory(await invoke('agent_reported_history', {sessionId, agentSessionId: row.sessionId}), row.sessionId);
            if (history.status === 'available' && history.paneId === pane) conversation=Object.freeze({agent, path: history.path,report:{sessionId:row.sessionId,agent:row.agent,paneId:pane}});
          } catch { /* A detected agent remains visible when its history is unavailable. */ }
        }
        if (alive && access.current()) setBinding(previous => !row ? {kind: 'none'} : !conversation ? {kind: 'partial', row}
          : {kind: 'bound', row, conversation: previous.kind === 'bound' && previous.conversation.path === conversation.path && previous.conversation.agent === conversation.agent && previous.conversation.report?.sessionId === conversation.report?.sessionId && previous.conversation.report?.paneId === conversation.report?.paneId ? previous.conversation : conversation});
      } catch {
        if (alive && access.current()) {setSessions([]);setBinding({kind:'none'});}
      } finally { flight = false; }
    }
    void bind();
    const timer = setInterval(() => void bind(), 5000);
    return () => {alive = false; request.current++; clearInterval(timer);};
  }, [shown, sessionId, tmux, herdrSession, invoke, access]);
  useEffect(()=>{
    if(!menu)return;
    if(!shown){setMenu(false);return;}
    const close=(event:Event)=>{if(event.type==='keydown'?(event as KeyboardEvent).key==='Escape':!(event.target as Element).closest('.agent-view-menu,.agent-view-header'))setMenu(false);};
    document.addEventListener('keydown',close);document.addEventListener('pointerdown',close);
    return()=>{document.removeEventListener('keydown',close);document.removeEventListener('pointerdown',close);};
  },[menu,shown]);
  async function openSession(chosen:AgentSession) {
    if(selecting || !shown || !access.current())return;
    const id=++request.current;setSelecting(true);setUnavailable(false);
    const owns=()=>request.current===id && active.current.shown && active.current.sessionId===sessionId && access.current();
    try {
      const history=parseReportedHistory(await invoke('agent_reported_history',{sessionId,agentSessionId:chosen.sessionId}),chosen.sessionId);
      if(!owns())return;
      const reports=parseSnapshot(await invoke('agent_snapshot',{sessionId}));
      const matches=reports.filter(row=>row.sessionId===chosen.sessionId);
      if(!owns())return;
      if(history.status!=='available' || matches.length!==1 || matches[0].agent!==chosen.agent) {setUnavailable(true);return;}
      setSelected({row:matches[0],conversation:Object.freeze({agent:conversationAgents[chosen.agent],path:history.path,report:{sessionId:chosen.sessionId,agent:chosen.agent}})});
    } catch {if(owns())setUnavailable(true);}
    finally {if(owns())setSelecting(false);}
  }
  const row = selected ? selected.row : (binding.kind === 'bound' || binding.kind === 'partial' ? binding.row : undefined);
  const conversation=selected?.conversation ?? (binding.kind==='bound'?binding.conversation:undefined);
  const reader=!!conversation;
  if (!selected && binding.kind==='bound') retained.current={id:binding.row.sessionId,conversation:binding.conversation};
  const kept=selected?.conversation ?? retained.current?.conversation;
  const title = selected?.title ?? (row ? [row.agent, row.project && pathBasename(row.project)].filter(Boolean).join(' · ') : t('agentViewTitle'));
  const state = selected?.status ? {tone: herdrTones[selected.status], name: t(herdrStatusKeys[selected.status])}
    : row ? {tone: reportedTones[row.state], name: t(reportedStateNames[row.state])} : undefined;
  const counts = usage && ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].some(key=>usage[key]!==undefined) ? (key:string)=>formatNumber(Number(usage[key] ?? 0)) : undefined;
  const back = ()=>{request.current++;setSelected(undefined);setChoosing(true);setUnavailable(false);setMenu(false);};
  // One compact row: what the chat belongs to and its state. Everything else waits behind the options button.
  return <section className="agent-view" hidden={!shown} aria-label={t('agentViewTitle')}>
    <header className="agent-view-header">
      {state && <StatusRing tone={state.tone} />}
      <strong title={title}>{title}</strong>
      {state && <span title={row && !selected?.status ? t('agentViewLastReportedState', {state: state.name}) : undefined}>{state.name}</span>}
      <button type="button" className="icon-button" aria-label={t('agentViewOptions')} title={t('agentViewOptions')} aria-expanded={menu} aria-controls={menuId} onClick={()=>setMenu(value=>!value)}><Ellipsis size={18} aria-hidden="true"/></button>
      <button type="button" className="icon-button" aria-label={t('agentViewTerminal')} title={t('agentViewTerminal')} onClick={onShowTerminal}><TerminalSquare size={18} aria-hidden="true"/></button>
    </header>
    {menu && <div id={menuId} className="agent-view-menu" role="group" aria-label={t('agentViewOptions')}>
      {!selected && reader && <button type="button" aria-expanded={choosing} onClick={()=>{setChoosing(value=>!value);setMenu(false);}}>{t('agentViewSessions')}</button>}
      {selected && <button type="button" onClick={back}>{t('agentViewBackSessions')}</button>}
      {selected?.enter && onEnterHerdr && <EnterSessionButton server={selected.enter.server} target={selected.enter.target} lease={access} enabled={shown} onEnterHerdr={onEnterHerdr} owner={()=>()=>active.current.shown && active.current.sessionId===sessionId && access.current()}/>}
      {/* The safety rule is unchanged: a shown conversation grants no terminal input beyond the confirmed-input flow. */}
      {selected && <p>{t('agentViewSelectedNoStage')}</p>}
      {selected?.conversation.herdr && <p>{t('agentsHerdrSessionNotice')}</p>}
      {reader && !selected && !terminalInput && <p>{t('agentViewStageOnly')}</p>}
      {reader && counts && <p>{t('agentViewUsage', {input: counts('inputTokens'), output: counts('outputTokens'), read: counts('cacheReadTokens'), write: counts('cacheWriteTokens')})}</p>}
    </div>}
    {binding.kind === 'finding' && !selected && <p role="status">{t('agentViewFinding')}</p>}
    {!reader && !herdrSession && binding.kind !== 'finding' && <div className="agent-view-fallback">
      <p>{binding.kind === 'partial' ? t('agentViewPartial', {agent: binding.row.agent}) : t('agentViewNoConversation')}</p>
      <div className="button-row">
        <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
      </div>
    </div>}
    {!selected && !herdrSession && (!reader || choosing) && access.current() && sessions.length>0 && <section className="agent-view-picker" aria-label={t('agentViewSessions')}><h3>{t('agentViewSessions')}</h3>
      {unavailable && <p role="alert">{t('agentViewSessionUnavailable')}</p>}
      {sessions.map(session=><button type="button" key={session.sessionId} disabled={selecting} onClick={()=>void openSession(session)}>{session.agent} · {session.project} · {t('agentViewLastReportedState', {state:t(reportedStateNames[session.state])})} · {formatRelativeTime(session.updatedAt)}</button>)}</section>}
    {herdrSession && !selected && (!reader || choosing) && <HerdrAgentsPanel sessionId={sessionId} herdrSession={herdrSession} visible={shown} onEnterHerdr={onEnterHerdr} onChooseSession={(row,server)=>{
      request.current++;setSelecting(false);setUnavailable(false);
      const agent=row.agent_session.agent as BoundConversation['agent'];
      setSelected({title:[agentNames[agent],row.cwd && pathBasename(row.cwd)].filter(Boolean).join(' · '),status:row.agent_status,enter:{server,target:{kind:'pane',workspace:row.workspace_id,tab:row.tab_id,pane:row.pane_id,terminal:row.terminal_id}},
        conversation:Object.freeze({agent,path:row.agent_session.value,herdr:{herdrSession:server,paneId:row.pane_id,terminalId:row.terminal_id}})});}} />}
    {kept && <ChatPanel key={selected ? JSON.stringify(selected.conversation) : retained.current?.id} sessionId={sessionId} shown={shown && reader}
      bound={kept} onOpenCompanion={onOpenCompanion} allowStage={!selected} onBoundInvalid={!selected?()=>setBinding(previous=>previous.kind==='bound' && previous.conversation===kept?{kind:'partial',row:previous.row}:previous):undefined} timeline onOpenTerminal={onShowTerminal} terminalInput={!selected && reader ? terminalInput : undefined} onUsage={trackUsage} />}
  </section>;
}

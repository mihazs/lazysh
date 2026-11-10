import {useEffect, useMemo, useRef, useState} from 'react';
import {List,TerminalSquare} from 'lucide-react';
import ChatPanel, {type BoundConversation} from './ChatPanel';
import HerdrAgentsPanel from './HerdrAgentsPanel';
import {parseReportedHistory, parseSnapshot, reportedStateNames, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot, type TerminalInputLabels} from './ChatTerminalInput';
import {StatusRing, reportedTones} from './AgentStatus';
import {bindProtectedInvoke, captureAccess, useAccessSnapshot, type AccessLease} from './access';
import type {HerdrNavigationTarget} from './bridge';
import {t, useUi} from './i18n/core';
import './AgentView.css';

const conversationAgents: Record<string, BoundConversation['agent']> = {'Claude Code': 'claude', Codex: 'codex'};
type Binding = {kind: 'finding'} | {kind: 'none'} | {kind: 'partial'; row: AgentSession} | {kind: 'bound'; row: AgentSession; conversation: BoundConversation};

/** Another view of the same live session: the agent conversation that hook reports tie to this terminal's pane.
 * It never writes to the terminal; input goes through the confirmed input or Stage like Chat. */
export default function AgentView({sessionId, shown, tmux, herdrSession, terminalInput, onShowTerminal, onEnterHerdr}: {
  sessionId: string; shown: boolean; tmux: boolean; herdrSession?: string; terminalInput?: TerminalInputLabels; onShowTerminal: () => void;
  onEnterHerdr?:(name:string,target:HerdrNavigationTarget,owner:AccessLease,current:()=>boolean)=>Promise<void>;
}) {
  useUi();
  useAccessSnapshot();
  const [access] = useState(captureAccess);
  const invoke = useMemo(() => bindProtectedInvoke(access), [access]);
  const [binding, setBinding] = useState<Binding>({kind: 'finding'});
  const [sessions,setSessions] = useState<AgentSession[]>([]);
  const [selected,setSelected] = useState<{row?:AgentSession;conversation:BoundConversation}>();
  const [selecting,setSelecting] = useState(false);
  const [choosing,setChoosing] = useState(false);
  const [unavailable,setUnavailable] = useState(false);
  const request=useRef(0);
  const active=useRef({sessionId,shown});active.current={sessionId,shown};
  const retained = useRef<{id:string;conversation:BoundConversation} | undefined>(undefined);
  useEffect(() => {
    if (!shown) {setSelecting(false);return;}
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
  }, [shown, sessionId, tmux, invoke, access]);
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
  return <section className="agent-view" hidden={!shown} aria-label={t('agentViewTitle')}>
    <header className="agent-view-header">
      {row ? <>
        <StatusRing tone={reportedTones[row.state]} />
        <strong>{row.agent}</strong>
        <span>{t('agentViewLastReportedState', {state:t(reportedStateNames[row.state])})}</span>
      </> : <strong>{t('agentViewTitle')}</strong>}
      {!selected && reader && <button type="button" className="icon-button" aria-label={t('agentViewSessions')} title={t('agentViewSessions')} aria-expanded={choosing} onClick={()=>setChoosing(value=>!value)}><List size={18} aria-hidden="true"/></button>}
      <button type="button" className="subtle-button" onClick={onShowTerminal}><TerminalSquare size={18} aria-hidden="true" />{t('agentViewTerminal')}</button>
    </header>
    {binding.kind === 'finding' && !selected && <p role="status">{t('agentViewFinding')}</p>}
    {!reader && binding.kind !== 'finding' && <div className="agent-view-fallback">
      {!herdrSession && <p>{binding.kind === 'partial' ? t('agentViewPartial', {agent: binding.row.agent}) : t('agentViewNoConversation')}</p>}
      <div className="button-row">
        <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
      </div>
    </div>}
    {!selected && (!reader || choosing) && access.current() && sessions.length>0 && <section aria-label={t('agentViewSessions')}><h3>{t('agentViewSessions')}</h3>{sessions.map(session=><button type="button" key={session.sessionId} disabled={selecting} onClick={()=>void openSession(session)}>{session.agent} · {session.project} · {t('agentViewLastReportedState', {state:t(reportedStateNames[session.state])})} · {session.sessionId}</button>)}</section>}
    {unavailable && <p role="status">{t('agentViewSessionUnavailable')}</p>}
    {herdrSession && !selected && (!reader || choosing) && <HerdrAgentsPanel sessionId={sessionId} herdrSession={herdrSession} visible={shown} onEnterHerdr={onEnterHerdr} onChooseSession={(agent,id,server,paneId,terminalId)=>{request.current++;setSelecting(false);setUnavailable(false);setSelected({conversation:Object.freeze({agent,path:id,herdr:{herdrSession:server,paneId,terminalId}})});}} />}
    {selected && <button type="button" onClick={()=>{request.current++;setSelected(undefined);setChoosing(true);setUnavailable(false);}}>{t('agentViewBackSessions')}</button>}
    {reader && selected && <p className="agent-view-note">{t('agentViewSelectedNoStage')}</p>}
    {reader && !selected && !terminalInput && <p className="agent-view-note">{t('agentViewStageOnly')}</p>}
    {kept && <ChatPanel key={selected ? JSON.stringify(selected.conversation) : retained.current?.id} sessionId={sessionId} shown={shown && reader}
      bound={kept} allowStage={!selected} onBoundInvalid={!selected?()=>setBinding(previous=>previous.kind==='bound' && previous.conversation===kept?{kind:'partial',row:previous.row}:previous):undefined} timeline onOpenTerminal={onShowTerminal} terminalInput={!selected && reader ? terminalInput : undefined} />}
  </section>;
}

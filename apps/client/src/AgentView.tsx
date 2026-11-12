import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {Ellipsis,TerminalSquare} from 'lucide-react';
import ChatPanel, {type BoundConversation} from './ChatPanel';
import AgentComposer, {type ComposerProof} from './AgentComposer';
import HerdrAgentsPanel, {EnterSessionButton} from './HerdrAgentsPanel';
import {HerdrWorkspaceCreate} from './HerdrWorkspaceCreateDialog';
import {focusedPane,type LinkedAgent} from './herdrPaneLink';
import AgentApprovalDock from './AgentApprovalDock';
import {publishAnswerGuard} from './agentDialogAnswer';
import {parseReportedHistory, parseSnapshot, reportedStateNames, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot, type TerminalInputLabels} from './ChatTerminalInput';
import {StatusRing, herdrTones, reportedTones} from './AgentStatus';
import {herdrStatusKeys, useHerdrNavigation} from './useHerdrNavigation';
import {formatRelativeTime, pathBasename, useNow} from './relativeTime';
import {WaitingLabel, waitingFirst, waitingKeys, waitingKind} from './AgentWaiting';
import {bindProtectedInvoke, captureAccess, useAccessSnapshot, type AccessLease} from './access';
import type {HerdrNavigationTarget} from './bridge';
import {formatNumber, t, useUi} from './i18n/core';
import './AgentView.css';

const conversationAgents: Record<string, BoundConversation['agent']> = {'Claude Code': 'claude', Codex: 'codex'};
const agentNames: Record<BoundConversation['agent'], string> = {claude: 'Claude Code', codex: 'Codex'};
/** What the view shows: a conversation, who it belongs to and, for a Herdr pick, how to enter its pane.
 * `linked` marks the agent of the focused pane; any other pick is the user's own choice and says so. */
type Selection = {row?:AgentSession;conversation:BoundConversation;cwd?:string;title?:string;place?:string;status?:keyof typeof herdrStatusKeys;linked?:boolean;focusKey?:string;enter?:{server:string;target:HerdrNavigationTarget}};
function herdrSelection(row:LinkedAgent,server:string,extra:Partial<Selection>):Selection {
  const agent=row.agent_session.agent as BoundConversation['agent'];
  return {cwd:row.cwd ?? undefined,title:[agentNames[agent],row.cwd && pathBasename(row.cwd)].filter(Boolean).join(' · '),status:row.agent_status,
    conversation:Object.freeze({agent,path:row.agent_session.value,herdr:{herdrSession:server,paneId:row.pane_id,terminalId:row.terminal_id}}),...extra};
}
/** Start Claude Code or Codex in the terminal you are in: the command is staged for review in the terminal composer, never run from here. */
function StartButtons({sessionId}:{sessionId:string}) {
  return <>{(['claude','codex'] as const).map(agent=><button type="button" key={agent} onClick={()=>window.dispatchEvent(new CustomEvent('lazysh-prompt-draft',{detail:{sessionId,text:agent}}))}>{t('agentViewStartNamed',{agent:agentNames[agent]})}</button>)}</>;
}
type Binding = {kind: 'finding'} | {kind: 'none'} | {kind: 'partial'; row: AgentSession} | {kind: 'bound'; row: AgentSession; conversation: BoundConversation};

/** Another view of the same live session: the agent conversation that hook reports tie to this terminal's pane.
 * It never writes to the terminal; input goes through the confirmed input or Stage like Chat. */
export default function AgentView({sessionId, shown, tmux, herdrSession, herdrLaunch, terminalInput, onShowTerminal, onEnterHerdr, onOpenCompanion}: {
  sessionId: string; shown: boolean; tmux: boolean; herdrSession?: string; herdrLaunch?: boolean; terminalInput?: TerminalInputLabels; onShowTerminal: () => void;
  onEnterHerdr?:(name:string,target:HerdrNavigationTarget,owner:AccessLease,current:()=>boolean)=>Promise<void>;onOpenCompanion?:()=>void;
}) {
  useUi();
  useAccessSnapshot();
  const [access] = useState(captureAccess);
  const invoke = useMemo(() => bindProtectedInvoke(access), [access]);
  const [binding, setBinding] = useState<Binding>({kind: 'finding'});
  const [sessions,setSessions] = useState<AgentSession[]>([]);
  const [picked,setPicked] = useState<Selection>();
  const [selecting,setSelecting] = useState(false);
  const [choosing,setChoosing] = useState(false);
  const [unavailable,setUnavailable] = useState(false);
  const [menu,setMenu] = useState(false);
  const menuId = useId();
  const [usage,setUsage] = useState<Record<string,number|string>>();
  const [prompts,setPrompts] = useState<string[]>([]);
  const trackPrompts = useCallback((next:string[])=>setPrompts(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next),[]);
  const trackUsage = useCallback((next?:Record<string,number|string>)=>setUsage(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next),[]);
  // Under Herdr the focused pane of the attached server decides which agent this view belongs to; a 3 s read follows it.
  const navigation=useHerdrNavigation({sessionId,herdrSession,visible:shown && !!herdrSession,intervalMs:3000});
  // Only a read made while the view is shown says anything about the pane focused now.
  const hiddenData=useRef<unknown>(null);
  if(!shown)hiddenData.current=navigation.data;
  const readable=shown && navigation.data!==hiddenData.current && navigation.lease.current();
  const focus=herdrSession && readable && !navigation.agentFailure ? focusedPane(navigation.data) : undefined;
  const fresh=!herdrSession || !!focus;
  const lastFocus=useRef<string|undefined>(undefined);
  const linkedRef=useRef<Selection|undefined>(undefined);
  if(!herdrSession)linkedRef.current=undefined;
  else if(focus){
    lastFocus.current=focus.key;
    const next=focus.link && navigation.data ? herdrSelection(focus.link,navigation.data.server,{place:focus.place,linked:true}) : undefined;
    if(JSON.stringify(next)!==JSON.stringify(linkedRef.current))linkedRef.current=next;
  }
  const focusKey=focus?.key;
  // Focus moved to another pane, tab or workspace: a hand-picked conversation and an open list no longer apply.
  useEffect(()=>{if(herdrSession && focusKey!==undefined){setPicked(previous=>previous && previous.focusKey!==focusKey?undefined:previous);setChoosing(false);}},[herdrSession,focusKey]);
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
      setPicked({row:matches[0],conversation:Object.freeze({agent:conversationAgents[chosen.agent],path:history.path,report:{sessionId:chosen.sessionId,agent:chosen.agent}})});
    } catch {if(owns())setUnavailable(true);}
    finally {if(owns())setSelecting(false);}
  }
  const manual=picked && (!herdrSession || picked.focusKey===lastFocus.current) ? picked : undefined;
  // Without a fresh read of the focused pane nothing is known to belong to it, so no link is shown.
  const linkedKept=herdrSession?linkedRef.current:undefined;
  const linked=fresh?linkedKept:undefined;
  const selected=manual ?? (choosing ? undefined : linked);
  const row = selected ? selected.row : (binding.kind === 'bound' || binding.kind === 'partial' ? binding.row : undefined);
  const conversation=selected?.conversation ?? (binding.kind==='bound'?binding.conversation:undefined);
  const reader=!!conversation;
  // The composer's bound input also answers the open dialog. Before every key the pane is read again, and nothing is sent
  // unless the same reported session still needs the user, so a dialog answered in the terminal first gets no stray key.
  const answerGuard = useCallback(async () => {
    const paneId = row?.paneId;
    if (!paneId || !shown || !access.current()) return false;
    if (parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId !== paneId) return false;
    const rows = parseSnapshot(await invoke('agent_snapshot', {sessionId})).filter(item => item.paneId === paneId);
    return rows.length === 1 && rows[0].sessionId === row.sessionId && rows[0].state === 'needs_attention' && access.current();
  }, [row?.paneId, row?.sessionId, shown, access, invoke, sessionId]);
  const answerable = tmux && !selected && row?.state === 'needs_attention';
  useEffect(() => {publishAnswerGuard(sessionId, answerable ? answerGuard : undefined); return () => publishAnswerGuard(sessionId, undefined);}, [sessionId, answerable, answerGuard]);
  if (!selected && binding.kind==='bound') retained.current={id:binding.row.sessionId,conversation:binding.conversation};
  // The list may sit over a followed conversation without losing its reading position or draft.
  // A reader that goes unknown for a moment (view hidden, Herdr unreachable) keeps its position and draft but stays hidden.
  const held=manual ?? linkedKept;
  const kept=held?.conversation ?? retained.current?.conversation;
  const title = selected?.title ?? (row ? [row.agent, row.project && pathBasename(row.project)].filter(Boolean).join(' · ') : t('agentViewTitle'));
  // A report that waits for the user says what for; Herdr's blocked status is the same wait with no known kind.
  const waiting = row && !selected?.status ? waitingKind(row) : undefined;
  const state = selected?.status ? {tone: herdrTones[selected.status], name: t(herdrStatusKeys[selected.status])}
    : row ? {tone: reportedTones[row.state], name: t(waiting ? waitingKeys[waiting] : reportedStateNames[row.state])} : undefined;
  const queue = waitingFirst(sessions);
  const waitingCount = queue.filter(session=>waitingKind(session)).length;
  const now = useNow(30000, shown && (waitingCount>0 || !!waiting));
  const counts = usage && ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].some(key=>usage[key]!==undefined) ? (key:string)=>formatNumber(Number(usage[key] ?? 0)) : undefined;
  // The pane a hook report names, or the pane Herdr reports as focused, is the evidence the composer binds on. A conversation the person
  // picked has none, so its destination stays an explicit confirmation (tmux) or is not offered (Herdr).
  const isLinked = !!selected?.linked;
  const proof:ComposerProof|undefined = tmux && !selected && row?.paneId ? {kind:'tmux',paneId:row.paneId}
    : isLinked && selected?.conversation.herdr ? {kind:'herdr',pane:selected.conversation.herdr.paneId,terminal:selected.conversation.herdr.terminalId} : undefined;
  const composerLabels = selected && !isLinked && terminalInput?.backend!=='tmux' ? undefined : terminalInput;
  const back = ()=>{request.current++;setPicked(undefined);setChoosing(!herdrSession);setUnavailable(false);setMenu(false);};
  const onChoose = (live:Parameters<NonNullable<Parameters<typeof HerdrAgentsPanel>[0]['onChooseSession']>>[0],server:string)=>{
    request.current++;setSelecting(false);setUnavailable(false);
    setPicked(herdrSelection(live,server,{focusKey:lastFocus.current,enter:{server,target:{kind:'pane',workspace:live.workspace_id,tab:live.tab_id,pane:live.pane_id,terminal:live.terminal_id}}}));
  };
  const empty=!!focus && !!navigation.data?.server && navigation.data.rows.length===0;
  // One compact row: what the chat belongs to and its state. Everything else waits behind the options button.
  const enter=selected?.enter && onEnterHerdr;
  const unlinked=!!herdrSession && !!selected && !selected.linked;
  const listing=!!herdrSession && !selected && (!reader || choosing);
  return <section className="agent-view" hidden={!shown} aria-label={t('agentViewTitle')}>
    <header className="agent-view-header">
      {state && <StatusRing tone={state.tone} />}
      <strong title={selected?.place ? `${title} · ${selected.place}` : title}>{title}</strong>
      {state && <span title={row && !selected?.status ? t('agentViewLastReportedState', {state: state.name}) : undefined}>{state.name}{waiting && row && <> · <time dateTime={row.waitingSince ?? row.updatedAt}>{formatRelativeTime(row.waitingSince ?? row.updatedAt, now)}</time></>}</span>}
      {unlinked && <span className="agent-view-other">{t('agentViewOtherPane')}</span>}
      <button type="button" className="icon-button" aria-label={t('agentViewOptions')} title={t('agentViewOptions')} aria-expanded={menu} aria-controls={menuId} onClick={()=>setMenu(value=>!value)}><Ellipsis size={18} aria-hidden="true"/></button>
      <button type="button" className="icon-button" aria-label={t('agentViewTerminal')} title={t('agentViewTerminal')} onClick={onShowTerminal}><TerminalSquare size={18} aria-hidden="true"/></button>
    </header>
    {menu && <div id={menuId} className="agent-view-menu" role="group" aria-label={t('agentViewOptions')}>
      {!selected && reader && !herdrSession && <button type="button" aria-expanded={choosing} onClick={()=>{setChoosing(value=>!value);setMenu(false);}}>{t('agentViewSessions')}</button>}
      {herdrSession && selected?.linked && <button type="button" onClick={()=>{setChoosing(true);setMenu(false);}}>{t('agentViewChooseAgent')}</button>}
      {herdrSession && !selected && linked && <button type="button" onClick={()=>{setChoosing(false);setMenu(false);}}>{t('agentViewThisPane')}</button>}
      {selected && !selected.linked && <button type="button" onClick={back}>{t(herdrSession && linked ? 'agentViewThisPane' : 'agentViewBackSessions')}</button>}
      {enter && <EnterSessionButton server={selected.enter!.server} target={selected.enter!.target} lease={access} enabled={shown} onEnterHerdr={onEnterHerdr} owner={()=>()=>active.current.shown && active.current.sessionId===sessionId && access.current()}/>}
      {/* The safety rule is unchanged: a shown conversation grants no terminal input beyond the confirmed-input flow. */}
      {selected?.linked && <p>{t('agentViewLinkedNote',{place:selected.place??''})}</p>}
      {selected && !selected.linked && <p>{t('agentViewSelectedNoStage')}</p>}
      {selected && !selected.linked && selected.conversation.herdr && <p>{t('agentsHerdrSessionNotice')}</p>}
      {reader && !selected && !terminalInput && <p>{t('agentViewStageOnly')}</p>}
      {reader && counts && <p>{t('agentViewUsage', {input: counts('inputTokens'), output: counts('outputTokens'), read: counts('cacheReadTokens'), write: counts('cacheWriteTokens')})}</p>}
    </div>}
    {(herdrSession ? !fresh && !manual && navigation.busy && !navigation.data?.loaded : binding.kind === 'finding') && !selected && <p role="status">{t('agentViewFinding')}</p>}
    {!reader && !herdrSession && binding.kind !== 'finding' && <div className="agent-view-fallback">
      <p>{binding.kind === 'partial' ? t('agentViewPartial', {agent: binding.row.agent}) : t('agentViewNoConversation')}</p>
      <div className="button-row">
        <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
        {binding.kind === 'none' && <StartButtons sessionId={sessionId}/>}
      </div>
    </div>}
    {!selected && !herdrSession && (!reader || choosing) && access.current() && sessions.length>0 && <section className="agent-view-picker" aria-label={t('agentViewSessions')}><h3>{t('agentViewSessions')}</h3>
      {waitingCount>0 && <p role="status">{t('agentWaitingCount', {waiting: formatNumber(waitingCount)})}</p>}
      {unavailable && <p role="alert">{t('agentViewSessionUnavailable')}</p>}
      {queue.map(session=><button type="button" key={session.sessionId} disabled={selecting} data-waiting={waitingKind(session)} onClick={()=>void openSession(session)}>{session.agent} · {session.project} · {waitingKind(session) ? <WaitingLabel row={session} now={now}/> : <>{t('agentViewLastReportedState', {state:t(reportedStateNames[session.state])})} · {formatRelativeTime(session.updatedAt)}</>}</button>)}</section>}
    {listing && fresh && !choosing && focus && !empty && <p role="status">{focus.agent ? t('agentViewPaneNoConversation',{agent:focus.agent.agent ?? focus.agent.name ?? ''}) : t('agentViewPaneNoAgent')}</p>}
    {listing && empty && navigation.data && <section className="agent-view-fallback" aria-label={t('agentViewStartAgent')}>
      <p>{t('agentViewNoAgentRunning')}</p>
      <div className="button-row">
        <StartButtons sessionId={sessionId}/>
        {herdrLaunch ? <HerdrWorkspaceCreate sessionId={sessionId} server={navigation.data.server} lease={navigation.lease} tree={navigation.data.snapshot} disabled={!shown} label={t('agentViewStartAgent')} agentFirst
          onCreated={workspace=>void invoke('herdr_action',{sessionId,name:navigation.data!.server,action:{type:'focusWorkspace',target:workspace}}).catch(()=>undefined)}/> : null}
        <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
      </div>
    </section>}
    {listing && !empty && <HerdrAgentsPanel sessionId={sessionId} herdrSession={herdrSession} visible={shown} navigation={navigation} onEnterHerdr={onEnterHerdr} onChooseSession={onChoose} />}
    {!selected && tmux && <AgentApprovalDock sessionId={sessionId} shown={shown} row={row} access={access} invoke={invoke} />}
    {kept && <ChatPanel key={held ? JSON.stringify(held.conversation) : retained.current?.id} sessionId={sessionId} shown={shown && reader && fresh}
      bound={kept} onOpenCompanion={onOpenCompanion} allowStage={false} onBoundInvalid={!selected?()=>setBinding(previous=>previous.kind==='bound' && previous.conversation===kept?{kind:'partial',row:previous.row}:previous):undefined} timeline onOpenTerminal={onShowTerminal} onUsage={trackUsage} onPrompts={trackPrompts} />}
    {kept && reader && <AgentComposer key={`composer:${held ? JSON.stringify(held.conversation) : retained.current?.id}`} sessionId={sessionId} conversation={kept} access={access} invoke={invoke} shown={shown && fresh} labels={composerLabels} proof={proof} stage={!selected || isLinked} prompts={prompts} cwd={selected ? selected.cwd ?? selected.row?.project : row?.project} />}
  </section>;
}

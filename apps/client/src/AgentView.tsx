import {useCallback, useEffect, useId, useMemo, useRef, useState} from 'react';
import {Ellipsis,Search,TerminalSquare} from 'lucide-react';
import ChatPanel, {type BoundConversation} from './ChatPanel';
import AgentComposer, {type ComposerProof} from './AgentComposer';
import HerdrAgentsPanel, {EnterSessionButton} from './HerdrAgentsPanel';
import {HerdrWorkspaceCreate} from './HerdrWorkspaceCreateDialog';
import {focusedPane,type LinkedAgent} from './herdrPaneLink';
import AgentApprovalDock from './AgentApprovalDock';
import AgentPickerDock, {hasDialogProfile, type ScreenSource} from './AgentPickerDock';
import AgentHistory from './AgentHistory';
import {publishAnswerGuard, publishTaskGuard} from './agentDialogAnswer';
import {parseSnapshot, reportedStateNames, type AgentSession} from './AgentPanel';
import {conversationAgents, conversationSource} from './agentConversationSource';
import {parseTerminalSnapshot, type TerminalInputLabels} from './ChatTerminalInput';
import {zellijPane} from './agentPaneIdentity';
import {StatusRing, herdrTones, reportedTones} from './AgentStatus';
import {herdrStatusKeys, useHerdrNavigation} from './useHerdrNavigation';
import {formatRelativeTime, pathBasename, useNow} from './relativeTime';
import {WaitingLabel, waitingFirst, waitingKeys, waitingKind} from './AgentWaiting';
import {AgentHeaderPills, AgentSessionDetails} from './AgentHeaderPills';
import AgentInfoSheet from './AgentInfoSheet';
import type {AgentSessionInfo} from './agentSession';
import type {LiveState} from './AgentWorkingRow';
import {noReading, type Reading} from './AgentReading';
import {bindProtectedInvoke, captureAccess, useAccessSnapshot, type AccessLease} from './access';
import type {HerdrNavigationTarget} from './bridge';
import {formatNumber, t, useUi} from './i18n/core';
import './AgentView.css';

const agentNames: Record<BoundConversation['agent'], string> = {claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode'};
/** What the view shows: a conversation, who it belongs to and, for a Herdr pick, how to enter its pane.
 * `linked` marks the agent of the focused pane; any other pick is the user's own choice and says so. */
type Selection = {row?:AgentSession;history?:boolean;resume?:string;conversation:BoundConversation;cwd?:string;title?:string;place?:string;status?:keyof typeof herdrStatusKeys;linked?:boolean;focusKey?:string;enter?:{server:string;target:HerdrNavigationTarget}};
function herdrSelection(row:LinkedAgent,server:string,extra:Partial<Selection>):Selection {
  const agent=row.agent_session.agent as BoundConversation['agent'];
  return {cwd:row.cwd ?? undefined,title:[agentNames[agent],row.cwd && pathBasename(row.cwd)].filter(Boolean).join(' · '),status:row.agent_status,
    conversation:Object.freeze({agent,path:row.agent_session.value,herdr:{herdrSession:server,paneId:row.pane_id,terminalId:row.terminal_id}}),...extra};
}
/** Start Claude Code or Codex in the terminal you are in: the command is staged for review in the terminal composer, never run from here. */
function StartButtons({sessionId}:{sessionId:string}) {
  return <>{(['claude','codex'] as const).map(agent=><button type="button" key={agent} onClick={()=>window.dispatchEvent(new CustomEvent('lazysh-prompt-draft',{detail:{sessionId,text:agent}}))}>{t('agentViewStartNamed',{agent:agentNames[agent]})}</button>)}</>;
}
/** Image previews cost bytes on a mobile link: on by default for Claude Code, opt-in for Codex whose companion support is newer. Kept per viewer. */
const imageDefaults: Record<BoundConversation['agent'], boolean> = {claude: true, codex: false, opencode: false};
function storedImages() {
  try {return {...imageDefaults, ...JSON.parse(localStorage.getItem('lazysh.agentImages') ?? '{}')} as Record<BoundConversation['agent'], boolean>;} catch {return imageDefaults;}
}
type Binding = {kind: 'finding'} | {kind: 'none'} | {kind: 'partial'; row: AgentSession} | {kind: 'bound'; row: AgentSession; conversation: BoundConversation};

/** Another view of the same live session: the agent conversation that hook reports tie to this terminal's pane.
 * It never writes to the terminal; input goes through the confirmed input or Stage like Chat. */
export default function AgentView({sessionId, shown, tmux, zellijSession, herdrSession, herdrLaunch, terminalInput, terminal, onShowTerminal, onEnterHerdr, onOpenCompanion}: {
  sessionId: string; shown: boolean; tmux: boolean; /** The Zellij session the terminal is attached to: an agent report that names one of its panes ties the conversation to it. */zellijSession?: string; herdrSession?: string; herdrLaunch?: boolean; terminalInput?: TerminalInputLabels; /** The session's terminal, whose screen shows a dialog no hook or transcript describes. */ terminal?: ScreenSource; onShowTerminal: () => void;
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
  const [images,setImages] = useState(storedImages);
  const [history,setHistory] = useState<string>();
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
  const [info,setInfo] = useState<AgentSessionInfo>();
  // Full history is remembered per device and per terminal; a search is not.
  const fullKey=`lazysh.agentView.full.${sessionId}`;
  const [reading,setReading]=useState<Reading>(()=>{try{return {...noReading,full:localStorage.getItem(fullKey)!=='0'};}catch{return noReading;}});
  const changeReading=useCallback((next:Reading)=>{setReading(next);try{localStorage.setItem(fullKey,next.full?'1':'0');}catch{/* The choice then lasts until the view closes. */}},[fullKey]);
  const [infoOpen,setInfoOpen] = useState(false);
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
        // The host's reports and the pane this terminal shows are independent reads: together they cost one round trip.
        const [snapshot, terminal] = await Promise.all([invoke('agent_snapshot', {sessionId}), tmux ? invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}}) : undefined]);
        const reports = parseSnapshot(snapshot);
        if (!alive || !access.current()) return;
        setSessions(reports.filter(row=>row.agent in conversationAgents && reports.filter(other=>other.sessionId===row.sessionId).length===1));
        // Pane identity is the evidence: TMUX_PANE ties a hook report to this tmux terminal; in a Zellij session, the one report that names a pane of it.
        const own = zellijSession ? reports.filter(row => zellijPane(row.paneId)?.session === zellijSession) : [];
        const pane = tmux ? parseTerminalSnapshot(terminal).destination.paneId : own.length === 1 ? own[0].paneId ?? undefined : undefined;
        const matching = pane === undefined ? [] : reports.filter(row => row.paneId === pane);
        const row = matching.length===1 ? matching[0] : undefined;
        const agent = row && conversationAgents[row.agent as keyof typeof conversationAgents];
        let conversation:BoundConversation | undefined;
        if (row && agent) {
          try {
            const found = await conversationSource(invoke, sessionId, agent, row.sessionId);
            // The report's own pane is the evidence for OpenCode; Claude Code and Codex also name it in the reported history.
            if (found && (found.paneId === undefined || found.paneId === pane)) conversation=Object.freeze({agent, path: found.path,...(found.transcriptSessionId ? {transcriptSessionId: found.transcriptSessionId} : {}),report:{sessionId:row.sessionId,agent:row.agent,paneId:pane}});
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
  }, [shown, sessionId, tmux, zellijSession, herdrSession, invoke, access]);
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
      const agent=conversationAgents[chosen.agent as keyof typeof conversationAgents];
      const source=await conversationSource(invoke,sessionId,agent,chosen.sessionId);
      if(!owns())return;
      const reports=parseSnapshot(await invoke('agent_snapshot',{sessionId}));
      const matches=reports.filter(row=>row.sessionId===chosen.sessionId);
      if(!owns())return;
      if(!source || matches.length!==1 || matches[0].agent!==chosen.agent) {setUnavailable(true);return;}
      setPicked({row:matches[0],conversation:Object.freeze({agent,path:source.path,...(source.transcriptSessionId ? {transcriptSessionId:source.transcriptSessionId} : {}),report:{sessionId:chosen.sessionId,agent:chosen.agent}})});
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
  const paneGuard = useCallback(async () => {
    const paneId = row?.paneId;
    return !!paneId && shown && access.current() && parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId === paneId;
  }, [row?.paneId, shown, access, invoke, sessionId]);
  // The state the hook reports for the pane's session, only while the same pane still shows that same session.
  const reportedState = useCallback(async () => {
    if (!await paneGuard()) return undefined;
    const rows = parseSnapshot(await invoke('agent_snapshot', {sessionId})).filter(item => item.paneId === row?.paneId);
    return rows.length === 1 && rows[0].sessionId === row?.sessionId && access.current() ? rows[0].state : undefined;
  }, [paneGuard, row?.paneId, row?.sessionId, access, invoke, sessionId]);
  const answerGuard = useCallback(async () => await reportedState() === 'needs_attention', [reportedState]);
  // A request to stop a task is typed text and Enter: it needs the same pane still showing the same reported session, and no
  // dialog open, because Enter would answer one.
  const taskGuard = useCallback(async () => {const state = await reportedState(); return state !== undefined && state !== 'needs_attention';}, [reportedState]);
  const answerable = tmux && !selected && row?.state === 'needs_attention';
  useEffect(() => {publishAnswerGuard(sessionId, answerable ? answerGuard : undefined); return () => publishAnswerGuard(sessionId, undefined);}, [sessionId, answerable, answerGuard]);
  const taskable = tmux && !selected && !!row && row.state !== 'needs_attention';
  useEffect(() => {publishTaskGuard(sessionId, taskable ? taskGuard : undefined); return () => publishTaskGuard(sessionId, undefined);}, [sessionId, taskable, taskGuard]);
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
  // Best source first: the live Herdr status, then a recent hook report. Otherwise the chat falls back to the recorded turn state.
  const hookFresh = !!row && Date.now() - Date.parse(row.updatedAt) < 10 * 60_000;
  const workState = selected?.status ? ({working: 'working', blocked: 'waiting', done: 'idle', idle: 'idle', unknown: undefined} as const)[selected.status]
    : row && hookFresh ? ({working: 'working', needs_attention: 'waiting', done: 'idle'} as const)[row.state] : undefined;
  const liveState: LiveState = {state: workState, label: workState === 'waiting' && waiting ? t(waitingKeys[waiting]) : undefined};
  const counts = usage && ['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'].some(key=>usage[key]!==undefined) ? (key:string)=>formatNumber(Number(usage[key] ?? 0)) : undefined;
  // The pane a hook report names, or the pane Herdr reports as focused, is the evidence the composer binds on. A conversation the person
  // picked has none, so its destination stays an explicit confirmation (tmux) or is not offered (Herdr).
  const isLinked = !!selected?.linked;
  // A Zellij pane is named by the agent's own report, so a conversation picked from the list has it too, unless another report claims the pane.
  const zellij = zellijSession ? zellijPane(row?.paneId) : undefined;
  // OpenCode takes its prompt as a paste and its Stop as two Escapes, and only through tmux: nothing else has been checked against it.
  const guarded = !!kept && (kept.agent !== 'opencode' || (tmux && terminalInput?.backend === 'tmux'));
  const proof:ComposerProof|undefined = !guarded ? undefined : tmux && !selected && row?.paneId ? {kind:'tmux',paneId:row.paneId}
    : zellij && zellij.session === zellijSession && sessions.filter(session => session.paneId === row?.paneId).length === 1 ? {kind:'zellij',session:zellij.session,pane:zellij.pane}
    : isLinked && selected?.conversation.herdr ? {kind:'herdr',pane:selected.conversation.herdr.paneId,terminal:selected.conversation.herdr.terminalId} : undefined;
  // A picked conversation has no destination to confirm under Herdr; under Zellij it takes input only through its own report's pane.
  const composerLabels = !guarded ? undefined : terminalInput?.backend==='zellij' ? (proof?.kind==='zellij' ? terminalInput : undefined)
    : selected && !isLinked && terminalInput?.backend!=='tmux' ? undefined : terminalInput;
  const back = ()=>{request.current++;setPicked(undefined);setChoosing(!herdrSession);setUnavailable(false);setMenu(false);};
  const onChoose = (live:Parameters<NonNullable<Parameters<typeof HerdrAgentsPanel>[0]['onChooseSession']>>[0],server:string)=>{
    request.current++;setSelecting(false);setUnavailable(false);
    setPicked(herdrSelection(live,server,{focusKey:lastFocus.current,enter:{server,target:{kind:'pane',workspace:live.workspace_id,tab:live.tab_id,pane:live.pane_id,terminal:live.terminal_id}}}));
  };
  const empty=!!focus && !!navigation.data?.server && navigation.data.rows.length===0;
  // One compact row: what the chat belongs to and its state. Everything else waits behind the options button.
  const enter=selected?.enter && onEnterHerdr;
  const unlinked=!!herdrSession && !!selected && !selected.linked && !selected.history;
  // The folder whose earlier sessions can be listed: where the conversation on screen works.
  const paneHasAgent=binding.kind==='bound' || binding.kind==='partial' || !!focus?.agent;
  const focusedFolder=herdrSession ? navigation.data?.snapshot?.panes.find(pane=>pane.focused)?.cwd ?? undefined : undefined;
  const viewFolder=selected ? selected.cwd ?? selected.row?.project : row?.project ?? focusedFolder;
  const listing=!!herdrSession && !selected && (!reader || choosing);
  return <section className="agent-view" data-history={reading.full?undefined:'conversation'} hidden={!shown} aria-label={t('agentViewTitle')}>
    <header className="agent-view-header">
      {state && <StatusRing tone={state.tone} />}
      <strong title={selected?.place ? `${title} · ${selected.place}` : title}>{title}</strong>
      {state && <span title={row && !selected?.status ? t('agentViewLastReportedState', {state: state.name}) : undefined}>{state.name}{waiting && row && <> · <time dateTime={row.waitingSince ?? row.updatedAt}>{formatRelativeTime(row.waitingSince ?? row.updatedAt, now)}</time></>}</span>}
      {unlinked && <span className="agent-view-other">{t('agentViewOtherPane')}</span>}
      {reader && <AgentHeaderPills session={info}/>}
      {reader && <button type="button" className="icon-button" aria-label={t('agentSearch')} title={t('agentSearch')} aria-pressed={reading.search} onClick={()=>changeReading({...reading,search:!reading.search,query:''})}><Search size={18} aria-hidden="true"/></button>}
      <button type="button" className="icon-button" aria-label={t('agentViewOptions')} title={t('agentViewOptions')} aria-expanded={menu} aria-controls={menuId} onClick={()=>setMenu(value=>!value)}><Ellipsis size={18} aria-hidden="true"/></button>
      <button type="button" className="icon-button" aria-label={t('agentViewTerminal')} title={t('agentViewTerminal')} onClick={onShowTerminal}><TerminalSquare size={18} aria-hidden="true"/></button>
    </header>
    {menu && <div id={menuId} className="agent-view-menu" role="group" aria-label={t('agentViewOptions')}>
      {!selected && reader && !herdrSession && <button type="button" aria-expanded={choosing} onClick={()=>{setChoosing(value=>!value);setMenu(false);}}>{t('agentViewSessions')}</button>}
      {herdrSession && selected?.linked && <button type="button" onClick={()=>{setChoosing(true);setMenu(false);}}>{t('agentViewChooseAgent')}</button>}
      {herdrSession && !selected && linked && <button type="button" onClick={()=>{setChoosing(false);setMenu(false);}}>{t('agentViewThisPane')}</button>}
      {selected?.history && <button type="button" onClick={()=>{request.current++;setPicked(undefined);setHistory(selected.cwd);setMenu(false);}}>{t('agentHistoryBack')}</button>}
      {/* Resume stages the agent's own command for review in the terminal composer, like Start; it is never offered over a running agent. */}
      {selected?.history && selected.resume && !paneHasAgent && <button type="button" onClick={()=>{window.dispatchEvent(new CustomEvent('lazysh-prompt-draft',{detail:{sessionId,text:selected.resume}}));setMenu(false);onShowTerminal();}}>{t('agentHistoryResume')}</button>}
      {selected && !selected.linked && <button type="button" onClick={back}>{t(herdrSession && linked ? 'agentViewThisPane' : 'agentViewBackSessions')}</button>}
      {reader && viewFolder && !selected?.history && <button type="button" onClick={()=>{setHistory(viewFolder);setMenu(false);}}>{t('agentHistoryOpen')}</button>}
      {enter && <EnterSessionButton server={selected.enter!.server} target={selected.enter!.target} lease={access} enabled={shown} onEnterHerdr={onEnterHerdr} owner={()=>()=>active.current.shown && active.current.sessionId===sessionId && access.current()}/>}
      {reader && <button type="button" aria-pressed={!reading.full} onClick={()=>changeReading({...reading,full:!reading.full})}>{t('agentConversationOnly')}</button>}
      {/* The safety rule is unchanged: a shown conversation grants no terminal input beyond the confirmed-input flow. */}
      {selected?.linked && <p>{t('agentViewLinkedNote',{place:selected.place??''})}</p>}
      {selected && !selected.linked && <p>{t(selected.history ? 'agentHistoryReadOnly' : 'agentViewSelectedNoStage')}</p>}
      {selected?.history && selected.resume && paneHasAgent && <p>{t('agentHistoryResumeBusy')}</p>}
      {selected && !selected.linked && selected.conversation.herdr && <p>{t('agentsHerdrSessionNotice')}</p>}
      {reader && !selected && !terminalInput && <p>{t('agentViewStageOnly')}</p>}
      {reader && info?.info && <button type="button" aria-expanded={infoOpen} onClick={()=>{setInfoOpen(true);setMenu(false);}}>{t('agentInfoOpen')}</button>}
      {reader && <AgentSessionDetails session={info}/>}
      {reader && kept && !kept.herdr && <label><input type="checkbox" checked={!!images[kept.agent]} onChange={event=>{const next={...images,[kept.agent]:event.target.checked};setImages(next);try {localStorage.setItem('lazysh.agentImages',JSON.stringify(next));} catch { /* A preference only. */ }}} />{t('agentImagesShow')}</label>}
      {reader && counts && <p>{t('agentViewUsage', {input: counts('inputTokens'), output: counts('outputTokens'), read: counts('cacheReadTokens'), write: counts('cacheWriteTokens')})}</p>}
    </div>}
    {history && <AgentHistory sessionId={sessionId} folder={history} invoke={invoke} onClose={()=>setHistory(undefined)}
      onOpen={item=>{request.current++;setHistory(undefined);setPicked({history:true,cwd:history,focusKey:lastFocus.current,resume:/^[A-Za-z0-9-]{8,64}$/.test(item.sessionId)?`${item.agent==='claude'?'claude --resume':'codex resume'} ${item.sessionId}`:undefined,title:[agentNames[item.agent],item.title ?? item.sessionId.slice(0,8)].join(' · '),conversation:Object.freeze({agent:item.agent,path:item.path})});}}/>}
    {infoOpen && reader && info?.info && <AgentInfoSheet info={info.info} onClose={()=>setInfoOpen(false)} onShowTerminal={onShowTerminal}/>}
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
        {viewFolder && !history && <button type="button" onClick={()=>setHistory(viewFolder)}>{t('agentHistoryOpen')}</button>}
        {herdrLaunch ? <HerdrWorkspaceCreate sessionId={sessionId} server={navigation.data.server} lease={navigation.lease} tree={navigation.data.snapshot} disabled={!shown} label={t('agentViewStartAgent')} agentFirst
          onCreated={workspace=>void invoke('herdr_action',{sessionId,name:navigation.data!.server,action:{type:'focusWorkspace',target:workspace}}).catch(()=>undefined)}/> : null}
        <button type="button" onClick={onShowTerminal}>{t('agentViewShowTerminal')}</button>
      </div>
    </section>}
    {listing && !empty && <HerdrAgentsPanel sessionId={sessionId} herdrSession={herdrSession} visible={shown} navigation={navigation} onEnterHerdr={onEnterHerdr} onChooseSession={onChoose} />}
    {!selected && tmux && <AgentApprovalDock sessionId={sessionId} shown={shown} row={row} access={access} invoke={invoke} />}
    {reader && !selected && <AgentPickerDock sessionId={sessionId} shown={shown && fresh} terminal={terminal} agent={row?.agent} answerable={tmux && hasDialogProfile(row?.agent) && !!row?.paneId} guard={paneGuard} waiting={waiting} onShowTerminal={onShowTerminal} />}
    {kept && <ChatPanel key={`${held ? JSON.stringify(held.conversation) : retained.current?.id}:${images[kept.agent]}`} images={!!images[kept.agent]} sessionId={sessionId} shown={shown && reader && fresh}
      bound={kept} onOpenCompanion={onOpenCompanion} allowStage={false} onBoundInvalid={!selected?()=>setBinding(previous=>previous.kind==='bound' && previous.conversation===kept?{kind:'partial',row:previous.row}:previous):undefined} timeline onOpenTerminal={onShowTerminal} onUsage={trackUsage} onPrompts={trackPrompts} onSession={setInfo} liveState={liveState} reading={reading} onReading={changeReading} />}
    {kept && reader && !selected?.history && <AgentComposer key={`composer:${held ? JSON.stringify(held.conversation) : retained.current?.id}`} sessionId={sessionId} conversation={kept} access={access} invoke={invoke} shown={shown && fresh} labels={composerLabels} proof={proof} stage={!selected || isLinked} prompts={prompts} cwd={selected ? selected.cwd ?? selected.row?.project : row?.project} onOpenTerminal={onShowTerminal} />}
  </section>;
}

import AttachmentPanel from './AttachmentPanel';
import {ArrowLeft,Info,Paperclip,RefreshCw,Terminal,Trash2,X} from 'lucide-react';
import './ChatPanel.css';
import {shellPath} from './attachment';
import ChatTerminalInput,{parseTerminalSnapshot,validTerminalSource,type TerminalSource,type TerminalInputLabels} from './ChatTerminalInput';
import {parseReportedHistory,parseSnapshot,type ReportedHistorySource} from './AgentPanel';
import {t, useUi} from './i18n/core';
import {formatCountdown,formatRelativeTime,useNow} from './relativeTime';
import { transcriptAgents as agents, isDiscoveredTranscript } from "./transcriptSources";
import { bindProtectedInvoke, captureAccess, useAccessSnapshot } from './access';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";

import {ChatActivity,ChatCard,ChatMarkdown,parseActivity,parseCard,type Activity,type Card} from './ChatInteraction';
import {errorMessage, captureUiError, uiErrorText, LocalUiError, type UiErrorCause} from './i18n/localError';
import {validateRecordedPage} from './recordedFollow';
import {recordedImage,type RecordedImage} from './recordedImage';
import RecordedImagePreview from './RecordedImagePreview';
import {captureScrollPosition,restoreScrollPosition,type ScrollPosition} from './scrollReturn';
import {useTranscriptWatch,type WatchTarget} from './useTranscriptWatch';
import {applyWatchOp} from './transcriptWatch';
import {projectMessages,type InjectedEvent} from './chatInjected';

type Block = {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  isError?: boolean;
  imagePreview?: RecordedImage;
  card?: Card;
};
type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "record";
  record?: { source: string; type: string; status: string; stepIndex?: number; exitCode?: number; errorCode?: number; truncatedFields: string[] };
  timestamp?: string;
  blocks: Block[];
  usage?: Record<string, number | string>;
  /** Set by the client for a record the harness wrote; shown as one compact row instead of a bubble. */
  event?: InjectedEvent;
};
type Page = {
  schemaVersion: 1;
  agent: string;
  messages: Message[];
  nextOffset: number;
  hasMore: boolean;
  view?: string;
  truncated?: boolean;
  checkpoint?: string;
  branchId?: string;
  activity?: Activity;
};


export function parseTranscript(value: unknown): Page {
  if (!value || typeof value !== "object")
    throw new LocalUiError('chatInvalidResponse');
  const page = value as Page;
  if (
    page.schemaVersion !== 1 ||
    !Object.hasOwn(agents, page.agent) ||
    (page.agent === "grok-acp" && !["record_stream", "active_branch"].includes(page.view ?? "")) ||
    (page.agent === "antigravity-jsonl" && page.view !== "record_stream") ||
    (page.agent === "antigravity-jsonl" && (typeof page.checkpoint !== "string" || !/^v1:[0-9]{1,8}:[0-9a-f]{64}$/.test(page.checkpoint))) ||
    !Array.isArray(page.messages) ||
    page.messages.length > 100 ||
    !Number.isSafeInteger(page.nextOffset) ||
    page.nextOffset < 0 ||
    typeof page.hasMore !== "boolean"
  )
    throw new LocalUiError('chatUnsupportedResponse');
  if (page.agent === 'opencode' && page.view === 'active_branch' && (
    page.nextOffset !== 0 || page.hasMore || typeof page.truncated !== 'boolean'
    || typeof page.branchId !== 'string' || !page.branchId || /[\x00-\x1f\x7f-\x9f]/.test(page.branchId)
    || new TextEncoder().encode(page.branchId).length > 256
  )) throw new LocalUiError('chatUnsupportedResponse');
  page.activity = parseActivity(page.activity, page.agent, page.view);
  if (page.agent === "antigravity-jsonl") {
    const bytes = Number(page.checkpoint!.split(":")[1]);
    if (bytes > 16 * 1024 * 1024 || page.nextOffset > bytes) throw new LocalUiError('chatInvalidCheckpoint');
  }
  for (const message of page.messages) {
    if (
      !message ||
      typeof message.id !== "string" ||
      message.id.length > 4096 ||
      !(["user", "assistant", "tool"].includes(message.role) || (page.agent === "antigravity-jsonl" && message.role === "record")) ||
      !Array.isArray(message.blocks) ||
      message.blocks.length > 1000
    )
      throw new LocalUiError('chatInvalidMessage');
    if (page.agent === "antigravity-jsonl") {
      const metadata = message.record;
      if (message.role !== "record" || !metadata || [metadata.source, metadata.type, metadata.status].some(value => typeof value !== "string" || value.length > 256)
        || !Array.isArray(metadata.truncatedFields) || metadata.truncatedFields.length > 64 || metadata.truncatedFields.some(value => typeof value !== "string" || value.length > 256)
        || (metadata.stepIndex !== undefined && (!Number.isInteger(metadata.stepIndex) || metadata.stepIndex < 0 || metadata.stepIndex > 4294967295))
        || (metadata.errorCode !== undefined && (!Number.isInteger(metadata.errorCode) || metadata.errorCode < 0 || metadata.errorCode > 4294967295))
        || (metadata.exitCode !== undefined && (!Number.isInteger(metadata.exitCode) || metadata.exitCode < -2147483648 || metadata.exitCode > 2147483647)))
        throw new LocalUiError('chatInvalidRecordMetadata');
    } else if (message.record !== undefined) throw new LocalUiError('chatUnexpectedRecordMetadata');
    for (const block of message.blocks) {
      if (block?.imagePreview !== undefined) {
        const imageContext = (page.agent==='grok-acp' && page.view==='record_stream' && ['user','assistant'].includes(message.role))
          || ((page.agent==='claude' && ['record_stream','active_branch'].includes(page.view??'')
            || page.agent==='codex' && page.view==='record_stream') && message.role==='user');
        if (!imageContext || block.type!=='image' || block.id!==undefined || block.status!==undefined)
          throw new LocalUiError('chatImageInvalid');
        recordedImage(block.imagePreview);
      }
      if (
        !block ||
        !["text", "thinking", "tool_use", "tool_result", "image"].includes(
          block.type,
        )
      )
        throw new LocalUiError('chatInvalidBlock');
      if (block.card !== undefined) block.card = parseCard(block.card, {agent:page.agent, view:page.view, type:block.type});
      for (const field of ["text", "id", "name"] as const)
        if (
          block[field] !== undefined &&
          (typeof block[field] !== "string" || block[field].length > 262144)
        )
          throw new LocalUiError('chatInvalidContent');
      if (block.status !== undefined && (!['grok-acp','opencode'].includes(page.agent)
        || !['tool_use','tool_result','image'].includes(block.type)
        || !['pending','in_progress','completed','failed'].includes(block.status)
        || typeof block.id !== 'string' || !block.id || block.id.length > 256 || new TextEncoder().encode(block.id).length > 256))
        throw new LocalUiError('chatInvalidToolStatus');
      if (block.isError !== undefined && ((page.agent !== 'claude' && page.agent !== 'opencode' && !(page.agent==='codex' && page.view==='active_branch')
        && !(page.agent === 'pi' && page.view === 'record_stream' && message.role === 'tool'))
        || block.type !== 'tool_result' || typeof block.isError !== 'boolean'))
        throw new LocalUiError('chatInvalidToolError');
    }
    if (
      message.usage &&
      (typeof message.usage !== "object" ||
        Object.values(message.usage).some(
          (n) => typeof n === "string"
            ? page.agent !== "antigravity-jsonl" || !/^(0|[1-9][0-9]{0,19})$/.test(n) || BigInt(n) > 18446744073709551615n
            : !Number.isSafeInteger(n) || n < 0,
        ))
    )
      throw new LocalUiError('chatInvalidUsage');
  }
  return page;
}

/** A watch frame's messages go through the paged reader's own validation. */
const parseWatchPage = (page: unknown) => parseTranscript(page);

type Turn = {key: string; prompt?: Message; event?: Message; activity: Message[]; answer?: Message};
/** One block per turn: the prompt, the work in between, and the closing answer. Tool results are not prompts. */
export function groupTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    // A harness event starts the next turn without being the person's prompt.
    const prompt = message.role === 'user' && !message.event && message.blocks.some(block => block.type === 'text' && !block.card);
    if (prompt || message.event || !turns.length) turns.push({key: message.id, prompt: prompt ? message : undefined, event: message.event ? message : undefined, activity: []});
    if (!prompt && !message.event) turns.at(-1)!.activity.push(message);
  }
  for (const turn of turns) {
    const last = turn.activity.at(-1);
    if (last?.role === 'assistant' && last.blocks.length > 0 && last.blocks.every(block => block.type === 'text' || block.type === 'thinking')) turn.answer = turn.activity.pop();
  }
  return turns;
}

const commandTools = new Set(['bash', 'command', 'shell', 'exec_command', 'local_shell', 'run_terminal_cmd']);
const editTools = new Set(['edit', 'multiedit', 'write', 'notebookedit', 'apply_patch', 'str_replace_based_edit_tool']);
/** The folded activity row: what the agent did ("Ran 3 commands · Made 2 edits · 1 failed · 1:12"). */
export function activitySummary(turn: Turn): string {
  const blocks = turn.activity.flatMap(message => message.blocks);
  const uses = blocks.filter(block => block.type === 'tool_use').map(block => block.name?.toLowerCase() ?? '');
  const commands = uses.filter(name => commandTools.has(name)).length, edits = uses.filter(name => editTools.has(name)).length;
  // A call can fail on its use (status) and its result (isError); count it once.
  const failed = new Set(blocks.flatMap((block, index) => block.isError === true || block.status === 'failed' ? [block.id ?? index] : [])).size;
  const parts = [
    commands && t('agentTurnCommands', {count: commands}), edits && t('agentTurnEdits', {count: edits}),
    uses.length - commands - edits && t('agentTurnTools', {count: uses.length - commands - edits}), failed && t('agentTurnFailed', {count: failed}),
  ].filter((part): part is string => !!part);
  if (!parts.length) parts.push(t('agentViewActivity', {count: turn.activity.length}));
  const start = Date.parse((turn.prompt ?? turn.event)?.timestamp ?? ''), end = Date.parse([...turn.activity, turn.answer].map(message => message?.timestamp).filter(Boolean).at(-1) ?? '');
  if (end > start) parts.push(formatCountdown(end - start));
  return parts.join(' · ');
}

/** A conversation the Agent view found for its pane from hook reports. */
export type BoundConversation = Readonly<{agent: 'claude' | 'codex'; path: string; herdr?: {herdrSession:string;paneId:string;terminalId:string};report?: {sessionId:string;agent:string;paneId?:string}}>;

/** `shown` false keeps an opened reader, its position and the unsent draft while another session view is in front.
 * `bound` opens and follows that conversation without the picker; `timeline` groups messages by turn. */
export default function ChatPanel({ sessionId, onOpenTerminal,reportedHistory,terminalInput,shown=true,bound,timeline=false,onTurnStart,onUsage,allowStage=true,onBoundInvalid,onOpenCompanion }: { sessionId: string; onOpenTerminal?: () => void;reportedHistory?:ReportedHistorySource;terminalInput?:TerminalInputLabels;shown?:boolean;bound?:BoundConversation;timeline?:boolean;onTurnStart?:(timestamp?:string)=>void;onUsage?:(usage?:Record<string,number|string>)=>void;allowStage?:boolean;onBoundInvalid?:()=>void;onOpenCompanion?:()=>void }) {
  useUi();
  const [access]=useState(()=>reportedHistory?.lease ?? captureAccess());
  const invoke=useMemo(()=>bindProtectedInvoke(access),[access]);
  const initialReported=useRef(reportedHistory?.sessionId===sessionId && access.current()?reportedHistory:undefined).current;
  const accessState = useAccessSnapshot();
  const mounted = useRef(true);
  const flight = useRef(false);
  const automaticRequest = useRef(false);
  const pageHidden = useRef(false);
  const [visible, setVisible] = useState(document.visibilityState !== 'hidden');
  const [following, setFollowing] = useState(false);
  const followRef = useRef(false);
  followRef.current = following;
  const [completed, setCompleted] = useState(0);
  const messageList = useRef<HTMLDivElement>(null);
  const atLatestRef = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  const [agent, setAgent] = useState<string>(bound?.agent ?? "claude");
  const [path, setPath] = useState(bound?.path ?? initialReported?.path ?? "");
  const [view, setView] = useState(bound ? "conversation" : "records");
  const [inlineImages,setInlineImages]=useState(false);
  const canIncludeImages = (agent==='claude' && ['records','conversation'].includes(view)) || (['grok-acp','codex'].includes(agent) && view==='records');
  const [preview,setPreview]=useState<{image:RecordedImage;messageId:string;blockIndex:number;source:string;attempt:number}>();
  const previewAttempt=useRef(0);
  const [previewBusy,setPreviewBusy]=useState(false);
  const updatePreviewBusy=useCallback((value:boolean)=>{if(mounted.current)setPreviewBusy(value);},[]);
  const previewSource=JSON.stringify([sessionId,agent,path,view,inlineImages]);
  useEffect(()=>{setPreview(undefined);},[previewSource]);
  const [discovered, setDiscovered] = useState<
    { path: string; name: string; sessionId?: string }[]
  >([]);
  const [transcriptSessionId, setTranscriptSessionId] = useState("");
  const [inputOpen,setInputOpen]=useState({generation:0,pending:false});
  const [opened, setOpened] = useState<{
    agent: string;
    path: string;
    view?: string;
    transcriptSessionId?: string;
    checkpointed?: boolean;
    inlineImages?: boolean;
  }>();
  const terminalSource=useMemo<TerminalSource|undefined>(()=>{
    if(!opened || bound?.herdr || (bound && (opened.path!==bound.path || opened.agent!==bound.agent)))return;
    const source={agent:opened.agent,path:opened.path,view:opened.view??'records',inlineImages:!!opened.inlineImages,
      ...(['hermes','opencode'].includes(opened.agent)?{transcriptSessionId:opened.transcriptSessionId}:{})};
    return validTerminalSource(source)?Object.freeze(source):undefined;
  },[opened,bound]);
  const terminalInputKey=JSON.stringify([previewSource,transcriptSessionId]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [activity, setActivity] = useState<Activity>();
  const answered = useMemo(() => new Set(messages.flatMap(message => message.blocks
    .filter(block => block.id && ((block.type === 'tool_result' && block.isError !== true) || block.status === 'completed'))
    .map(block => block.id!))), [messages]);
  const previewRetained = preview && messages.some(message=>message.id===preview.messageId && message.blocks[preview.blockIndex]?.imagePreview?.data===preview.image.data);
  useEffect(()=>{if(preview && !previewRetained)setPreview(undefined);},[preview,previewRetained]);
  const [offset, setOffset] = useState(0);
  const [checkpoint, setCheckpoint] = useState<string>();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiErrorCause>("");
  const [draft, setDraft] = useState("");
  const [attachmentOpen,setAttachmentOpen]=useState(false);
  const chatRoot=useRef<HTMLElement>(null),attachmentButton=useRef<HTMLButtonElement>(null),attachmentBack=useRef<HTMLButtonElement>(null);
  const attachmentReturn=useRef<{session:string}&ScrollPosition|null>(null);
  const [draftHelpOpen,setDraftHelpOpen]=useState(false);
  const draftId=useId(),draftHelpId=useId();
  const currentSession=useRef(sessionId);currentSession.current=sessionId;
  function toggleAttachment(open:boolean) {
    if(open && window.matchMedia?.('(max-width: 600px)').matches) {
      attachmentReturn.current={session:sessionId,...captureScrollPosition(chatRoot.current)};
    }
    setAttachmentOpen(open);
  }
  useLayoutEffect(()=>{
    const saved=attachmentReturn.current;
    if(saved && saved.session!==sessionId){attachmentReturn.current=null;return;}
    if(!saved || !mounted.current || !chatRoot.current?.getClientRects().length || !access.current() || document.hidden || !document.hasFocus() || !window.matchMedia?.('(max-width: 600px)').matches)return;
    const active=document.activeElement;
    if(active!==document.body && active!==attachmentButton.current && active!==attachmentBack.current && !chatRoot.current.contains(active))return;
    if(attachmentOpen) {
      restoreScrollPosition(saved,0);
      attachmentBack.current?.focus({preventScroll:true});
    } else {
      attachmentReturn.current=null;
      if(attachmentButton.current?.isConnected)attachmentButton.current.focus({preventScroll:true});
      restoreScrollPosition(saved);
    }
  },[attachmentOpen,sessionId,access]);
  useEffect(()=>{
    const back=(event:Event)=>{
      if(!attachmentOpen || !access.current() || document.hidden || !document.hasFocus() || !window.matchMedia?.('(max-width: 600px)').matches || !chatRoot.current?.getClientRects().length || document.querySelector('[role="dialog"][aria-modal="true"]'))return;
      event.preventDefault();event.stopImmediatePropagation();toggleAttachment(false);
    };
    const keydown=(event:KeyboardEvent)=>{if(event.key==='Escape')back(event);};
    window.addEventListener('lazysh-workspace-back',back,true);window.addEventListener('keydown',keydown,true);
    return()=>{window.removeEventListener('lazysh-workspace-back',back,true);window.removeEventListener('keydown',keydown,true);};
  },[attachmentOpen,sessionId,access]);
  const draftRevision=useRef(0);
  const [draftStatus, setDraftStatus] = useState<"" | "chatDraftTooLong" | "chatDraftStaged" | "chatAttachmentTooLong">("");
  const composing = useRef(false);
  const [compositionActive,setCompositionActive]=useState(false);
  const request = useRef(0);
  const conversation = ['claude','opencode','codex'].includes(opened?.agent??'') && opened?.view === 'conversation';
  const recorded = opened?.agent === 'grok-acp' && opened.checkpointed === true;
  const followable = conversation || recorded;
  const reportedMatches=!!initialReported && initialReported.sessionId===sessionId && agent==='claude' && path===initialReported.path;
  const selectedPath=reportedMatches || path===bound?.path?path:path.trim();
  const sourceMatches = !!opened && agent===opened.agent && view===(opened.view??'records') && selectedPath===opened.path && (!['hermes','opencode'].includes(agent) || transcriptSessionId===opened.transcriptSessionId) && (canIncludeImages&&inlineImages)===!!opened.inlineImages;
  const canFollow = followable && sourceMatches;
  useLayoutEffect(() => {
    if (!shown) request.current++;
    if (bound && (path !== bound.path || agent !== bound.agent)) {
      request.current++; setFollowing(false); followRef.current = false;
      setPath(bound.path); setAgent(bound.agent); setOpened(undefined); setMessages([]); setActivity(undefined);
      setOffset(0); setCheckpoint(undefined); setMore(false); setError('');
    }
  }, [shown, bound, path, agent]);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; request.current++;};}, []);
  useEffect(() => {
    if(initialReported && initialReported.sessionId!==sessionId && path===initialReported.path)setPath('');
    setAttachmentOpen(false);setDraftHelpOpen(false);draftRevision.current++;setDraft(''); setDraftStatus(''); composing.current = false;setCompositionActive(false);
    setOpened(undefined); setMessages([]); setActivity(undefined); setOffset(0); setCheckpoint(undefined); setMore(false);
    setFollowing(false); request.current++;
    return () => {request.current++;};
  }, [sessionId]);
  useEffect(() => {setFollowing(false); followRef.current = false; request.current++;}, [agent,path,view,transcriptSessionId,inlineImages]);
  useEffect(() => {
    if (!access.current()) {setAttachmentOpen(false);setFollowing(false); followRef.current = false; request.current++;}
  }, [accessState.epoch,access]);
  useEffect(() => {
    const visibility = () => {
      const current = document.visibilityState !== 'hidden' && !pageHidden.current;
      if (!current && automaticRequest.current) request.current++;
      setVisible(current);
    };
    const hide = () => {pageHidden.current = true; visibility();};
    const show = () => {pageHidden.current = false; visibility();};
    document.addEventListener('visibilitychange',visibility);
    window.addEventListener('pagehide',hide); window.addEventListener('pageshow',show);
    return () => {document.removeEventListener('visibilitychange',visibility); window.removeEventListener('pagehide',hide); window.removeEventListener('pageshow',show);};
  }, []);
  function currentRequest(current: number) {
    return mounted.current && access.current() && (!initialReported || initialReported.sessionId===sessionId) && request.current === current;
  }
  function jumpToLatest() {
    atLatestRef.current = true; setAtLatest(true);
    if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
  }
  useEffect(() => {if (following && atLatestRef.current) jumpToLatest();}, [following,messages]);
  const autoRead = useRef(() => {});
  autoRead.current = () => {void read(false,true);};
  // A bound conversation streams over one channel while it can; polling only fills in when it cannot.
  const watchTarget = useMemo<WatchTarget | undefined>(() => bound && conversation && sourceMatches && ['claude','codex'].includes(bound.agent)
    ? bound.herdr ? {kind:'herdr',agent:bound.agent,agentSessionId:bound.path,...bound.herdr} : {kind:'path',agent:bound.agent,path:bound.path} : undefined, [bound,conversation,sourceMatches]);
  const watch = useTranscriptWatch<Message>({enabled:!!watchTarget && following && visible && shown && !!access.current(),sessionId,
    target:watchTarget ?? {kind:'path',agent:'',path:''},lease:access,invoke,parsePage:parseWatchPage,onOp:op=>{
      holdPosition();setError('');
      setMessages(previous=>applyWatchOp(previous,op));
      if(op.kind==='replace')setActivity(op.activity);else if(op.activity)setActivity(op.activity.value);
      setUpdated(Date.now());
    }});
  const watchLive=useRef(false);watchLive.current=watch.live;
  // Reading older turns: the turn at the top of the view stays where it is while updates land around it.
  const anchor=useRef<{key:string;top:number}|null>(null);
  function holdPosition() {
    const list=messageList.current;anchor.current=null;
    if(!list || atLatestRef.current)return;
    const top=list.getBoundingClientRect().top;
    for(const child of Array.from(list.children)) {
      const box=child.getBoundingClientRect(),key=(child as HTMLElement).dataset.anchor;
      if(key && box.bottom>top){anchor.current={key,top:box.top-top};return;}
    }
  }
  useLayoutEffect(()=>{
    const held=anchor.current;anchor.current=null;
    const list=messageList.current;
    const element=held && list ? Array.from(list.children).find(child=>(child as HTMLElement).dataset.anchor===held.key) : undefined;
    if(held && list && element)list.scrollTop+=element.getBoundingClientRect().top-list.getBoundingClientRect().top-held.top;
  },[messages]);
  const [updated,setUpdated] = useState(Date.now);
  useEffect(() => {
    if (!following || !canFollow || busy || !visible || !shown || watch.live || !access.current()) return;
    const timer = setTimeout(() => autoRead.current(),2000);
    return () => clearTimeout(timer);
  }, [following,canFollow,busy,visible,shown,watch.live,completed,accessState.epoch,access]);
  const lagging = !!watchTarget && following && (watch.state === 'delayed' || watch.state === 'stale');
  const now = useNow(1000, lagging);
  async function discover() {
    if (flight.current || !access.current() || (initialReported && initialReported.sessionId!==sessionId)) return;
    flight.current = true;
    automaticRequest.current = false;
    const current = ++request.current;
    setBusy(true);
    setError("");
    setDiscovered([]);
    try {
      const result = await invoke<{
        schemaVersion: number;
        sessions: { path: string; name: string; sessionId?: string }[];
      }>("agent_transcripts", { sessionId, agent });
      if (
        result?.schemaVersion !== 1 ||
        !Array.isArray(result.sessions) ||
        result.sessions.length > 50 ||
        result.sessions.some(item => !isDiscoveredTranscript(item, 4096))
      )
        throw new LocalUiError('panelInvalidTranscriptList');
      if (currentRequest(current)) setDiscovered(result.sessions);
    } catch (e) {
      if (currentRequest(current)) setError(captureUiError(e));
    } finally {
      flight.current = false;
      automaticRequest.current = false;
      if (mounted.current && access.current()) {setBusy(false); setCompleted(value => value + 1);}
    }
  }
  /** The hook report must still tie this conversation to this pane and this file; a change retires the view. */
  async function checkReport(still: () => boolean) {
    if (!bound?.report) return;
    try {
      if(bound.report.paneId) {
        const snapshot=parseTerminalSnapshot(await invoke('tmux_chat',{sessionId,action:{kind:'snapshot'}}));
        if (!still()) return;
        if(snapshot.destination.paneId!==bound.report.paneId) throw new LocalUiError('chatChanged');
      }
      const reports=parseSnapshot(await invoke('agent_snapshot',{sessionId}));
      if (!still()) return;
      const matches=reports.filter(row=>row.sessionId===bound.report!.sessionId);
      if(matches.length!==1 || matches[0].agent!==bound.report.agent || (bound.report.paneId && (matches[0].paneId!==bound.report.paneId || reports.filter(row=>row.paneId===bound.report!.paneId).length!==1))) throw new LocalUiError('chatChanged');
      const history=parseReportedHistory(await invoke('agent_reported_history',{sessionId,agentSessionId:bound.report.sessionId}),bound.report.sessionId);
      if(history.status!=='available' || history.path!==bound.path || (bound.report.paneId && history.paneId!==bound.report.paneId)) throw new LocalUiError('chatChanged');
    } catch(error) {if(still())onBoundInvalid?.();throw error;}
  }
  async function read(reset: boolean, automatic = false, prepare = false) {
    if (watchLive.current && !reset) return;
    if (flight.current || !access.current() || (initialReported && initialReported.sessionId!==sessionId)) return;
    if (automatic && (!followRef.current || !canFollow || pageHidden.current || document.visibilityState === 'hidden')) return;
    const source = reset
      ? {
          agent,
          path: selectedPath,
          ...(prepare ? {checkpointed:true} : {}),
          ...(inlineImages && canIncludeImages ? {inlineImages:true} : {}),
          ...(["hermes", "opencode"].includes(agent)
            ? { transcriptSessionId }
            : {}),
          ...(view === "conversation" && ["claude", "grok-acp", "opencode", "codex"].includes(agent) ? { view } : {}),
        }
      : opened;
    if (!source) return;
    if(reset){setPreview(undefined);setInputOpen(value=>({generation:value.generation+1,pending:true}));}
    if (reset && source.agent === 'grok-acp') {setFollowing(false); followRef.current = false;}
    flight.current = true;
    automaticRequest.current = automatic;
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const replace = reset || source.view === "conversation";
      const cursor = replace ? 0 : offset;
      const validateReport = () => checkReport(() => currentRequest(current));
      if (bound?.report) {
        await validateReport();
        if (!currentRequest(current)) return;
      }
      const page = parseTranscript(
        await (bound?.herdr ? invoke("agent_herdr_conversation", {sessionId,target:{agent:bound.agent,agentSessionId:bound.path,...bound.herdr}}) : invoke("agent_transcript", {
          sessionId,
          ...source,
          offset: cursor,
          ...(!replace && (source.agent === "antigravity-jsonl" || source.checkpointed) ? { checkpoint } : {}),
        })),
      );
      // A stream that went live while this poll was out is newer than the page.
      if (!currentRequest(current) || (watchLive.current && !reset)) return;
      if (bound?.report) {
        await validateReport();
        if (!currentRequest(current)) return;
      }
      if (!source.inlineImages && page.messages.some(message=>message.blocks.some(block=>block.imagePreview!==undefined)))
        throw new LocalUiError('chatImageInvalid');
      if (source.checkpointed) validateRecordedPage(page,cursor,replace ? undefined : checkpoint);
      if (source.view === "conversation" && page.view !== "active_branch")
        throw new LocalUiError('chatUpdateCompanion');
      if (source.agent === 'opencode' && source.view === 'conversation' && page.branchId !== source.transcriptSessionId)
        throw new LocalUiError('chatChanged');
      if (
        page.agent !== source.agent ||
        page.nextOffset < cursor ||
        (page.hasMore && page.nextOffset === cursor)
      )
        throw new LocalUiError('chatChanged');
      if (!currentRequest(current)) return;
      setOpened(source);
      if (prepare || (reset && bound)) {setFollowing(true); followRef.current = true;}
      if (reset) {atLatestRef.current = true; setAtLatest(true);}
      setUpdated(Date.now());
      setOffset(page.nextOffset);
      setCheckpoint(page.checkpoint);
      setMore(page.hasMore);
      if (replace) setActivity(page.activity);
      setMessages((previous) => {
        const combined = replace
          ? page.messages
          : [...previous, ...page.messages];
        return [
          ...new Map(combined.map((message) => [message.id, message])).values(),
        ].slice(-500);
      });
    } catch (e) {
      if (currentRequest(current)) {
        setError(source.agent === "antigravity-jsonl" && errorMessage(e).includes("TranscriptChanged")
          ? new LocalUiError('chatChanged') : captureUiError(e));
        // A bound conversation keeps trying through a dropped connection, since the stream or the next poll recovers it
        // and clears the error. A conversation that is no longer this pane's, or a host that cannot read it, stops.
        const permanent = e instanceof LocalUiError ? ['chatChanged','herdrConversationCompanion','chatUpdateCompanion'].includes(e.key) : (e as {kind?: string} | null)?.kind === 'herdr_target_missing';
        if (!(bound && automatic) || permanent) {setFollowing(false); followRef.current = false;}
      }
    } finally {
      flight.current = false;
      automaticRequest.current = false;
      if (mounted.current && access.current()) {if(reset)setInputOpen(value=>({...value,pending:false}));setBusy(false); setCompleted(value => value + 1);}
    }
  }
  // A bound conversation opens with this reader, also after a dropped first read; errors wait for Refresh.
  useEffect(() => {if (shown && bound && path===bound.path && !opened && !error) void read(true);}, [shown, bound, path, opened, error, completed]);
  // A conversation view shows what the harness wrote as compact events, not as the person's bubbles.
  const flow = useMemo(() => opened?.view === 'conversation' || timeline ? projectMessages(messages) : messages, [opened?.view, timeline, messages]);
  const turns = useMemo(() => timeline ? groupTurns(flow) : [], [timeline, flow]);
  // The counters of the latest response go to the caller's details instead of under every answer.
  const latestUsage = useMemo(() => messages.filter(message => message.usage).at(-1)?.usage, [messages]);
  useEffect(() => onUsage?.(latestUsage), [onUsage, latestUsage]);
  const turnStart = turns.at(-1)?.prompt?.timestamp;
  useEffect(() => onTurnStart?.(turnStart), [onTurnStart, turnStart]);
  function stageDraft() {
    if (!allowStage || composing.current || !draft.trim()) return;
    if (draft.length > 65536) { setDraftStatus("chatDraftTooLong"); return; }
    window.dispatchEvent(new CustomEvent("lazysh-prompt-draft", { detail: { sessionId, text: draft } }));
    setDraftStatus("chatDraftStaged");
  }
  const eventLabel = ({kind,text}: InjectedEvent) => <>{t(({task:'chatEventTask',output:'chatEventOutput',interrupted:'chatEventInterrupted',compacted:'chatEventCompacted',answer:'chatEventAnswer'} as const)[kind])}{text && <> · <span>{text}</span></>}</>;
  const roleName = (message: Message) => t(({user:"chatRoleUser",assistant:"chatRoleAssistant",tool:"chatRoleTool",record:"chatRoleRecord"} as const)[message.role]);
  // The timeline shows prompt and answer as chat bubbles; the role stays the accessible name.
  const renderMessage = (message: Message) => message.event ? (
    <article key={message.id} className="chat-message agent-event">
      {message.event.detail
        ? <details><summary>{eventLabel(message.event)}</summary><pre>{message.event.detail}</pre></details>
        : <p>{eventLabel(message.event)}</p>}
    </article>
  ) : (
    <article key={message.id} className={timeline ? `chat-message agent-bubble agent-bubble-${message.role}` : "chat-message"} aria-label={timeline ? roleName(message) : undefined}>
      {!timeline && <h4>{roleName(message)}</h4>}
      {message.record && <p>
        {message.record.stepIndex !== undefined ? `${t("chatStep", {index:message.record.stepIndex})} · ` : ""}
        {t("chatRecordMetadata", {source:message.record.source, type:message.record.type, status:message.record.status})}
        {message.record.exitCode !== undefined && ` · ${t("chatExitCode", {code:message.record.exitCode})}`}
        {message.record.errorCode !== undefined && ` · ${t("chatErrorCode", {code:message.record.errorCode})}`}
        {message.record.truncatedFields.length > 0 && ` · ${t("chatTruncation", {fields:message.record.truncatedFields.join(", ")})}`}
      </p>}
      {message.blocks.map((block, index) => {
        const card = block.card && <ChatCard card={block.card} body={block.text} answered={!!block.id && answered.has(block.id)} onOpenTerminal={onOpenTerminal} />;
        return block.type === "text" ? (
          <Fragment key={index}>{card ?? <ChatMarkdown text={block.text || ""} />}</Fragment>
        ) : (
          <Fragment key={index}>{card}<details>
            <summary>
              {block.name || t(({text:"chatBlockText",thinking:"chatBlockThinking",tool_use:"chatBlockToolUse",tool_result:"chatBlockToolResult",image:"chatBlockImage"} as const)[block.type])}
              {block.status && ` · ${t("chatToolStatus", {status:block.status, id:block.id!})}`}
              {block.isError === true && ` · ${block.id ? t("chatToolErrorWithId", {id:block.id}) : t("chatToolError")}`}
            </summary>
            <pre>
              {block.text || t("chatViewInTerminal")}
            </pre>
            {block.imagePreview && opened?.inlineImages && <button type="button" disabled={previewBusy || !access.current() || !sourceMatches} onClick={()=>setPreview({image:block.imagePreview!,messageId:message.id,blockIndex:index,source:previewSource,attempt:++previewAttempt.current})}>{t('chatImageView')}</button>}
          </details></Fragment>
        );
      })}
      {message.usage && !timeline && (
        <small>
          {Object.entries(message.usage)
            .map(([name, count]) => `${name}: ${count}`)
            .join(" · ")}
        </small>
      )}
    </article>
  );
  // Bound to the Agent view, the composer is one row: these tools move beside Stage. A followed conversation needs no Refresh.
  const draftTools = <div className="chat-draft-tools">
    {opened && !(bound && following) && <button type="button" className="icon-button" disabled={busy} aria-label={t(busy?'chatReading':more?'chatNextMessages':'chatRefreshMessages')} title={t(busy?'chatReading':more?'chatNextMessages':'chatRefreshMessages')} onClick={() => void read(false)}><RefreshCw size={18} aria-hidden="true"/></button>}
    <button ref={attachmentButton} type="button" className="icon-button" disabled={!access.current()} aria-expanded={attachmentOpen} aria-label={t(attachmentOpen?'chatCloseAttachment':'chatAddAttachment')} title={t(attachmentOpen?'chatCloseAttachment':'chatAddAttachment')} onClick={()=>toggleAttachment(!attachmentOpen)}>{attachmentOpen?<X size={18} aria-hidden="true"/>:<Paperclip size={18} aria-hidden="true"/>}</button>
    {allowStage && <button type="button" className="icon-button" aria-expanded={draftHelpOpen} aria-controls={draftHelpId} aria-label={t('chatDraftHelp')} title={t('chatDraftHelp')} onClick={()=>setDraftHelpOpen(value=>!value)}><Info size={18} aria-hidden="true"/></button>}
  </div>;
  return (
    <section ref={chatRoot} className="tool-panel chat-panel" hidden={!shown} data-bound={bound ? "" : undefined} data-watch={watchTarget && following ? watch.state : undefined} data-attachment-open={attachmentOpen || undefined} aria-label={t("chatTitle")}>
      {!bound && <>
      <h3>{t("chatTitle")}</h3>
      <p>
        {t("chatExplanation")}
      </p>
      {reportedMatches && access.current() && <p className="security-note">{t('agentsHistoryNotice')}</p>}
      <form
        className="tool-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void read(true);
        }}
      >
        <label>
          {t("chatAgent")}
          <select
            disabled={busy}
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value);setInlineImages(false);
              if (["grok-acp","codex"].includes(event.target.value)) setView("records");
              setDiscovered([]);
              setTranscriptSessionId("");
            }}
          >
            {Object.entries(agents).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {["claude", "grok-acp", "opencode", "codex"].includes(agent) && (
          <label>
            {t("chatView")}
            {/* Changing Agent can reset View in code. WebKit then fires no change when the user picks
                the option it last reported, so each agent gets a fresh select. */}
            <select
              key={agent}
              value={view}
              onChange={(event) => setView(event.target.value)}
            >
              <option value="records">{t("chatRecordedMessages")}</option>
              <option value="conversation">{t(agent === "opencode" ? "chatConversation" : "chatLatestBranch")}</option>
            </select>
          </label>
        )}
        <button type="button" disabled={busy || agent === "antigravity-jsonl"} onClick={() => void discover()}>
          {t("chatFind")}
        </button>
        {canIncludeImages && <label><input type="checkbox" checked={inlineImages} onChange={event=>setInlineImages(event.target.checked)} />{t('chatImageInclude')}</label>}
        {agent === "grok-acp" && view !== "conversation" && (
          <p>
            {t("chatGrokExplanation")}
          </p>
        )}
        {agent === "antigravity-jsonl" && <p>
          {t("chatAntigravityExplanation")}
        </p>}
        <label>
          {t("chatPath")}
          <input
            required
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t("chatPathHint")}
          />
        </label>
        {["hermes", "opencode"].includes(agent) && (
          <label>
            {t("chatSessionId")}
            <input
              required
              maxLength={4096}
              value={transcriptSessionId}
              onChange={(event) => setTranscriptSessionId(event.target.value)}
            />
          </label>
        )}
        <button disabled={busy || !path.trim()} type="submit">
          {t("chatOpen")}
        </button>
      </form>
      {discovered.length > 0 && (
        <label>
          {t("chatRecent")}
          <select
            value=""
            onChange={(event) => {
              const item = discovered[Number(event.target.value)];
              if (item) {
                setPath(item.path);
                setTranscriptSessionId(item.sessionId || "");
              }
            }}
          >
            <option value="">{t("chatSelect")}</option>
            {discovered.map((item, index) => (
              <option
                key={`${item.path}:${item.sessionId || ""}`}
                value={index}
              >
                {item.name} — {item.path}
              </option>
            ))}
          </select>
        </label>
      )}
      {agent === "opencode" && view === "conversation" && <p className="muted">{t("chatOpencodeConversation")}</p>}
      {agent === "grok-acp" && view === "conversation" && <p className="muted">{t("chatGrokConversation")}</p>}
      </>}
      {error && (
        <p className="inline-error" role="alert">
          {uiErrorText(error)}
        </p>
      )}
      {error instanceof LocalUiError && error.key === "herdrConversationCompanion" && onOpenCompanion && <button type="button" className="subtle-button" onClick={onOpenCompanion}>{t("companionInstallTitle")}</button>}
      {bound && busy && !opened && !error && <p role="status">{t("chatReading")}</p>}
      {opened && !bound && (
        <p>
          <code>{opened.path}</code> ·{" "}
          {opened.view === "conversation"
            ? t("chatBranchLimit")
            : opened.agent === "antigravity-jsonl" ? t("chatStepLimit") : t("chatMessageLimit")}
        </p>
      )}
      {agent === 'grok-acp' && view === 'records' && <button type="button" disabled={busy || !path.trim() || !access.current()} onClick={() => void read(true,false,true)}>
        {t('chatRecordedStart')}
      </button>}
      {bound && !atLatest && <div className="chat-follow-controls"><button onClick={jumpToLatest}>{t("chatJumpLatest")}</button></div>}
      {followable && !bound && <div className="chat-follow-controls">
        <label><input type="checkbox" disabled={!canFollow || !access.current() || (recorded && busy && !automaticRequest.current)} checked={following} onChange={event => {
          followRef.current = event.target.checked; setFollowing(event.target.checked);
          if (!event.target.checked && automaticRequest.current) request.current++;
          if (event.target.checked) setError('');
        }} />{t(recorded ? "chatRecordedFollow" : opened?.agent === 'opencode' ? 'chatOpencodeFollow' : opened?.agent==='codex' ? 'chatCodexFollow' : "chatFollow")}</label>
        <p>{t(recorded ? "chatRecordedExplanation" : "chatFollowExplanation")}</p>
        {following && <p role="status">{visible ? t(recorded ? "chatRecordedFollowing" : "chatFollowing") : t("chatFollowPaused")}</p>}
        {recorded && !following && <p role="status">{t('chatRecordedPaused')}</p>}
        {!atLatest && <button onClick={jumpToLatest}>{t("chatJumpLatest")}</button>}
      </div>}
      {conversation && sourceMatches && !bound && <ChatActivity activity={activity} />}
      <div ref={messageList} className={`chat-messages${followable ? ' chat-conversation-messages' : ''}`} role={followable ? 'region' : undefined} aria-label={followable ? t(recorded ? 'chatRecordedRegion' : 'chatConversation') : undefined} tabIndex={followable ? 0 : undefined} onScroll={() => {
        const element = messageList.current;
        if (element) {const latest = element.scrollHeight - element.clientHeight - element.scrollTop <= 24; atLatestRef.current = latest; setAtLatest(latest);}
      }}>
        {timeline ? turns.map(turn => <section key={turn.key} data-anchor={turn.key} className="agent-turn" aria-label={t('agentViewTurn')}>
          {turn.event && renderMessage(turn.event)}
          {turn.prompt && renderMessage(turn.prompt)}
          {turn.activity.length > 0 && <details className="agent-turn-activity"><summary>{activitySummary(turn)}</summary>{turn.activity.map(renderMessage)}</details>}
          {turn.answer && renderMessage(turn.answer)}
        </section>) : flow.map(renderMessage)}
        {timeline && (activity === 'working' || activity === 'waiting') && <p className="agent-working" role="status" data-activity={activity}>
          <span className="chat-activity-dot" aria-hidden="true" />{t(activity === 'working' ? 'chatActivityWorking' : 'chatActivityWaiting')}
        </p>}
      </div>
      {lagging && <p className="chat-watch-note" role="status" data-watch={watch.state}>{now - updated > 6000 ? t('chatWatchStale',{time:formatRelativeTime(updated,now)}) : t('chatWatchDelayed')}</p>}
      {watchTarget && following && watch.state === 'unsupported' && <p className="chat-watch-note" role="status" data-watch="unsupported">{t('chatWatchCompanion')} {onOpenCompanion && <button type="button" className="subtle-button" onClick={onOpenCompanion}>{t('companionInstallTitle')}</button>}</p>}
      {preview && preview.source===previewSource && access.current() && previewRetained && <RecordedImagePreview key={preview.attempt} image={preview.image} access={access} onBusy={updatePreviewBusy} onClose={()=>setPreview(undefined)} />}
      {/* A conversation that can neither stage nor send has nothing to compose: no dead input box. */}
      {(!bound || allowStage || terminalInput) && <div className="chat-draft">
        <div className="chat-draft-header">
          <label htmlFor={draftId} className={bound ? "sr-only" : undefined}>{t("chatDraftLabel")}</label>
          {!bound && draftTools}
        </div>
        <p id={draftHelpId} className="chat-draft-help" hidden={!draftHelpOpen}>{t("chatDraftExplanation")}</p>
        {attachmentOpen && access.current() && <div className="chat-attachment-view">
          <button ref={attachmentBack} type="button" className="subtle-button chat-attachment-back" onClick={()=>toggleAttachment(false)}><ArrowLeft size={18} aria-hidden="true"/>{t('navigationBack')}</button>
          <p>{t('chatAttachmentScope')}</p>
          <AttachmentPanel key={sessionId} sessionId={sessionId} onAttach={path=>{
            if(!mounted.current || !access.current() || currentSession.current!==sessionId || composing.current)return;
            const next=draft?`${draft}\n${shellPath(path)}`:shellPath(path);
            if(next.length>65536){setDraftStatus('chatAttachmentTooLong');return;}
            draftRevision.current++;setDraft(next);setDraftStatus('');setAttachmentOpen(false);
          }}/>
        </div>}
        <form className="form-stack chat-composer" aria-label={t("chatDraft")} onSubmit={event => { event.preventDefault(); stageDraft(); }}>
          <textarea id={draftId} rows={bound ? Math.min(6, draft.split('\n').length) : 4} maxLength={65536} value={draft} onChange={event => { draftRevision.current++;setDraft(event.target.value); setDraftStatus(""); }} onCompositionStart={() => { composing.current = true;setCompositionActive(true); }} onCompositionEnd={() => { composing.current = false;setCompositionActive(false); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); stageDraft(); } }} />
          <div className="chat-draft-commands">{bound && draftTools}{onOpenTerminal && !bound && <button type="button" className="icon-button" aria-label={t("chatOpenTerminal")} title={t("chatOpenTerminal")} onClick={onOpenTerminal}><Terminal size={18} aria-hidden="true"/></button>}{(!bound || draft) && <button type="button" className="icon-button" aria-label={t("chatClearDraft")} title={t("chatClearDraft")} disabled={!draft} onClick={() => { draftRevision.current++;setDraft(""); setDraftStatus(""); }}><Trash2 size={18} aria-hidden="true"/></button>}{allowStage && <button type="submit" className="primary-button chat-stage" disabled={!draft.trim() || draft.length > 65536}>{t("chatStage")}</button>}</div>
          {shown && terminalInput && terminalSource && sourceMatches && !inputOpen.pending && access.current() && <ChatTerminalInput
            key={`${terminalInputKey}:${inputOpen.generation}`} sessionId={sessionId} source={terminalSource} labels={terminalInput} notes={!bound || draftHelpOpen}
            access={access} invoke={invoke} draft={draft} draftRevision={draftRevision.current} composing={composing} compositionActive={compositionActive}
            onSent={(text,revision)=>{
              if(draftRevision.current===revision){draftRevision.current++;setDraft(current=>current===text?'':current);setDraftStatus('');}
            }}
          />}
          {draftStatus && <p role="status">{t(draftStatus)}</p>}
        </form>
      </div>}
    </section>
  );
}

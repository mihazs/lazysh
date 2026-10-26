import {t, useUi} from './i18n/core';
import { transcriptAgents as agents, isDiscoveredTranscript } from "./transcriptSources";
import { captureAccess, useAccessSnapshot, useProtectedInvoke } from './access';
import { useCallback, useEffect, useRef, useState } from "react";

import Markdown from "react-markdown";
import {errorMessage, captureUiError, uiErrorText, LocalUiError, type UiErrorCause} from './i18n/localError';
import {validateRecordedPage} from './recordedFollow';
import {recordedImage,type RecordedImage} from './recordedImage';
import RecordedImagePreview from './RecordedImagePreview';

type Block = {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  isError?: boolean;
  imagePreview?: RecordedImage;
};
type Message = {
  id: string;
  role: "user" | "assistant" | "tool" | "record";
  record?: { source: string; type: string; status: string; stepIndex?: number; exitCode?: number; errorCode?: number; truncatedFields: string[] };
  timestamp?: string;
  blocks: Block[];
  usage?: Record<string, number | string>;
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
};


export function parseTranscript(value: unknown): Page {
  if (!value || typeof value !== "object")
    throw new Error(t("chatInvalidResponse"));
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
    throw new Error(t("chatUnsupportedResponse"));
  if (page.agent === "antigravity-jsonl") {
    const bytes = Number(page.checkpoint!.split(":")[1]);
    if (bytes > 16 * 1024 * 1024 || page.nextOffset > bytes) throw new Error(t("chatInvalidCheckpoint"));
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
      throw new Error(t("chatInvalidMessage"));
    if (page.agent === "antigravity-jsonl") {
      const metadata = message.record;
      if (message.role !== "record" || !metadata || [metadata.source, metadata.type, metadata.status].some(value => typeof value !== "string" || value.length > 256)
        || !Array.isArray(metadata.truncatedFields) || metadata.truncatedFields.length > 64 || metadata.truncatedFields.some(value => typeof value !== "string" || value.length > 256)
        || (metadata.stepIndex !== undefined && (!Number.isInteger(metadata.stepIndex) || metadata.stepIndex < 0 || metadata.stepIndex > 4294967295))
        || (metadata.errorCode !== undefined && (!Number.isInteger(metadata.errorCode) || metadata.errorCode < 0 || metadata.errorCode > 4294967295))
        || (metadata.exitCode !== undefined && (!Number.isInteger(metadata.exitCode) || metadata.exitCode < -2147483648 || metadata.exitCode > 2147483647)))
        throw new Error(t("chatInvalidRecordMetadata"));
    } else if (message.record !== undefined) throw new Error(t("chatUnexpectedRecordMetadata"));
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
        throw new Error(t("chatInvalidBlock"));
      for (const field of ["text", "id", "name"] as const)
        if (
          block[field] !== undefined &&
          (typeof block[field] !== "string" || block[field].length > 262144)
        )
          throw new Error(t("chatInvalidContent"));
      if (block.status !== undefined && (page.agent !== 'grok-acp'
        || !['tool_use','tool_result','image'].includes(block.type)
        || !['pending','in_progress','completed','failed'].includes(block.status)
        || typeof block.id !== 'string' || !block.id || block.id.length > 256 || new TextEncoder().encode(block.id).length > 256))
        throw new Error(t("chatInvalidToolStatus"));
      if (block.isError !== undefined && (page.agent !== 'claude' || block.type !== 'tool_result' || typeof block.isError !== 'boolean'))
        throw new Error(t("chatInvalidToolError"));
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
      throw new Error(t("chatInvalidUsage"));
  }
  return page;
}

export default function ChatPanel({ sessionId, onOpenTerminal }: { sessionId: string; onOpenTerminal?: () => void }) {
  useUi();
  const invoke = useProtectedInvoke();
  const access = useRef(captureAccess()).current;
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
  const [agent, setAgent] = useState("claude");
  const [path, setPath] = useState("");
  const [view, setView] = useState("records");
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
  const [opened, setOpened] = useState<{
    agent: string;
    path: string;
    view?: string;
    transcriptSessionId?: string;
    checkpointed?: boolean;
    inlineImages?: boolean;
  }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const previewRetained = preview && messages.some(message=>message.id===preview.messageId && message.blocks[preview.blockIndex]?.imagePreview?.data===preview.image.data);
  useEffect(()=>{if(preview && !previewRetained)setPreview(undefined);},[preview,previewRetained]);
  const [offset, setOffset] = useState(0);
  const [checkpoint, setCheckpoint] = useState<string>();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<UiErrorCause>("");
  const [draft, setDraft] = useState("");
  const [draftStatus, setDraftStatus] = useState<"" | "chatDraftTooLong" | "chatDraftStaged">("");
  const composing = useRef(false);
  const request = useRef(0);
  const conversation = opened?.agent === 'claude' && opened.view === 'conversation';
  const recorded = opened?.agent === 'grok-acp' && opened.checkpointed === true;
  const followable = conversation || recorded;
  const sourceMatches = !!opened && agent===opened.agent && view===(opened.view??'records') && path.trim()===opened.path && (canIncludeImages&&inlineImages)===!!opened.inlineImages;
  const canFollow = followable && sourceMatches;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; request.current++;};}, []);
  useEffect(() => {
    setDraft(''); setDraftStatus(''); composing.current = false;
    setOpened(undefined); setMessages([]); setOffset(0); setCheckpoint(undefined); setMore(false);
    setFollowing(false); request.current++;
    return () => {request.current++;};
  }, [sessionId]);
  useEffect(() => {setFollowing(false); followRef.current = false; request.current++;}, [agent,path,view,transcriptSessionId,inlineImages]);
  useEffect(() => {
    if (!access.current()) {setFollowing(false); followRef.current = false; request.current++;}
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
    return mounted.current && access.current() && request.current === current;
  }
  function jumpToLatest() {
    atLatestRef.current = true; setAtLatest(true);
    if (messageList.current) messageList.current.scrollTop = messageList.current.scrollHeight;
  }
  useEffect(() => {if (following && atLatestRef.current) jumpToLatest();}, [following,messages]);
  const autoRead = useRef(() => {});
  autoRead.current = () => {void read(false,true);};
  useEffect(() => {
    if (!following || !canFollow || busy || !visible || !access.current()) return;
    const timer = setTimeout(() => autoRead.current(),2000);
    return () => clearTimeout(timer);
  }, [following,canFollow,busy,visible,completed,accessState.epoch,access]);
  async function discover() {
    if (flight.current || !access.current()) return;
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
  async function read(reset: boolean, automatic = false, prepare = false) {
    if (flight.current || !access.current()) return;
    if (automatic && (!followRef.current || !canFollow || pageHidden.current || document.visibilityState === 'hidden')) return;
    const source = reset
      ? {
          agent,
          path: path.trim(),
          ...(prepare ? {checkpointed:true} : {}),
          ...(inlineImages && canIncludeImages ? {inlineImages:true} : {}),
          ...(["hermes", "opencode"].includes(agent)
            ? { transcriptSessionId }
            : {}),
          ...(view === "conversation" && ["claude", "grok-acp"].includes(agent) ? { view } : {}),
        }
      : opened;
    if (!source) return;
    if(reset)setPreview(undefined);
    if (reset && source.agent === 'grok-acp') {setFollowing(false); followRef.current = false;}
    flight.current = true;
    automaticRequest.current = automatic;
    const current = ++request.current;
    setBusy(true);
    setError("");
    try {
      const replace = reset || source.view === "conversation";
      const cursor = replace ? 0 : offset;
      const page = parseTranscript(
        await invoke("agent_transcript", {
          sessionId,
          ...source,
          offset: cursor,
          ...(!replace && (source.agent === "antigravity-jsonl" || source.checkpointed) ? { checkpoint } : {}),
        }),
      );
      if (!source.inlineImages && page.messages.some(message=>message.blocks.some(block=>block.imagePreview!==undefined)))
        throw new LocalUiError('chatImageInvalid');
      if (source.checkpointed) validateRecordedPage(page,cursor,replace ? undefined : checkpoint);
      if (source.view === "conversation" && page.view !== "active_branch")
        throw new Error(
          t("chatUpdateCompanion"),
        );
      if (
        page.agent !== source.agent ||
        page.nextOffset < cursor ||
        (page.hasMore && page.nextOffset === cursor)
      )
        throw new Error(t("chatChanged"));
      if (!currentRequest(current)) return;
      setOpened(source);
      if (prepare) {setFollowing(true); followRef.current = true;}
      if (reset) {atLatestRef.current = true; setAtLatest(true);}
      setOffset(page.nextOffset);
      setCheckpoint(page.checkpoint);
      setMore(page.hasMore);
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
          ? t("chatChanged") : captureUiError(e));
        setFollowing(false); followRef.current = false;
      }
    } finally {
      flight.current = false;
      automaticRequest.current = false;
      if (mounted.current && access.current()) {setBusy(false); setCompleted(value => value + 1);}
    }
  }
  function stageDraft() {
    if (composing.current || !draft.trim()) return;
    if (draft.length > 65536) { setDraftStatus("chatDraftTooLong"); return; }
    window.dispatchEvent(new CustomEvent("lazysh-prompt-draft", { detail: { sessionId, text: draft } }));
    setDraftStatus("chatDraftStaged");
  }
  return (
    <section className="tool-panel chat-panel" aria-label={t("chatTitle")}>
      <h3>{t("chatTitle")}</h3>
      <p>
        {t("chatExplanation")}
      </p>
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
        {["claude", "grok-acp"].includes(agent) && (
          <label>
            {t("chatView")}
            <select
              value={view}
              onChange={(event) => setView(event.target.value)}
            >
              <option value="records">{t("chatRecordedMessages")}</option>
              <option value="conversation">{t("chatLatestBranch")}</option>
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
      {agent === "grok-acp" && view === "conversation" && <p className="muted">{t("chatGrokConversation")}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {uiErrorText(error)}
        </p>
      )}
      {opened && (
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
      {followable && <div className="chat-follow-controls">
        <label><input type="checkbox" disabled={!canFollow || !access.current() || (recorded && busy && !automaticRequest.current)} checked={following} onChange={event => {
          followRef.current = event.target.checked; setFollowing(event.target.checked);
          if (!event.target.checked && automaticRequest.current) request.current++;
          if (event.target.checked) setError('');
        }} />{t(recorded ? "chatRecordedFollow" : "chatFollow")}</label>
        <p>{t(recorded ? "chatRecordedExplanation" : "chatFollowExplanation")}</p>
        {following && <p role="status">{visible ? t(recorded ? "chatRecordedFollowing" : "chatFollowing") : t("chatFollowPaused")}</p>}
        {recorded && !following && <p role="status">{t('chatRecordedPaused')}</p>}
        {!atLatest && <button onClick={jumpToLatest}>{t("chatJumpLatest")}</button>}
      </div>}
      <div ref={messageList} className={`chat-messages${followable ? ' chat-conversation-messages' : ''}`} role={followable ? 'region' : undefined} aria-label={followable ? t(recorded ? 'chatRecordedRegion' : 'chatConversation') : undefined} tabIndex={followable ? 0 : undefined} onScroll={() => {
        const element = messageList.current;
        if (element) {const latest = element.scrollHeight - element.clientHeight - element.scrollTop <= 24; atLatestRef.current = latest; setAtLatest(latest);}
      }}>
        {messages.map((message) => (
          <article key={message.id} className="chat-message">
            <h4>{t(({user:"chatRoleUser",assistant:"chatRoleAssistant",tool:"chatRoleTool",record:"chatRoleRecord"} as const)[message.role])}</h4>
            {message.record && <p>
              {message.record.stepIndex !== undefined ? `${t("chatStep", {index:message.record.stepIndex})} · ` : ""}
              {t("chatRecordMetadata", {source:message.record.source, type:message.record.type, status:message.record.status})}
              {message.record.exitCode !== undefined && ` · ${t("chatExitCode", {code:message.record.exitCode})}`}
              {message.record.errorCode !== undefined && ` · ${t("chatErrorCode", {code:message.record.errorCode})}`}
              {message.record.truncatedFields.length > 0 && ` · ${t("chatTruncation", {fields:message.record.truncatedFields.join(", ")})}`}
            </p>}
            {message.blocks.map((block, index) =>
              block.type === "text" ? (
                <Markdown
                  key={index}
                  components={{
                    img: () => <span>{t("chatImagePlaceholder")}</span>,
                    a: ({ children }) => <span>{children}</span>,
                  }}
                >
                  {block.text || ""}
                </Markdown>
              ) : (
                <details key={index}>
                  <summary>
                    {block.name || t(({text:"chatBlockText",thinking:"chatBlockThinking",tool_use:"chatBlockToolUse",tool_result:"chatBlockToolResult",image:"chatBlockImage"} as const)[block.type])}
                    {block.status && ` · ${t("chatToolStatus", {status:block.status, id:block.id!})}`}
                    {block.isError === true && ` · ${block.id ? t("chatToolErrorWithId", {id:block.id}) : t("chatToolError")}`}
                  </summary>
                  <pre>
                    {block.text || t("chatViewInTerminal")}
                  </pre>
                  {block.imagePreview && opened?.inlineImages && <button type="button" disabled={previewBusy || !access.current() || !sourceMatches} onClick={()=>setPreview({image:block.imagePreview!,messageId:message.id,blockIndex:index,source:previewSource,attempt:++previewAttempt.current})}>{t('chatImageView')}</button>}
                </details>
              ),
            )}
            {message.usage && (
              <small>
                {Object.entries(message.usage)
                  .map(([name, count]) => `${name}: ${count}`)
                  .join(" · ")}
              </small>
            )}
          </article>
        ))}
      </div>
      {preview && preview.source===previewSource && access.current() && previewRetained && <RecordedImagePreview key={preview.attempt} image={preview.image} access={access} onBusy={updatePreviewBusy} onClose={()=>setPreview(undefined)} />}
      {opened && (
        <button disabled={busy} onClick={() => void read(false)}>
          {busy
            ? t("chatReading")
            : more
              ? t("chatNextMessages")
              : t("chatRefreshMessages")}
        </button>
      )}
      <form className="form-stack chat-composer" aria-label={t("chatDraft")} onSubmit={event => { event.preventDefault(); stageDraft(); }}>
        <label>{t("chatDraftLabel")}<textarea rows={4} maxLength={65536} value={draft} onChange={event => { setDraft(event.target.value); setDraftStatus(""); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); stageDraft(); } }} /></label>
        <p>{t("chatDraftExplanation")}</p>
        <div className="button-row"><button type="submit" disabled={!draft.trim() || draft.length > 65536}>{t("chatStage")}</button>{onOpenTerminal && <button type="button" onClick={onOpenTerminal}>{t("chatOpenTerminal")}</button>}<button type="button" disabled={!draft} onClick={() => { setDraft(""); setDraftStatus(""); }}>{t("chatClearDraft")}</button></div>
        {draftStatus && <p role="status">{t(draftStatus)}</p>}
      </form>
    </section>
  );
}

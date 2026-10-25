import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";

import Markdown from "react-markdown";
import { errorMessage } from "./SessionTools";

type Block = {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  text?: string;
  id?: string;
  name?: string;
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
const agents: Record<string, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  omp: "OMP",
  hermes: "Hermes",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  "qoder-ide": "Qoder IDE",
  kimi: "Kimi CLI",
  jcode: "jcode",
  droid: "Factory Droid",
  cursor: "Cursor IDE",
  omo: "OmO Native",
  "devin-atif": "Devin ATIF export",
  "amp-json": "Amp JSON export",
  "grok-acp": "Grok ACP records (explicit file)",
  "antigravity-jsonl": "Antigravity step records (explicit file)",
};

export function parseTranscript(value: unknown): Page {
  if (!value || typeof value !== "object")
    throw new Error("Invalid transcript response.");
  const page = value as Page;
  if (
    page.schemaVersion !== 1 ||
    !Object.hasOwn(agents, page.agent) ||
    (["grok-acp", "antigravity-jsonl"].includes(page.agent) && page.view !== "record_stream") ||
    (page.agent === "antigravity-jsonl" && (typeof page.checkpoint !== "string" || !/^v1:[0-9]{1,8}:[0-9a-f]{64}$/.test(page.checkpoint))) ||
    !Array.isArray(page.messages) ||
    page.messages.length > 100 ||
    !Number.isSafeInteger(page.nextOffset) ||
    page.nextOffset < 0 ||
    typeof page.hasMore !== "boolean"
  )
    throw new Error("Unsupported transcript response.");
  if (page.agent === "antigravity-jsonl") {
    const bytes = Number(page.checkpoint!.split(":")[1]);
    if (bytes > 16 * 1024 * 1024 || page.nextOffset > bytes) throw new Error("Invalid transcript snapshot checkpoint.");
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
      throw new Error("Invalid transcript message.");
    if (page.agent === "antigravity-jsonl") {
      const metadata = message.record;
      if (message.role !== "record" || !metadata || [metadata.source, metadata.type, metadata.status].some(value => typeof value !== "string" || value.length > 256)
        || !Array.isArray(metadata.truncatedFields) || metadata.truncatedFields.length > 64 || metadata.truncatedFields.some(value => typeof value !== "string" || value.length > 256)
        || (metadata.stepIndex !== undefined && (!Number.isInteger(metadata.stepIndex) || metadata.stepIndex < 0 || metadata.stepIndex > 4294967295))
        || (metadata.errorCode !== undefined && (!Number.isInteger(metadata.errorCode) || metadata.errorCode < 0 || metadata.errorCode > 4294967295))
        || (metadata.exitCode !== undefined && (!Number.isInteger(metadata.exitCode) || metadata.exitCode < -2147483648 || metadata.exitCode > 2147483647)))
        throw new Error("Invalid Antigravity record metadata.");
    } else if (message.record !== undefined) throw new Error("Unexpected transcript record metadata.");
    for (const block of message.blocks) {
      if (
        !block ||
        !["text", "thinking", "tool_use", "tool_result", "image"].includes(
          block.type,
        )
      )
        throw new Error("Invalid transcript block.");
      for (const field of ["text", "id", "name"] as const)
        if (
          block[field] !== undefined &&
          (typeof block[field] !== "string" || block[field].length > 262144)
        )
          throw new Error("Invalid transcript content.");
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
      throw new Error("Invalid transcript usage.");
  }
  return page;
}

export default function ChatPanel({ sessionId, onOpenTerminal }: { sessionId: string; onOpenTerminal?: () => void }) {
  const invoke = useProtectedInvoke();
  const [agent, setAgent] = useState("claude");
  const [path, setPath] = useState("");
  const [view, setView] = useState("records");
  const [discovered, setDiscovered] = useState<
    { path: string; name: string; sessionId?: string }[]
  >([]);
  const [transcriptSessionId, setTranscriptSessionId] = useState("");
  const [opened, setOpened] = useState<{
    agent: string;
    path: string;
    view?: string;
    transcriptSessionId?: string;
  }>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [offset, setOffset] = useState(0);
  const [checkpoint, setCheckpoint] = useState<string>();
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [draftStatus, setDraftStatus] = useState("");
  const composing = useRef(false);
  const request = useRef(0);
  useEffect(() => { setDraft(""); setDraftStatus(""); composing.current = false; }, [sessionId]);
  useEffect(
    () => () => {
      request.current++;
    },
    [sessionId],
  );
  async function discover() {
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
        result.sessions.some(
          (item) =>
            !item ||
            typeof item.path !== "string" ||
            item.path.length > 4096 ||
            typeof item.name !== "string" ||
            item.name.length > 4096 ||
            (item.sessionId !== undefined &&
              (typeof item.sessionId !== "string" ||
                item.sessionId.length > 4096)),
        )
      )
        throw new Error("Invalid transcript list.");
      if (current === request.current) setDiscovered(result.sessions);
    } catch (e) {
      if (current === request.current) setError(errorMessage(e));
    } finally {
      if (current === request.current) setBusy(false);
    }
  }
  async function read(reset: boolean) {
    const source = reset
      ? {
          agent,
          path: path.trim(),
          ...(["hermes", "opencode"].includes(agent)
            ? { transcriptSessionId }
            : {}),
          ...(view === "conversation" && agent === "claude" ? { view } : {}),
        }
      : opened;
    if (!source) return;
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
          ...(!replace && source.agent === "antigravity-jsonl" ? { checkpoint } : {}),
        }),
      );
      if (source.view === "conversation" && page.view !== "active_branch")
        throw new Error(
          "Update the host companion to read conversation branches.",
        );
      if (
        page.agent !== source.agent ||
        page.nextOffset < cursor ||
        (page.hasMore && page.nextOffset === cursor)
      )
        throw new Error("Transcript changed. Open it again to restart.");
      if (request.current !== current) return;
      setOpened(source);
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
      if (request.current === current) setError(source.agent === "antigravity-jsonl" && errorMessage(e).includes("TranscriptChanged")
        ? "Transcript changed. Open it again to restart." : errorMessage(e));
    } finally {
      if (request.current === current) setBusy(false);
    }
  }
  function stageDraft() {
    if (composing.current || !draft.trim()) return;
    if (draft.length > 65536) { setDraftStatus("Shorten the draft to 65,536 characters before staging it."); return; }
    window.dispatchEvent(new CustomEvent("lazysh-prompt-draft", { detail: { sessionId, text: draft } }));
    setDraftStatus("Review this draft in the terminal before pasting it.");
  }
  return (
    <section className="tool-panel chat-panel" aria-label="Agent transcript">
      <h3>Agent transcript</h3>
      <p>
        Read recorded messages directly from your host. Branches may include
        earlier conversation paths. A selected transcript does not establish
        which agent is currently running in this terminal.
      </p>
      <form
        className="tool-bar"
        onSubmit={(event) => {
          event.preventDefault();
          void read(true);
        }}
      >
        <label>
          Agent
          <select
            disabled={busy}
            value={agent}
            onChange={(event) => {
              setAgent(event.target.value);
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
        {agent === "claude" && (
          <label>
            View
            <select
              value={view}
              onChange={(event) => setView(event.target.value)}
            >
              <option value="records">Recorded messages</option>
              <option value="conversation">Latest conversation branch</option>
            </select>
          </label>
        )}
        <button type="button" disabled={busy || ["grok-acp", "antigravity-jsonl"].includes(agent)} onClick={() => void discover()}>
          Find transcripts
        </button>
        {agent === "grok-acp" && (
          <p>
            Grok reads only an explicitly selected updates.jsonl file. Recorded
            chunks and tool snapshots remain separate; rewinds are not filtered
            into an active conversation branch.
          </p>
        )}
        {agent === "antigravity-jsonl" && <p>
          Antigravity reads only an explicitly selected JSONL file. Step records preserve literal source, type, status and compact truncation flags;
          repeated indices remain separate. This is not a reconstructed conversation. If the file is rewritten, open it again from the start.
        </p>}
        <label>
          Transcript path
          <input
            required
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="Absolute host path to session.jsonl"
          />
        </label>
        {["hermes", "opencode"].includes(agent) && (
          <label>
            Transcript session ID
            <input
              required
              maxLength={4096}
              value={transcriptSessionId}
              onChange={(event) => setTranscriptSessionId(event.target.value)}
            />
          </label>
        )}
        <button disabled={busy || !path.trim()} type="submit">
          Open transcript
        </button>
      </form>
      {discovered.length > 0 && (
        <label>
          Recent transcripts
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
            <option value="">Select a transcript</option>
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
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {opened && (
        <p>
          <code>{opened.path}</code> ·{" "}
          {opened.view === "conversation"
            ? "latest 50 messages from the selected branch"
            : opened.agent === "antigravity-jsonl" ? "showing up to 500 step records" : "showing up to 500 recorded messages"}
        </p>
      )}
      <div className="chat-messages">
        {messages.map((message) => (
          <article key={message.id} className="chat-message">
            <h4>{message.role}</h4>
            {message.record && <p>
              {message.record.stepIndex !== undefined ? `Step ${message.record.stepIndex} · ` : ""}
              Source: {message.record.source} · Type: {message.record.type} · Status: {message.record.status}
              {message.record.exitCode !== undefined && ` · Exit code: ${message.record.exitCode}`}
              {message.record.errorCode !== undefined && ` · Error code: ${message.record.errorCode}`}
              {message.record.truncatedFields.length > 0 && ` · Compact truncation: ${message.record.truncatedFields.join(", ")}`}
            </p>}
            {message.blocks.map((block, index) =>
              block.type === "text" ? (
                <Markdown
                  key={index}
                  components={{
                    img: () => <span>[Image — view in terminal]</span>,
                    a: ({ children }) => <span>{children}</span>,
                  }}
                >
                  {block.text || ""}
                </Markdown>
              ) : (
                <details key={index}>
                  <summary>
                    {block.name || block.type.replaceAll("_", " ")}
                  </summary>
                  <pre>
                    {block.text || "View this content in the terminal."}
                  </pre>
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
      {opened && (
        <button disabled={busy} onClick={() => void read(false)}>
          {busy
            ? "Reading…"
            : more
              ? "Load next messages"
              : "Refresh new messages"}
        </button>
      )}
      <form className="form-stack chat-composer" aria-label="Transcript draft" onSubmit={event => { event.preventDefault(); stageDraft(); }}>
        <label>Draft for this terminal<textarea rows={4} maxLength={65536} value={draft} onChange={event => { setDraft(event.target.value); setDraftStatus(""); }} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !event.nativeEvent.isComposing && !composing.current) { event.preventDefault(); stageDraft(); } }} /></label>
        <p>Stage the text, then verify the intended agent pane and paste it from the terminal composer. Permissions, plans, questions, and stop actions use the live terminal.</p>
        <div className="button-row"><button type="submit" disabled={!draft.trim() || draft.length > 65536}>Stage in terminal</button>{onOpenTerminal && <button type="button" onClick={onOpenTerminal}>Open terminal</button>}<button type="button" disabled={!draft} onClick={() => { setDraft(""); setDraftStatus(""); }}>Clear draft</button></div>
        {draftStatus && <p role="status">{draftStatus}</p>}
      </form>
    </section>
  );
}

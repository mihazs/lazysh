import { usageAgents as agents, isDiscoveredTranscript } from "./transcriptSources";
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "./SessionTools";
import type { RecordedProviderWindow, RecordedUsageContext } from "./bridge";
import "./UsagePanel.css";


type Sample = {
  id: string; recordedAt: string | null; freshness: "fresh" | "stale" | "unknown";
  inputTokens: number | null; outputTokens: number | null;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
};
export type AppleUsageReport = Omit<Sample, "id"> & { observedAt: string; receivedAt: number };
type Snapshot = {
  schemaVersion: 1; agent: string; scope: "transcript_window"; observedAt: string;
  nextOffset: number; hasMore: boolean; samplesAvailable: number; samples: Sample[];
  context: { usedTokens: null; limitTokens: null; remainingTokens: null };
  quota: { remaining: null; resetsAt: null };
  recordedContext?: RecordedUsageContext | null;
  providerWindows?: RecordedProviderWindow[];
};
type Source = { agent: string; path: string; transcriptSessionId?: string; offset: number };
type Discovered = { path: string; name: string; sessionId?: string };
const counters = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
function validTime(value: unknown): value is string {
  return typeof value === "string" && value.length <= 80 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function validCounter(value: unknown): boolean { return value === null || (Number.isSafeInteger(value) && Number(value) >= 0); }
function validRecorded(value: { recordedAt: string | null; freshness: string }): boolean {
  return ["fresh", "stale", "unknown"].includes(value.freshness) && (value.recordedAt === null ? value.freshness === "unknown" : validTime(value.recordedAt));
}
export function parseUsage(value: unknown): Snapshot {
  const data = value as Snapshot;
  if (!data || data.schemaVersion !== 1 || !Object.hasOwn(agents, data.agent) || data.scope !== "transcript_window" || !validTime(data.observedAt)
    || !Number.isSafeInteger(data.nextOffset) || data.nextOffset < 0 || typeof data.hasMore !== "boolean"
    || !Number.isSafeInteger(data.samplesAvailable) || data.samplesAvailable < 0 || data.samplesAvailable > 100
    || !Array.isArray(data.samples) || data.samples.length > 20 || data.samples.length > data.samplesAvailable
    || !data.context || Object.values(data.context).some(value => value !== null) || !["usedTokens", "limitTokens", "remainingTokens"].every(key => Object.hasOwn(data.context, key))
    || !data.quota || data.quota.remaining !== null || data.quota.resetsAt !== null) throw new Error("Unsupported usage response. Update the host companion.");
  const seen = new Set<string>();
  for (const sample of data.samples) {
    if (!sample || typeof sample.id !== "string" || !sample.id || sample.id.length > 4096 || seen.has(sample.id)
      || !["fresh", "stale", "unknown"].includes(sample.freshness)
      || (sample.recordedAt !== null && !validTime(sample.recordedAt))
      || (sample.recordedAt === null && sample.freshness !== "unknown")
      || counters.some(key => sample[key] !== null && (!Number.isSafeInteger(sample[key]) || Number(sample[key]) < 0))) throw new Error("Invalid recorded usage.");
    seen.add(sample.id);
  }
  if (data.recordedContext !== undefined && data.recordedContext !== null) {
    const context = data.recordedContext;
    if (data.agent !== "codex" || context.source !== "codex_token_count" || !validCounter(context.usedTokens) || !validCounter(context.limitTokens) || !validRecorded(context)) throw new Error("Invalid recorded context metadata.");
  }
  if (data.providerWindows !== undefined) {
    if (!Array.isArray(data.providerWindows) || data.providerWindows.length > 16) throw new Error("Invalid recorded provider windows.");
    const windows = new Set<string>();
    for (const window of data.providerWindows) {
      if (!window || data.agent !== "codex" || window.provider !== "codex" || window.accountId !== null || !["primary", "secondary"].includes(window.kind)
        || (window.limitId !== null && (typeof window.limitId !== "string" || !window.limitId || window.limitId.length > 128 || /[\u0000-\u001f\u007f]/.test(window.limitId)))
        || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
        || !validCounter(window.windowMinutes) || window.windowMinutes === 0 || (window.resetsAt !== null && !validTime(window.resetsAt)) || !validRecorded(window)) throw new Error("Invalid recorded provider window.");
      const key = JSON.stringify([window.limitId, window.kind]);
      if (windows.has(key)) throw new Error("Duplicate recorded provider window.");
      windows.add(key);
    }
  }
  return data;
}
export function sampleFreshness(sample: Pick<Sample, "recordedAt" | "freshness">, observedAt: string, elapsedMs: number): Sample["freshness"] {
  if (sample.freshness !== "fresh" || sample.recordedAt === null) return sample.freshness;
  const age = Date.parse(observedAt) - Date.parse(sample.recordedAt);
  if (age < 0) return "unknown";
  return age + Math.max(0, elapsedMs) > 15 * 60_000 ? "stale" : "fresh";
}
export function windowFreshness(window: RecordedProviderWindow, observedAt: string, elapsedMs: number): Sample["freshness"] {
  const freshness = sampleFreshness(window, observedAt, elapsedMs);
  return freshness === "fresh" && window.resetsAt !== null && Date.parse(window.resetsAt) <= Date.parse(observedAt) + Math.max(0, elapsedMs) ? "stale" : freshness;
}
const freshnessLabel = { fresh: "Recently recorded", stale: "Stale record", unknown: "Record freshness unknown" };
const count = (value: number | null) => value === null ? "Unknown" : value.toLocaleString();

export default function UsagePanel({ sessionId, onShareAppleUsage }: { sessionId: string; onShareAppleUsage?: (report: AppleUsageReport) => void }) {
  const invoke = useProtectedInvoke();
  const [agent, setAgent] = useState("claude");
  const [path, setPath] = useState("");
  const [transcriptSessionId, setTranscriptSessionId] = useState("");
  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [opened, setOpened] = useState<Source>();
  const [data, setData] = useState<Snapshot>();
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);
  useEffect(() => {
    request.current++; setPath(""); setTranscriptSessionId(""); setDiscovered([]); setOpened(undefined); setData(undefined); setError(""); setBusy(false);
    return () => { request.current++; };
  }, [sessionId]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  function clearSelection() { request.current++; setOpened(undefined); setData(undefined); setError(""); }
  async function findTranscripts() {
    const current = ++request.current; setBusy(true); setError(""); setDiscovered([]);
    try {
      const result = await invoke<{ schemaVersion: number; sessions: Discovered[] }>("agent_transcripts", { sessionId, agent });
      if (current !== request.current) return;
      if (result?.schemaVersion !== 1 || !Array.isArray(result.sessions) || result.sessions.length > 50 || result.sessions.some(item => !isDiscoveredTranscript(item, 256))) throw new Error("Invalid transcript list.");
      setDiscovered(result.sessions);
    } catch (e) { if (current === request.current) setError(errorMessage(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function read(source: Source) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const result = await invoke("agent_usage", { sessionId, ...source });
      if (current !== request.current) return;
      const snapshot = parseUsage(result);
      if (snapshot.agent !== source.agent || snapshot.nextOffset < source.offset || (snapshot.hasMore && snapshot.nextOffset === source.offset)) throw new Error("Transcript changed. Inspect it again from the start.");
      const received = Date.now(); setReceivedAt(received); setNow(received); setData(snapshot); setOpened(source);
    } catch (e) { if (current === request.current) setError(errorMessage(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  const latest = data?.samples.at(-1);
  return <section className="tool-panel usage-panel" aria-label="Recorded token usage">
    <div className="tool-bar"><h3>Recorded token usage</h3><button disabled={busy || !opened} onClick={() => opened && void read(opened)}>Refresh usage</button></div>
    <p className="agent-note">Inspect counters and available context or provider-window metadata recorded in a selected transcript. Reports do not establish live account state.</p>
    <form className="tool-bar" onSubmit={event => { event.preventDefault(); void read({ agent, path: path.trim(), offset: 0, ...(["hermes", "opencode"].includes(agent) ? { transcriptSessionId: transcriptSessionId.trim() } : {}) }); }}>
      <label>Usage agent<select value={agent} disabled={busy} onChange={event => { clearSelection(); setAgent(event.target.value); setDiscovered([]); setTranscriptSessionId(""); }}>{Object.entries(agents).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <button type="button" disabled={busy} onClick={() => void findTranscripts()}>Find usage transcripts</button>
      {discovered.length > 0 && <label>Choose usage transcript<select defaultValue="" disabled={busy} onChange={event => { const item = discovered[Number(event.target.value)]; if (!item) return; clearSelection(); setPath(item.path); setTranscriptSessionId(item.sessionId ?? ""); }}><option value="" disabled>Select a transcript</option>{discovered.map((item, index) => <option key={`${item.path}:${item.sessionId ?? ""}`} value={index}>{item.name}</option>)}</select></label>}
      <label>Usage transcript path<input required value={path} maxLength={4096} disabled={busy} onChange={event => { clearSelection(); setPath(event.target.value); }} placeholder="/host/session.jsonl" /></label>
      {["hermes", "opencode"].includes(agent) && <label>Usage transcript session ID<input required value={transcriptSessionId} maxLength={256} disabled={busy} onChange={event => { clearSelection(); setTranscriptSessionId(event.target.value); }} /></label>}
      <button disabled={busy || !path.trim()} type="submit">Inspect usage</button>
    </form>
    {busy && <p role="status">Reading recorded usage over SSH…</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {data && <>
      <p>Read on host <time dateTime={data.observedAt}>{new Date(data.observedAt).toLocaleString()}</time>. Showing the last {data.samples.length} of {data.samplesAvailable} usage reports in this inspected window.</p>
      <section aria-label="Latest report in inspected records"><h4>Latest report in inspected records</h4>
        <dl className="usage-values">{[["Input tokens", latest?.inputTokens ?? null], ["Output tokens", latest?.outputTokens ?? null], ["Cache read tokens", latest?.cacheReadTokens ?? null], ["Cache write tokens", latest?.cacheWriteTokens ?? null]].map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{count(value as number | null)}</dd></div>)}</dl>
        {latest && onShareAppleUsage && <button disabled={busy || counters.every(key=>latest[key]===null)} onClick={()=>onShareAppleUsage({inputTokens:latest.inputTokens,outputTokens:latest.outputTokens,cacheReadTokens:latest.cacheReadTokens,cacheWriteTokens:latest.cacheWriteTokens,recordedAt:latest.recordedAt,freshness:latest.freshness,observedAt:data.observedAt,receivedAt})}>Use latest report for Watch</button>}
      </section>
      {data.samples.length === 0 && <p>No token counters were recorded in this inspected window. Missing values remain unknown.</p>}
      <section aria-label="Context and provider limits"><h4>Context and provider limits</h4><dl className="usage-values"><div><dt>Context used</dt><dd>Unknown</dd></div><div><dt>Context remaining</dt><dd>Unknown</dd></div><div><dt>Context window</dt><dd>Unknown</dd></div><div><dt>Provider limit and reset</dt><dd>Unknown</dd></div></dl><p>Current context and provider limits haven’t been collected. Input counts do not establish remaining context.</p></section>
      {data.recordedContext && <section aria-label="Recorded context metadata"><h4>Last recorded response context</h4><dl className="usage-values"><div><dt>Recorded context tokens</dt><dd>{count(data.recordedContext.usedTokens)}</dd></div><div><dt>Recorded context window</dt><dd>{count(data.recordedContext.limitTokens)}</dd></div></dl><p>{freshnessLabel[sampleFreshness(data.recordedContext, data.observedAt, now - receivedAt)]}{data.recordedContext.recordedAt && <> · <time dateTime={data.recordedContext.recordedAt}>{new Date(data.recordedContext.recordedAt).toLocaleString()}</time></>}. Codex’s last response measurement can precede edits, compaction, or a model change. Live remaining context is unknown.</p></section>}
      {!!data.providerWindows?.length && <section className="usage-table" aria-label="Recorded provider windows"><h4>Recorded provider windows</h4><p>Account identity is unknown. Recording time does not prove when Codex fetched this cached provider snapshot. A reset passing does not establish a new allowance.</p><table><caption>Codex windows recorded in this inspected file window</caption><thead><tr><th>Limit</th><th>Used</th><th>Window</th><th>Reset</th><th>Recorded</th></tr></thead><tbody>{data.providerWindows.map(window => <tr key={JSON.stringify([window.limitId, window.kind])}><th scope="row">{window.limitId ?? "Unspecified limit"} · {window.kind}<small>{freshnessLabel[windowFreshness(window, data.observedAt, now - receivedAt)]}</small></th><td>{window.usedPercent.toLocaleString(undefined, { maximumFractionDigits: 2 })}%</td><td>{window.windowMinutes === null ? "Unknown" : `${window.windowMinutes.toLocaleString()} minutes`}</td><td>{window.resetsAt ? <time dateTime={window.resetsAt}>{new Date(window.resetsAt).toLocaleString()}</time> : "Unknown"}</td><td>{window.recordedAt ? <time dateTime={window.recordedAt}>{new Date(window.recordedAt).toLocaleString()}</time> : "Unknown"}</td></tr>)}</tbody></table></section>}
      {data.samples.length > 0 && <div className="usage-table"><table><caption>Recorded samples · no counters are added together</caption><thead><tr><th>Report</th><th>Recorded</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th></tr></thead><tbody>{data.samples.map(sample => <tr key={sample.id}><th scope="row"><code title={sample.id}>{sample.id.slice(0, 32)}</code><small>{({ fresh: "Fresh report", stale: "Stale report", unknown: "Freshness unknown" })[sampleFreshness(sample, data.observedAt, now - receivedAt)]}</small></th><td>{sample.recordedAt ? <time dateTime={sample.recordedAt}>{new Date(sample.recordedAt).toLocaleString()}</time> : "Unknown"}</td>{counters.map(key => <td key={key}>{count(sample[key])}</td>)}</tr>)}</tbody></table></div>}
      {data.hasMore && <p>Later records have not been inspected. <button disabled={busy || !opened} onClick={() => opened && void read({ ...opened, offset: data.nextOffset })}>Inspect next records</button></p>}
    </>}
  </section>;
}

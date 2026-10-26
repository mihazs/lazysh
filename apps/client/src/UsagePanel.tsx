import {t, useUi, formatNumber, formatDateTime} from './i18n/core';
import { usageAgents as agents, isDiscoveredTranscript } from "./transcriptSources";
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";

import {LocalUiError,captureUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
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
    || !data.quota || data.quota.remaining !== null || data.quota.resetsAt !== null) throw new LocalUiError('usageUnsupportedResponse');
  const seen = new Set<string>();
  for (const sample of data.samples) {
    if (!sample || typeof sample.id !== "string" || !sample.id || sample.id.length > 4096 || seen.has(sample.id)
      || !["fresh", "stale", "unknown"].includes(sample.freshness)
      || (sample.recordedAt !== null && !validTime(sample.recordedAt))
      || (sample.recordedAt === null && sample.freshness !== "unknown")
      || counters.some(key => sample[key] !== null && (!Number.isSafeInteger(sample[key]) || Number(sample[key]) < 0))) throw new LocalUiError('usageInvalidRecord');
    seen.add(sample.id);
  }
  if (data.recordedContext !== undefined && data.recordedContext !== null) {
    const context = data.recordedContext;
    if (data.agent !== "codex" || context.source !== "codex_token_count" || !validCounter(context.usedTokens) || !validCounter(context.limitTokens) || !validRecorded(context)) throw new LocalUiError('usageInvalidContext');
  }
  if (data.providerWindows !== undefined) {
    if (!Array.isArray(data.providerWindows) || data.providerWindows.length > 16) throw new LocalUiError('usageInvalidWindows');
    const windows = new Set<string>();
    for (const window of data.providerWindows) {
      if (!window || data.agent !== "codex" || window.provider !== "codex" || window.accountId !== null || !["primary", "secondary"].includes(window.kind)
        || (window.limitId !== null && (typeof window.limitId !== "string" || !window.limitId || window.limitId.length > 128 || /[\u0000-\u001f\u007f]/.test(window.limitId)))
        || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100
        || !validCounter(window.windowMinutes) || window.windowMinutes === 0 || (window.resetsAt !== null && !validTime(window.resetsAt)) || !validRecorded(window)) throw new LocalUiError('usageInvalidWindow');
      const key = JSON.stringify([window.limitId, window.kind]);
      if (windows.has(key)) throw new LocalUiError('usageDuplicateWindow');
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
const freshnessLabel = { fresh: "usageRecentlyRecorded", stale: "usageStaleRecord", unknown: "usageRecordFreshnessUnknown" } as const;
const count = (value: number | null) => value === null ? t("appUnknown") : formatNumber(value);
const counterLabels = {inputTokens:"usageInputTokens",outputTokens:"usageOutputTokens",cacheReadTokens:"usageCacheReadTokens",cacheWriteTokens:"usageCacheWriteTokens"} as const;

export default function UsagePanel({ sessionId, onShareAppleUsage }: { sessionId: string; onShareAppleUsage?: (report: AppleUsageReport) => void }) {
  useUi();
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
  const [error, setError] = useState<UiErrorCause>("");
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
      if (result?.schemaVersion !== 1 || !Array.isArray(result.sessions) || result.sessions.length > 50 || result.sessions.some(item => !isDiscoveredTranscript(item, 256))) throw new LocalUiError('panelInvalidTranscriptList');
      setDiscovered(result.sessions);
    } catch (e) { if (current === request.current) setError(captureUiError(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  async function read(source: Source) {
    const current = ++request.current; setBusy(true); setError("");
    try {
      const result = await invoke("agent_usage", { sessionId, ...source });
      if (current !== request.current) return;
      const snapshot = parseUsage(result);
      if (snapshot.agent !== source.agent || snapshot.nextOffset < source.offset || (snapshot.hasMore && snapshot.nextOffset === source.offset)) throw new LocalUiError('usageChanged');
      const received = Date.now(); setReceivedAt(received); setNow(received); setData(snapshot); setOpened(source);
    } catch (e) { if (current === request.current) setError(captureUiError(e)); }
    finally { if (current === request.current) setBusy(false); }
  }
  const latest = data?.samples.at(-1);
  return <section className="tool-panel usage-panel" aria-label={t("usageTitle")}>
    <div className="tool-bar"><h3>{t("usageTitle")}</h3><button disabled={busy || !opened} onClick={() => opened && void read(opened)}>{t("usageRefresh")}</button></div>
    <p className="agent-note">{t("usageExplanation")}</p>
    <form className="tool-bar" onSubmit={event => { event.preventDefault(); void read({ agent, path: path.trim(), offset: 0, ...(["hermes", "opencode"].includes(agent) ? { transcriptSessionId: transcriptSessionId.trim() } : {}) }); }}>
      <label>{t("usageAgent")}<select value={agent} disabled={busy} onChange={event => { clearSelection(); setAgent(event.target.value); setDiscovered([]); setTranscriptSessionId(""); }}>{Object.entries(agents).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <button type="button" disabled={busy} onClick={() => void findTranscripts()}>{t("usageFind")}</button>
      {discovered.length > 0 && <label>{t("usageChoose")}<select defaultValue="" disabled={busy} onChange={event => { const item = discovered[Number(event.target.value)]; if (!item) return; clearSelection(); setPath(item.path); setTranscriptSessionId(item.sessionId ?? ""); }}><option value="" disabled>{t("chatSelect")}</option>{discovered.map((item, index) => <option key={`${item.path}:${item.sessionId ?? ""}`} value={index}>{item.name}</option>)}</select></label>}
      <label>{t("usagePath")}<input required value={path} maxLength={4096} disabled={busy} onChange={event => { clearSelection(); setPath(event.target.value); }} placeholder="/host/session.jsonl" /></label>
      {["hermes", "opencode"].includes(agent) && <label>{t("usageSessionId")}<input required value={transcriptSessionId} maxLength={256} disabled={busy} onChange={event => { clearSelection(); setTranscriptSessionId(event.target.value); }} /></label>}
      <button disabled={busy || !path.trim()} type="submit">{t("usageInspect")}</button>
    </form>
    {busy && <p role="status">{t("usageReading")}</p>}
    {error && <p className="inline-error" role="alert">{uiErrorText(error)}</p>}
    {data && <>
      <p><time dateTime={data.observedAt}>{t("usageObservedAt", {time:formatDateTime(new Date(data.observedAt))})}</time>{" "}{t("usageSummary", {shown:formatNumber(data.samples.length),available:formatNumber(data.samplesAvailable)})}</p>
      <section aria-label={t("usageLatest")}><h4>{t("usageLatest")}</h4>
        <dl className="usage-values">{counters.map(key => <div key={key}><dt>{t(counterLabels[key])}</dt><dd>{count(latest?.[key] ?? null)}</dd></div>)}</dl>
        {latest && onShareAppleUsage && <button disabled={busy || counters.every(key=>latest[key]===null)} onClick={()=>onShareAppleUsage({inputTokens:latest.inputTokens,outputTokens:latest.outputTokens,cacheReadTokens:latest.cacheReadTokens,cacheWriteTokens:latest.cacheWriteTokens,recordedAt:latest.recordedAt,freshness:latest.freshness,observedAt:data.observedAt,receivedAt})}>{t("usageShareWatch")}</button>}
      </section>
      {data.samples.length === 0 && <p>{t("usageNoCounters")}</p>}
      <section aria-label={t("usageContextLimits")}><h4>{t("usageContextLimits")}</h4><dl className="usage-values"><div><dt>{t("usageContextUsed")}</dt><dd>{t("appUnknown")}</dd></div><div><dt>{t("usageContextRemaining")}</dt><dd>{t("appUnknown")}</dd></div><div><dt>{t("usageContextWindow")}</dt><dd>{t("appUnknown")}</dd></div><div><dt>{t("usageProviderLimitReset")}</dt><dd>{t("appUnknown")}</dd></div></dl><p>{t("usageLiveLimitsUnknown")}</p></section>
      {data.recordedContext && <section aria-label={t("usageRecordedContext")}><h4>{t("usageLastResponseContext")}</h4><dl className="usage-values"><div><dt>{t("usageRecordedContextTokens")}</dt><dd>{count(data.recordedContext.usedTokens)}</dd></div><div><dt>{t("usageRecordedContextWindow")}</dt><dd>{count(data.recordedContext.limitTokens)}</dd></div></dl><p>{t(freshnessLabel[sampleFreshness(data.recordedContext, data.observedAt, now - receivedAt)])}{data.recordedContext.recordedAt && <> · <time dateTime={data.recordedContext.recordedAt}>{formatDateTime(new Date(data.recordedContext.recordedAt))}</time></>}.{" "}{t("usageContextExplanation")}</p></section>}
      {!!data.providerWindows?.length && <section className="usage-table" aria-label={t("usageProviderWindows")}><h4>{t("usageProviderWindows")}</h4><p>{t("usageProviderExplanation")}</p><table><caption>{t("usageCodexWindows")}</caption><thead><tr><th>{t("usageLimit")}</th><th>{t("usageUsed")}</th><th>{t("usageWindow")}</th><th>{t("usageReset")}</th><th>{t("usageRecorded")}</th></tr></thead><tbody>{data.providerWindows.map(window => <tr key={JSON.stringify([window.limitId, window.kind])}><th scope="row">{window.limitId ?? t("usageUnspecifiedLimit")} · {window.kind}<small>{t(freshnessLabel[windowFreshness(window, data.observedAt, now - receivedAt)])}</small></th><td>{formatNumber(window.usedPercent / 100, {style:"percent",maximumFractionDigits:2})}</td><td>{window.windowMinutes === null ? t("appUnknown") : t("usageMinutes", {minutes:formatNumber(window.windowMinutes),count:window.windowMinutes})}</td><td>{window.resetsAt ? <time dateTime={window.resetsAt}>{formatDateTime(new Date(window.resetsAt))}</time> : t("appUnknown")}</td><td>{window.recordedAt ? <time dateTime={window.recordedAt}>{formatDateTime(new Date(window.recordedAt))}</time> : t("appUnknown")}</td></tr>)}</tbody></table></section>}
      {data.samples.length > 0 && <div className="usage-table"><table><caption>{t("usageSamplesCaption")}</caption><thead><tr><th>{t("usageReport")}</th><th>{t("usageRecorded")}</th><th>{t("usageInput")}</th><th>{t("usageOutput")}</th><th>{t("usageCacheRead")}</th><th>{t("usageCacheWrite")}</th></tr></thead><tbody>{data.samples.map(sample => <tr key={sample.id}><th scope="row"><code title={sample.id}>{sample.id.slice(0, 32)}</code><small>{t(({ fresh: "usageFreshReport", stale: "usageStaleReport", unknown: "usageFreshnessUnknown" } as const)[sampleFreshness(sample, data.observedAt, now - receivedAt)])}</small></th><td>{sample.recordedAt ? <time dateTime={sample.recordedAt}>{formatDateTime(new Date(sample.recordedAt))}</time> : t("appUnknown")}</td>{counters.map(key => <td key={key}>{count(sample[key])}</td>)}</tr>)}</tbody></table></div>}
      {data.hasMore && <p>{t("usageLaterRecords")}{" "}<button disabled={busy || !opened} onClick={() => opened && void read({ ...opened, offset: data.nextOffset })}>{t("usageNext")}</button></p>}
    </>}
  </section>;
}

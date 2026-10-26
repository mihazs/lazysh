import {t, useUi, formatDateTime} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";


type Approval = {
  id: string;
  expectedHash: string;
  agent: string;
  sessionId: string;
  project: string;
  paneId: string | null;
  toolName: string;
  toolInput: unknown;
  createdAt: string;
  expiresAt: string;
};
export function parseApprovals(value: unknown): Approval[] {
  if (
    !value ||
    typeof value !== "object" ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("requests" in value) ||
    !Array.isArray(value.requests) ||
    value.requests.length > 20
  )
    throw new LocalUiError('approvalsUnsupported');
  return value.requests.map((item) => {
    if (!item || typeof item !== "object") throw new LocalUiError('approvalsInvalid');
    for (const key of [
      "id",
      "agent",
      "sessionId",
      "project",
      "toolName",
      "createdAt",
      "expiresAt",
    ])
      if (typeof item[key] !== "string" || item[key].length > 4096)
        throw new LocalUiError('approvalsInvalidContext');
    if (
      !/^[\da-f-]{36}$/i.test(item.id) ||
      !/^[\da-f]{64}$/i.test(item.expectedHash) ||
      (item.paneId !== null && !/^%\d{1,30}$/.test(item.paneId)) ||
      !Number.isFinite(Date.parse(item.expiresAt)) ||
      JSON.stringify(item.toolInput ?? null).length > 32768
    )
      throw new LocalUiError('approvalsInvalidIdentity');
    return item as Approval;
  });
}
export default function ApprovalPanel({ sessionId }: { sessionId: string }) {
  useUi();
  const invoke = useProtectedInvoke();
  const [requests, setRequests] = useState<Approval[]>([]);
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  async function refresh() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const current = generation.current;
    try {
      const rows = parseApprovals(
        await invoke("agent_approvals", { sessionId }),
      );
      if (current === generation.current) setRequests(rows);
    } catch (e) {
      if (current === generation.current) setError(captureUiError(e));
    } finally {
      if (current === generation.current) {
        setBusy(false);
        running.current = false;
      }
    }
  }
  useEffect(() => {
    generation.current++;
    running.current = false;
    setRequests([]);
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      generation.current++;
      window.clearInterval(interval);
    };
  }, [sessionId]);
  async function decide(request: Approval, decision: "allow" | "deny") {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    const current = generation.current;
    try {
      const result = await invoke<{ schemaVersion: number; accepted: boolean }>(
        "resolve_agent_approval",
        {
          sessionId,
          id: request.id,
          expectedHash: request.expectedHash,
          agentSessionId: request.sessionId,
          paneId: request.paneId,
          decision,
        },
      );
      if (result?.schemaVersion !== 1 || result.accepted !== true)
        throw new LocalUiError('approvalsNotAccepted');
      if (current === generation.current)
        setRequests((previous) =>
          previous.filter((item) => item.id !== request.id),
        );
    } catch (e) {
      if (current === generation.current) setError(captureUiError(e));
    } finally {
      if (current === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-label={t('approvalsTitle')} className="approval-panel">
      <div className="tool-bar">
        <h3>{t('approvalsTitle')}</h3>
        <button disabled={busy} onClick={() => void refresh()}>
          {t('approvalsRefresh')}
        </button>
      </div>
      <p>
        {t('approvalsHint')}
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {uiErrorText(error)}
        </p>
      )}
      {requests.map((request) => (
        <article className="chat-message" key={request.id}>
          <h4>
            {request.agent} · {request.toolName}
          </h4>
          <p>
            {request.paneId?t('approvalsPaneContext',{project:request.project,session:request.sessionId,pane:request.paneId}):t('approvalsContext',{project:request.project,session:request.sessionId})}
          </p>
          <pre>{JSON.stringify(request.toolInput, null, 2)}</pre>
          <p><time dateTime={request.expiresAt}>{t('approvalsExpires',{time:formatDateTime(new Date(request.expiresAt))})}</time></p>
          <button
            disabled={busy || Date.parse(request.expiresAt) <= Date.now()}
            onClick={() => void decide(request, "deny")}
          >
            {t('approvalsDeny')}
          </button>
          <button
            disabled={busy || Date.parse(request.expiresAt) <= Date.now()}
            onClick={() => void decide(request, "allow")}
          >
            {t('approvalsAllow')}
          </button>
        </article>
      ))}
    </section>
  );
}

import {t, useUi, formatDateTime, formatNumber} from './i18n/core';
import { Check, Clock, RefreshCw, ShieldAlert, X } from 'lucide-react';
import { formatCountdown, formatRelativeTime, pathBasename, useNow } from './relativeTime';
import './ApprovalPanel.css';
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
export default function ApprovalPanel({ sessionId, visible=true, compactEmpty=false }: { sessionId: string; visible?:boolean; compactEmpty?:boolean }) {
  useUi();
  const invoke = useProtectedInvoke();
  const [requests, setRequests] = useState<Approval[]>([]);
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const running = useRef(false);
  const scope=useRef({sessionId,visible});scope.current={sessionId,visible};
  const owns=(current:number)=>current===generation.current && scope.current.visible && scope.current.sessionId===sessionId;
  function beginRequest() {
    if (running.current || !scope.current.visible || scope.current.sessionId!==sessionId) return null;
    running.current=true;setBusy(true);setError('');
    return generation.current;
  }
  async function refresh() {
    const current=beginRequest();if(current===null)return;
    try {
      const rows = parseApprovals(
        await invoke("agent_approvals", { sessionId }),
      );
      if (owns(current)) setRequests(rows);
    } catch (e) {
      if (owns(current)) setError(captureUiError(e));
    } finally {
      if (owns(current)) {
        setBusy(false);
        running.current = false;
      }
    }
  }
  useEffect(() => {
    generation.current++;
    running.current = false;
    setRequests([]);setBusy(false);setError("");
    if(!visible)return ()=>{generation.current++;};
    void refresh();
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 10000);
    return () => {
      generation.current++;
      window.clearInterval(interval);
    };
  }, [sessionId,visible]);
  async function decide(request: Approval, decision: "allow" | "deny") {
    const current=beginRequest();if(current===null)return;
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
      if (owns(current))
        setRequests((previous) =>
          previous.filter((item) => item.id !== request.id),
        );
    } catch (e) {
      if (owns(current)) setError(captureUiError(e));
    } finally {
      if (owns(current)) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  const now=useNow(1000,visible && requests.length>0);
  if(compactEmpty && requests.length===0 && !error)return null;
  return (
    <section hidden={!visible} style={visible?undefined:{display:'none'}} aria-label={t('approvalsTitle')} className="approval-panel">
      <div className="approval-header">
        <h3>{t('approvalsTitle')}{requests.length>0 && <span className="approval-count">{formatNumber(requests.length)}</span>}</h3>
        <button type="button" className="icon-button" aria-label={t('approvalsRefresh')} title={t('approvalsRefresh')} disabled={busy || !visible} onClick={() => void refresh()}>
          <RefreshCw size={16} aria-hidden="true" />
        </button>
      </div>
      <p className="approval-hint">
        {t('approvalsHint')}
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {uiErrorText(error)}
        </p>
      )}
      {requests.map((request) => {
        const expires=Date.parse(request.expiresAt);
        const expired=expires<=Math.max(now,Date.now());
        const titleId=`approval-${request.id}`;
        return (
        <article className="approval-card" key={request.id} aria-labelledby={titleId} data-expired={expired?'true':undefined}>
          <header className="approval-identity">
            <span className="approval-mark" aria-hidden="true"><ShieldAlert size={18} /></span>
            <div className="approval-heading">
              <h4 id={titleId}>{request.agent} · {request.toolName}</h4>
              <p className="approval-origin">
                <span>{pathBasename(request.project)}</span>
                <time dateTime={request.createdAt} title={formatDateTime(new Date(request.createdAt))}>{formatRelativeTime(request.createdAt,now)}</time>
              </p>
            </div>
            <span className="approval-kind">{t('approvalsPermission')}</span>
          </header>
          <pre className="approval-input">{JSON.stringify(request.toolInput, null, 2)}</pre>
          <p className="approval-expiry">
            <Clock size={14} aria-hidden="true" />
            <time dateTime={request.expiresAt} title={t('approvalsExpires',{time:formatDateTime(new Date(expires))})}>
              {expired?t('approvalsExpired'):t('approvalsExpiresIn',{time:formatCountdown(expires-now)})}
            </time>
          </p>
          <div className="approval-actions">
            <button type="button" className="approval-deny" disabled={!visible || busy || expired} onClick={() => void decide(request, "deny")}>
              <X size={16} aria-hidden="true" />{t('approvalsDeny')}
            </button>
            <button type="button" className="approval-allow" disabled={!visible || busy || expired} onClick={() => void decide(request, "allow")}>
              <Check size={16} aria-hidden="true" />{t('approvalsAllow')}
            </button>
          </div>
          <dl className="approval-facts">
            <div><dt>{t('approvalsProjectLabel')}</dt><dd>{request.project}</dd></div>
            <div><dt>{t('approvalsSessionLabel')}</dt><dd>{request.sessionId}</dd></div>
            {request.paneId && <div><dt>{t('approvalsPaneLabel')}</dt><dd>{request.paneId}</dd></div>}
          </dl>
        </article>
        );
      })}
    </section>
  );
}

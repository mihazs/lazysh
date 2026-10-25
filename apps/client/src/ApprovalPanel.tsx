import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from "react";

import { errorMessage } from "./SessionTools";

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
    throw new Error("Unsupported approval response.");
  return value.requests.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid approval.");
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
        throw new Error("Invalid approval context.");
    if (
      !/^[\da-f-]{36}$/i.test(item.id) ||
      !/^[\da-f]{64}$/i.test(item.expectedHash) ||
      (item.paneId !== null && !/^%\d{1,30}$/.test(item.paneId)) ||
      !Number.isFinite(Date.parse(item.expiresAt)) ||
      JSON.stringify(item.toolInput ?? null).length > 32768
    )
      throw new Error("Invalid approval identity.");
    return item as Approval;
  });
}
export default function ApprovalPanel({ sessionId }: { sessionId: string }) {
  const invoke = useProtectedInvoke();
  const [requests, setRequests] = useState<Approval[]>([]);
  const [error, setError] = useState("");
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
      if (current === generation.current) setError(errorMessage(e));
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
        throw new Error(
          "The host did not accept this decision. Refresh its current request.",
        );
      if (current === generation.current)
        setRequests((previous) =>
          previous.filter((item) => item.id !== request.id),
        );
    } catch (e) {
      if (current === generation.current) setError(errorMessage(e));
    } finally {
      if (current === generation.current) {
        running.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section aria-label="Pending approvals" className="approval-panel">
      <div className="tool-bar">
        <h3>Pending approvals</h3>
        <button disabled={busy} onClick={() => void refresh()}>
          Refresh approvals
        </button>
      </div>
      <p>
        Only requests from a waiting lazysh approval hook can be answered here.
        Other agent prompts stay in the terminal.
      </p>
      {error && (
        <p role="alert" className="inline-error">
          {error}
        </p>
      )}
      {requests.map((request) => (
        <article className="chat-message" key={request.id}>
          <h4>
            {request.agent} · {request.toolName}
          </h4>
          <p>
            {request.project} · session <code>{request.sessionId}</code>
            {request.paneId && (
              <>
                {" "}
                · pane <code>{request.paneId}</code>
              </>
            )}
          </p>
          <pre>{JSON.stringify(request.toolInput, null, 2)}</pre>
          <p>Expires {new Date(request.expiresAt).toLocaleString()}</p>
          <button
            disabled={busy || Date.parse(request.expiresAt) <= Date.now()}
            onClick={() => void decide(request, "deny")}
          >
            Deny request
          </button>
          <button
            disabled={busy || Date.parse(request.expiresAt) <= Date.now()}
            onClick={() => void decide(request, "allow")}
          >
            Allow this request
          </button>
        </article>
      ))}
    </section>
  );
}

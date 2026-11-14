import ApprovalPanel from './ApprovalPanel';
import {parseSnapshot, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot} from './ChatTerminalInput';
import {herdrStillRuns, type HerdrAgentTarget} from './agentHerdrAnswer';
import type {AccessLease, bindProtectedInvoke} from './access';

/** Answers the Claude permission requests of the agent in this terminal's pane (tmux), or of the followed agent of a Herdr pane, where the Agent view shows them.
 * A decision is sent only if the pane still runs the same session; it is the hook decision of the approvals store, no key reaches the terminal. */
export default function AgentApprovalDock({sessionId, shown, row, herdr, access, invoke}: {
  sessionId: string; shown: boolean; row?: AgentSession; herdr?: HerdrAgentTarget; access: AccessLease; invoke: ReturnType<typeof bindProtectedInvoke>;
}) {
  // Under Herdr the hook has no tmux pane: the session id the request names is the identity, and Herdr's own tree names the pane.
  const match = herdr ? {agentSessionId: herdr.agentSessionId} : row?.agent === 'Claude Code' && row.paneId ? {agentSessionId: row.sessionId, paneId: row.paneId} : undefined;
  if (!match) return null;
  async function validate() {
    if (!shown || !access.current()) return false;
    if (herdr) return await herdrStillRuns(invoke, sessionId, herdr) && access.current();
    const pane = parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId;
    if (pane !== match!.paneId) return false;
    const rows = parseSnapshot(await invoke('agent_snapshot', {sessionId})).filter(item => item.paneId === pane);
    return rows.length === 1 && rows[0].agent === 'Claude Code' && rows[0].sessionId === match!.agentSessionId && access.current();
  }
  return <ApprovalPanel key={`${match.agentSessionId}:${match.paneId}`} sessionId={sessionId} visible={shown} compactEmpty match={match} validate={validate} delay={400} />;
}

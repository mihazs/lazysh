import ApprovalPanel from './ApprovalPanel';
import {parseSnapshot, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot} from './ChatTerminalInput';
import {zellijPane} from './agentPaneIdentity';
import type {AccessLease, bindProtectedInvoke} from './access';

/** Answers the Claude permission requests of the agent in this terminal's pane, where the Agent view shows them.
 * The pane is the one tmux shows or, in a Zellij session (`zellijSession`), the one report that names a pane of it.
 * A decision is sent only if the pane still runs the same reported session; it is the hook decision of the approvals store, no key reaches the terminal. */
export default function AgentApprovalDock({sessionId, shown, row, zellijSession, access, invoke}: {
  sessionId: string; shown: boolean; row?: AgentSession; zellijSession?: string; access: AccessLease; invoke: ReturnType<typeof bindProtectedInvoke>;
}) {
  // In Zellij only a pane of the attached session can be this terminal's; any other id belongs to another terminal.
  const match = row?.agent === 'Claude Code' && row.paneId && (!zellijSession || zellijPane(row.paneId)?.session === zellijSession) ? {agentSessionId: row.sessionId, paneId: row.paneId} : undefined;
  if (!match) return null;
  async function validate() {
    if (!shown || !access.current()) return false;
    // Zellij has no read of the pane a terminal shows, so its reports are the only evidence, as for the composer.
    const pane = zellijSession ? match!.paneId : parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId;
    if (pane !== match!.paneId) return false;
    const reports = parseSnapshot(await invoke('agent_snapshot', {sessionId}));
    const rows = reports.filter(item => zellijSession ? zellijPane(item.paneId)?.session === zellijSession : item.paneId === pane);
    return rows.length === 1 && rows[0].paneId === pane && rows[0].agent === 'Claude Code' && rows[0].sessionId === match!.agentSessionId && access.current();
  }
  return <ApprovalPanel key={`${match.agentSessionId}:${match.paneId}`} sessionId={sessionId} visible={shown} compactEmpty match={match} validate={validate} delay={400} />;
}

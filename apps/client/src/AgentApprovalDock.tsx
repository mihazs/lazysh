import ApprovalPanel from './ApprovalPanel';
import {parseSnapshot, type AgentSession} from './AgentPanel';
import {parseTerminalSnapshot} from './ChatTerminalInput';
import {herdrStillRuns, type HerdrAgentTarget} from './agentHerdrAnswer';
import {herdrPaneIdentity, zellijPane} from './agentPaneIdentity';
import type {AccessLease, bindProtectedInvoke} from './access';

/** Answers the Claude Code and Codex permission requests of the agent in this terminal's pane (tmux), of the followed agent of a Herdr pane, or of the one agent report that names a pane of the attached Zellij session, where the Agent view shows them.
 * A decision is sent only if the pane still runs the same reported session; it is the hook decision of the approvals store, no key reaches the terminal. */
export default function AgentApprovalDock({sessionId, shown, row, zellijSession, herdr, access, invoke}: {
  sessionId: string; shown: boolean; row?: AgentSession; zellijSession?: string; herdr?: HerdrAgentTarget; access: AccessLease; invoke: ReturnType<typeof bindProtectedInvoke>;
}) {
  const reported = row?.agent;
  const agent: 'claude' | 'codex' | undefined = reported === 'Claude Code' ? 'claude' : reported === 'Codex' ? 'codex' : undefined;
  // Under Herdr a request names `herdr:<session>:<pane id>`: only the focused pane of the attached server answers it. A request that names no pane (an older companion) matches by session id alone.
  // In Zellij only a pane of the attached session can be this terminal's; any other id belongs to another terminal.
  const match: {agent: 'claude' | 'codex'; agentSessionId: string; paneId: string; unnamed?: boolean} | undefined = herdr ? {agent: herdr.agent, agentSessionId: herdr.agentSessionId, paneId: herdrPaneIdentity(herdr.server, herdr.pane), unnamed: true}
    : agent && row?.paneId && (!zellijSession || zellijPane(row.paneId)?.session === zellijSession) ? {agent, agentSessionId: row.sessionId, paneId: row.paneId} : undefined;
  if (!match) return null;
  async function validate() {
    if (!shown || !access.current()) return false;
    if (herdr) return await herdrStillRuns(invoke, sessionId, herdr, true) && access.current();
    // Zellij has no read of the pane a terminal shows, so its reports are the only evidence, as for the composer.
    const pane = zellijSession ? match!.paneId : parseTerminalSnapshot(await invoke('tmux_chat', {sessionId, action: {kind: 'snapshot'}})).destination.paneId;
    if (pane !== match!.paneId) return false;
    const rows = parseSnapshot(await invoke('agent_snapshot', {sessionId})).filter(item => zellijSession ? zellijPane(item.paneId)?.session === zellijSession : item.paneId === pane);
    return rows.length === 1 && rows[0].paneId === pane && rows[0].agent === reported && rows[0].sessionId === match!.agentSessionId && access.current();
  }
  return <ApprovalPanel key={`${match.agent}:${match.agentSessionId}:${match.paneId}`} sessionId={sessionId} visible={shown} compactEmpty match={match} validate={validate} delay={400} />;
}

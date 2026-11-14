import {parseReportedHistory} from './AgentPanel';
import {isDiscoveredTranscript} from './transcriptSources';
import type {bindProtectedInvoke} from './access';

type Invoke = ReturnType<typeof bindProtectedInvoke>;
/** Where a reported agent session's conversation is read from. `paneId` is what the host recorded the session against, when it did.
 * `reference` marks `path` as the companion's opaque reference, which the host resolves: the host path never reaches this app. */
export type ConversationSource = Readonly<{path: string; transcriptSessionId?: string; paneId?: string | null; reference?: true}>;

/** The agents whose conversation the Agent view reads, by the name their hook reports use. */
export const conversationAgents = {'Claude Code': 'claude', Codex: 'codex', OpenCode: 'opencode'} as const;
export type ConversationAgent = (typeof conversationAgents)[keyof typeof conversationAgents];

/** Claude Code and Codex report the transcript file with their first hook, and the companion hands this app a reference to it
 * instead of the file's path; OpenCode keeps every session in one database, so its source is that file plus the session id
 * the hook reported, found in the companion's own discovery of it. */
export async function conversationSource(invoke: Invoke, sessionId: string, agent: ConversationAgent, reportedId: string): Promise<ConversationSource | undefined> {
  if (agent === 'opencode') {
    const sessions = ((await invoke<{sessions?: unknown}>('agent_transcripts', {sessionId, agent}))?.sessions ?? []) as unknown[];
    const found = Array.isArray(sessions) ? sessions.find(item => isDiscoveredTranscript(item, 256) && item.sessionId === reportedId) : undefined;
    return found ? {path: (found as {path: string}).path, transcriptSessionId: reportedId} : undefined;
  }
  const history = parseReportedHistory(await invoke('agent_reported_history_reference', {sessionId, agentSessionId: reportedId}), reportedId, 'reference');
  return history.status === 'available' ? {path: history.reference, reference: true, paneId: history.paneId} : undefined;
}

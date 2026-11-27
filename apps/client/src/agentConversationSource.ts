import {parseReportedHistory} from './AgentPanel';
import {isDiscoveredTranscript} from './transcriptSources';
import type {bindProtectedInvoke} from './access';

type Invoke = ReturnType<typeof bindProtectedInvoke>;
/** Where a reported agent session's conversation is read from. `paneId` is what the host recorded the session against, when it did.
 * `reference` marks `path` as the companion's opaque reference, which the host resolves: the host path never reaches this app. */
export type ConversationSource = Readonly<{path: string; transcriptSessionId?: string; paneId?: string | null; reference?: true}>;

/** The agents whose conversation the Agent view reads, by the name their hook reports use. Grok Build's session log is the `grok-acp` reader. */
export const conversationAgents = {'Claude Code': 'claude', Codex: 'codex', OpenCode: 'opencode', 'Gemini CLI': 'gemini', 'Grok Build': 'grok-acp'} as const;
export type ConversationAgent = (typeof conversationAgents)[keyof typeof conversationAgents];
/** Records-only adapters whose records name the session (the session's directory or its UUID file name), by the name their hook reports use.
 * Their records are shown read-only and labelled partial. A records-only adapter missing here has no id to tie a report to its records. */
export const recordsAgents = {'GitHub Copilot CLI': 'copilot', 'Kimi CLI': 'kimi', Droid: 'droid'} as const;
export type RecordsAgent = (typeof recordsAgents)[keyof typeof recordsAgents];
const discoveredAgents: readonly string[] = ['opencode', ...Object.values(recordsAgents)];
export const isRecordsAgent = (agent: string): agent is RecordsAgent => (Object.values(recordsAgents) as string[]).includes(agent);

/** Claude Code, Codex, Gemini CLI and Grok Build report the transcript file with their hooks, and the companion hands this app a
 * reference to it instead of the file's path; OpenCode keeps every session in one database, so its source is that file plus the
 * session id the hook reported, found in the companion's own discovery of it.
 * The records-only adapters are found the same way: the discovery names the session where the path carries its id. */
export async function conversationSource(invoke: Invoke, sessionId: string, agent: ConversationAgent | RecordsAgent, reportedId: string): Promise<ConversationSource | undefined> {
  if (discoveredAgents.includes(agent)) {
    const sessions = ((await invoke<{sessions?: unknown}>('agent_transcripts', {sessionId, agent}))?.sessions ?? []) as unknown[];
    // Two records that claim the same id cannot both be this session's: none is shown.
    const found = Array.isArray(sessions) ? sessions.filter(item => isDiscoveredTranscript(item, 256) && item.sessionId === reportedId) as {path: string}[] : [];
    if (found.length !== 1) return undefined;
    // Only the database agent needs the id again to pick its session out of the one file.
    return agent === 'opencode' ? {path: found[0].path, transcriptSessionId: reportedId} : {path: found[0].path};
  }
  const history = parseReportedHistory(await invoke('agent_reported_history_reference', {sessionId, agentSessionId: reportedId}), reportedId, 'reference');
  return history.status === 'available' ? {path: history.reference, reference: true, paneId: history.paneId} : undefined;
}

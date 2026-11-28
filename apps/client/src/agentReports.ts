import {LocalUiError} from './i18n/localError';

export type AgentState = 'working' | 'needs_attention' | 'done';
export type AgentSession = {
  sessionId: string;
  agent: string;
  project: string;
  state: AgentState;
  updatedAt: string;
  summary: string;
  paneId: string | null;
  /** The tmux or rmux server `paneId` belongs to, as `tmux:<label>` or `rmux:<label>`; from a companion that records it. */
  paneServer?: string;
  eventCount: number;
  /** What a needs-attention report waits for, and since when; from a companion that records it. */
  waiting?: 'approval' | 'question' | 'plan' | 'menu' | 'unknown';
  waitingSince?: string;
  /** What the session is about (its first prompt, or the agent's own title), from a companion that reports it; or the name the user gave it. */
  title?: string;
};
export const maxTitle = 80;
/** One line without control characters, at most `maxTitle` characters; `undefined` when nothing is left. */
export function cleanTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().replace(/\s+/g, ' ');
  const characters = [...line];
  return characters.length === 0 ? undefined : characters.length > maxTitle ? `${characters.slice(0, maxTitle - 1).join('')}\u2026` : line;
}
/** How a session is named for a screen reader: its name, then its agent. */
export const reportLabel = (row: Pick<AgentSession, 'agent' | 'title'>) => row.title ? `${row.title} (${row.agent})` : row.agent;
export const states: AgentState[] = ['needs_attention', 'working', 'done'];
export function reportKey(row:Pick<AgentSession,'agent'|'sessionId'>) {return JSON.stringify([row.agent,row.sessionId]);}
export const reportedStateNames = {needs_attention:'agentsNeedsYou',working:'agentsWorking',done:'agentsDone'} as const;
/** Groups reports by project, most recently reported project first. */
export function projectGroups(rows:AgentSession[]) {
  const groups=new Map<string,AgentSession[]>();
  for(const row of rows) {const group=groups.get(row.project);if(group)group.push(row);else groups.set(row.project,[row]);}
  return [...groups];
}

export function parseSnapshot(value: unknown): AgentSession[] {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1 || !('sessions' in value) || !Array.isArray(value.sessions) || value.sessions.length > 100) {
    throw new LocalUiError('agentsUnsupportedSnapshot');
  }
  return value.sessions.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new LocalUiError('agentsInvalidSession');
    const row = item as Record<string, unknown>;
    for (const key of ['sessionId', 'agent', 'project', 'updatedAt', 'summary']) {
      if (typeof row[key] !== 'string' || row[key].length > 4096) throw new LocalUiError('agentsInvalidSession');
    }
    if (!states.includes(row.state as AgentState) || !Number.isFinite(Date.parse(row.updatedAt as string)) || !Number.isSafeInteger(row.eventCount) || Number(row.eventCount) < 1 || (row.paneId !== null && typeof row.paneId !== 'string')) {
      throw new LocalUiError('agentsInvalidSession');
    }
    if ((row.paneServer !== undefined && (typeof row.paneServer !== 'string' || row.paneServer.length > 256))
      || (row.waiting !== undefined && !['approval', 'question', 'plan', 'menu', 'unknown'].includes(row.waiting as string))
      || (row.waitingSince !== undefined && (typeof row.waitingSince !== 'string' || !Number.isFinite(Date.parse(row.waitingSince))))) throw new LocalUiError('agentsInvalidSession');
    // A title is a convenience: an unusable one is dropped, never a reason to reject the report.
    const {title, ...report} = row;
    const clean = cleanTitle(title);
    return (clean === undefined ? report : {...report, title: clean}) as AgentSession;
  });
}

/** A board's snapshot: valid rows with one row per agent session. */
export function parseReports(value: unknown): AgentSession[] {
  const rows = parseSnapshot(value);
  if (new Set(rows.map(reportKey)).size !== rows.length) throw new LocalUiError('agentsInvalidSession');
  return rows;
}


export type LiveProcess = {agent:string;pid:number;startTime:number};
export type LiveAgents = {status:'available'|'truncated'|'unavailable'|'unsupported';processes:LiveProcess[]};
export function parseLiveAgents(value:unknown):LiveAgents|undefined {
  if (!value || typeof value !== 'object' || !('liveAgents' in value) || value.liveAgents === undefined) return undefined;
  const data=value.liveAgents;
  if (!data || typeof data !== 'object' || !('status' in data) || !['available','truncated','unavailable','unsupported'].includes(String(data.status))
    || !('processes' in data) || !Array.isArray(data.processes) || data.processes.length>100) throw new LocalUiError('agentsUnsupportedSnapshot');
  for (const row of data.processes) {
    if (!row || typeof row !== 'object' || typeof row.agent !== 'string' || !row.agent || row.agent.length>80
      || !Number.isSafeInteger(row.pid) || row.pid<1 || !Number.isSafeInteger(row.startTime) || row.startTime<0) throw new LocalUiError('agentsInvalidSession');
  }
  return data as LiveAgents;
}

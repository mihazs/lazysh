import {herdrAgentSession, rememberHerdrAgents, type HerdrTransition} from './herdrEvents';
import {getInbox, hash, summaryText, updateInbox, type InboxRow, type InboxSession} from './notificationStore';
import {parseHerdrAgents, type HerdrTree} from './useHerdrNavigation';
import type {WatchInvoke} from './watchChannel';

/** A hook's report and Herdr's of one transition reach the inbox within this long of each other. */
export const SAME_TRANSITION_MS = 60_000;
const INBOX_STATES = {blocked: 'needs_attention', done: 'done'} as const;
/** The agent names the companion's hooks report, for the kinds whose session id Herdr also knows. */
const HOOK_NAMES: Record<string, string> = {claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode'};
const remembered = new Map<string, {eventId: string; state: InboxRow['state']; at: number}>();
const sequences = new Map<string, number>();

/** The pane identity an inbox row carries for a Herdr pane, as the host companion names it (`herdr:<server>:<pane id>`). */
export const herdrPaneIdentity = (server: string, paneId: string) => `herdr:${server}:${paneId}`;

/** True when Herdr already reported this transition of this row: a hook's report of the same turn is not a second alert. */
export function reportedByHerdr(row: Pick<InboxRow, 'id' | 'state' | 'updatedAt'>): boolean {
  const last = remembered.get(row.id);
  return !!last && last.state === row.state && Math.abs(Date.parse(row.updatedAt) - last.at) < SAME_TRANSITION_MS;
}

/** The transition with the agent session Herdr reports for its pane now. A stream followed only by the inbox monitor has no
 * view reading the tree, so what was last read of the pane may be an earlier session's: a blocked or done pane is read once
 * more, because without its own session id its row could not be the hook's row and the hook's report of the same turn would
 * alert again. A failed read keeps what the stream named. */
export async function withAgentSession(invoke: WatchInvoke, transition: HerdrTransition): Promise<HerdrTransition> {
  if (!(transition.status in INBOX_STATES)) return transition;
  try {
    const {sessionId, server, paneId} = transition;
    rememberHerdrAgents(sessionId, server, parseHerdrAgents(await invoke<HerdrTree>('herdr_tree', {sessionId, name: server})));
    return {...transition, agentSession: herdrAgentSession(sessionId, server, paneId)};
  } catch { return transition; }
}

/** Turns a Herdr pane that became blocked or done into an inbox row for that pane's agent and returns it when the user
 * is to be told (a blocked agent). The row carries the agent, directory and Herdr pane identity, never a command or screen
 * text. One row serves the agent whichever source reports: it is the hook's own row when Herdr names the same agent session
 * or the same pane, and a hook's report of the same transition within a minute neither replaces it nor alerts again. */
export async function collectHerdrTransition(session: InboxSession, transition: HerdrTransition, canCommit = () => true): Promise<InboxRow | null> {
  const state = INBOX_STATES[transition.status as keyof typeof INBOX_STATES];
  if (!state) return null;
  const identity = herdrPaneIdentity(transition.server, transition.paneId);
  const agent = summaryText(HOOK_NAMES[transition.agent ?? ''] ?? transition.agent ?? 'Herdr', 80);
  const agentSessionId = transition.agentSession?.value ?? identity;
  const naturalId = await hash([session.hostId, agent, agentSessionId]);
  const eventId = await hash([naturalId, 'herdr', state, transition.at, transition.sequence]);
  if (!canCommit()) return null;
  const inbox = getInbox();
  // A session id names the agent exactly; without one, the same agent kind in the same pane is the same agent.
  const prior = inbox.rows.find(row => row.hostId === session.hostId && row.id === naturalId)
    ?? (transition.agentSession ? undefined : inbox.rows.find(row => row.hostId === session.hostId && row.paneId === identity && row.agent === agent));
  const id = prior?.id ?? naturalId;
  if (inbox.latest[id] === eventId) return null;
  const previous = remembered.get(id);
  if ((sequences.get(id) ?? -1) > transition.sequence) return null;
  sequences.delete(id); sequences.set(id, transition.sequence);
  if (sequences.size > 200) sequences.delete(sequences.keys().next().value!);
  if (prior && prior.state === state && prior.eventId !== previous?.eventId && Math.abs(Date.parse(prior.updatedAt) - transition.at) < SAME_TRANSITION_MS) return null;
  remembered.delete(id); remembered.set(id, {eventId, state, at: transition.at});
  if (remembered.size > 200) remembered.delete(remembered.keys().next().value!);
  const row: InboxRow = {id, eventId, sessionId: session.id, hostId: session.hostId, hostName: summaryText(session.name, 80), agent, project: summaryText(transition.cwd ?? prior?.project ?? '', 200),
    agentSessionId: prior?.agentSessionId ?? agentSessionId, state, updatedAt: new Date(transition.at).toISOString(), paneId: identity.length <= 256 ? identity : null};
  const latest = {...inbox.latest}; delete latest[id]; latest[id] = eventId;
  updateInbox({latest: Object.fromEntries(Object.entries(latest).slice(-4000)),
    rows: [row, ...inbox.rows.filter(item => item.id !== id)].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 100)}, false);
  return state === 'needs_attention' ? row : null;
}

import {useEffect, useRef, useState} from 'react';
import {accessSnapshot, type AccessLease} from './access';
import {openWatch, type WatchInvoke, type WatchState} from './watchChannel';

/** The host companion's `herdr-events` frames (docs/companion.md, "Herdr event stream"). One subscription per
 * connection and server is shared by every view that reads that server, so two views never fight over it. */
export type HerdrStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';
export type HerdrEvent =
  | {type: 'status'; paneId: string; workspaceId: string; status: HerdrStatus; agent: string | null; cwd: string | null}
  | {type: 'changed'};
/** A status change as the inbox sees it: where it came from, when it arrived and which frame it was. */
export type HerdrTransition = {sessionId: string; server: string; paneId: string; workspaceId: string; status: HerdrStatus;
  agent: string | null; cwd: string | null; agentSession: HerdrAgentSession | null; at: number; sequence: number};
export type HerdrAgentSession = {agent: string; value: string};
/** Sent once per status frame, whatever the number of views that follow the server. */
export const herdrTransitionEvent = 'lazysh-herdr-transition';

const STATUSES = ['idle', 'working', 'blocked', 'done', 'unknown'];
const ID = '[1-9A-HJKMNP-TV-Z0]{1,48}';
const WORKSPACE = new RegExp(`^w${ID}$`), PANE = new RegExp(`^w${ID}:p${ID}$`);
const invalid = () => new Error('Invalid Herdr event frame');
const bounded = (value: unknown, limit: number): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > limit || /[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value)) throw invalid();
  return value;
};

type Parsed = {kind: 'hello' | 'heartbeat' | 'ignored'} | {kind: 'end'} | {kind: 'event'; event: HerdrEvent};
/** Validates one frame strictly; a frame type this client does not know is ignored so a newer companion keeps working. */
export function parseHerdrFrame(value: unknown): Parsed {
  if (!value || typeof value !== 'object') throw invalid();
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case 'hello':
      if (frame.protocol !== 1) throw invalid();
      return {kind: 'hello'};
    case 'heartbeat': return {kind: 'heartbeat'};
    case 'end': return {kind: 'end'};
    case 'changed': return {kind: 'event', event: {type: 'changed'}};
    case 'status': {
      const {paneId, workspaceId, status} = frame;
      if (typeof paneId !== 'string' || !PANE.test(paneId) || typeof workspaceId !== 'string' || !WORKSPACE.test(workspaceId)
        || typeof status !== 'string' || !STATUSES.includes(status)) throw invalid();
      return {kind: 'event', event: {type: 'status', paneId, workspaceId, status: status as HerdrStatus, agent: bounded(frame.agent, 64), cwd: bounded(frame.cwd, 4096)}};
    }
    default:
      if (typeof frame.type !== 'string') throw invalid();
      return {kind: 'ignored'};
  }
}

/** The session Herdr reports for each agent pane, from the last tree read: the key to a hook's own row. */
const sessions = new Map<string, Map<string, HerdrAgentSession>>();
const sourceKey = (sessionId: string, server: string) => JSON.stringify([sessionId, server]);
export function rememberHerdrAgents(sessionId: string, server: string, agents: {pane_id: string; agent_session?: {agent: string; value: string}}[]) {
  sessions.set(sourceKey(sessionId, server), new Map(agents.flatMap(agent => agent.agent_session ? [[agent.pane_id, {agent: agent.agent_session.agent, value: agent.agent_session.value}] as const] : [])));
}
export const herdrAgentSession = (sessionId: string, server: string, paneId: string): HerdrAgentSession | null => sessions.get(sourceKey(sessionId, server))?.get(paneId) ?? null;

type Entry = {refs: number; state: WatchState; events: Set<(event: HerdrEvent) => void>; states: Set<(state: WatchState) => void>; close: () => void};
const entries = new Map<string, Entry>();
let sequence = 0;
const each = <T,>(listeners: Set<(value: T) => void>, value: T) => listeners.forEach(listener => { try { listener(value); } catch { /* A broken view must not reopen the stream. */ } });

/** Follows one server's event stream until the returned function is called; the channel closes with its last follower. */
export function subscribeHerdrEvents({sessionId, server, lease, invoke}: {sessionId: string; server: string; lease: AccessLease; invoke: WatchInvoke},
  onEvent: (event: HerdrEvent) => void, onState: (state: WatchState) => void): () => void {
  // A new app-lock epoch is a new stream: the old one belongs to a lease that no longer holds.
  const key = JSON.stringify([accessSnapshot().epoch, sessionId, server]);
  let entry = entries.get(key);
  if (!entry) {
    const created: Entry = {refs: 0, state: 'connecting', events: new Set(), states: new Set(), close: () => {}};
    created.close = openWatch({sessionId, target: {kind: 'herdrEvents', herdrSession: server}, lease, invoke,
      onState: state => { created.state = state; each(created.states, state); },
      connection: () => frame => {
        const parsed = parseHerdrFrame(frame);
        if (parsed.kind === 'end') return 'lose';
        if (parsed.kind === 'event') {
          const {event} = parsed;
          if (event.type === 'status') {
            const {type: _type, ...status} = event;
            window.dispatchEvent(new CustomEvent<HerdrTransition>(herdrTransitionEvent, {detail: {...status, sessionId, server, at: Date.now(), sequence: ++sequence,
              agentSession: herdrAgentSession(sessionId, server, event.paneId)}}));
          }
          each(created.events, event);
        }
        return parsed.kind === 'heartbeat' || parsed.kind === 'ignored' ? undefined : 'live';
      }});
    entries.set(key, created);
    entry = created;
  }
  const followed = entry;
  followed.refs++; followed.events.add(onEvent); followed.states.add(onState);
  onState(followed.state);
  return () => {
    followed.events.delete(onEvent); followed.states.delete(onState);
    if (--followed.refs === 0) { followed.close(); entries.delete(key); }
  };
}

/** The state of the shared stream while `enabled`; each event goes to `onEvent`. */
export function useHerdrEvents({enabled, sessionId, server, lease, invoke, onEvent}: {
  enabled: boolean; sessionId: string; server: string; lease: AccessLease; invoke: WatchInvoke; onEvent: (event: HerdrEvent) => void;
}): WatchState {
  const [state, setState] = useState<WatchState>('off');
  const latest = useRef(onEvent); latest.current = onEvent;
  useEffect(() => {
    if (!enabled || !server) { setState('off'); return; }
    return subscribeHerdrEvents({sessionId, server, lease, invoke}, event => latest.current(event), setState);
  }, [enabled, sessionId, server, lease, invoke]);
  return state;
}

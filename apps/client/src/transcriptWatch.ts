import {LocalUiError} from './i18n/localError';
import type {WorkItem} from './agentWork';

/** The host companion's `transcript-watch` frames (docs/companion.md, "Live conversation stream").
 * Unknown frame types and fields are ignored so a newer companion keeps working. */
export type Activity = 'working' | 'waiting' | 'idle' | 'stopped';
/** Prompts waiting for the agent; see `AgentQueued`. A snapshot always carries the list, a delta only when it changed. */
export type QueuedList = {text: string; timestamp?: string}[];
export type WatchEntry<M> = {id: string; rev: number; message: M};
export type WatchFrame<M> =
  | {type: 'hello'}
  | {type: 'snapshot'; gen: number; seq: number; entries: WatchEntry<M>[]; activity?: Activity; queued?: QueuedList; work?: WorkItem[]}
  | {type: 'delta'; gen: number; seq: number; upserts: WatchEntry<M>[]; activity?: {value?: Activity}; queued?: QueuedList; work?: {value?: WorkItem[]}}
  | {type: 'heartbeat'}
  | {type: 'end'; reason: string}
  | {type: 'ignored'};
/** What native sends: a frame, "this host cannot stream" (do not retry soon), or "the channel ended". */
export type WatchEvent = {type: 'frame'; frame: unknown} | {type: 'unavailable'; reason: string} | {type: 'closed'; reason: string};
export type WatchOp<M> = {kind: 'replace'; messages: M[]; activity?: Activity; queued?: QueuedList; work?: WorkItem[]} | {kind: 'patch'; messages: M[]; activity?: {value?: Activity}; queued?: QueuedList; work?: {value?: WorkItem[]}};
/** Validates a page-shaped object exactly as the paged reader does, so one rule set covers both paths. */
export type PageParser<M> = (page: unknown) => {messages: M[]; activity?: Activity; queued?: QueuedList; work?: WorkItem[]};

const invalid = () => new LocalUiError('chatInvalidResponse');
const integer = (value: unknown, minimum: number): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw invalid();
  return value;
};

function entries<M extends {id: string}>(value: unknown, agent: string, extra: {activity?: unknown; queued?: unknown; work?: unknown}, parsePage: PageParser<M>): {entries: WatchEntry<M>[]; activity?: Activity; queued?: QueuedList; work?: WorkItem[]} {
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  const rows = value.map(row => {
    if (!row || typeof row !== 'object') throw invalid();
    const entry = row as {id?: unknown; rev?: unknown; message?: unknown};
    if (typeof entry.id !== 'string' || !entry.id || entry.id.length > 4096) throw invalid();
    return {id: entry.id, rev: integer(entry.rev, 1), message: entry.message};
  });
  const page = parsePage({schemaVersion: 1, agent, view: 'active_branch', messages: rows.map(row => row.message), nextOffset: 0, hasMore: false, ...(extra.activity == null ? {} : {activity: extra.activity}), ...(extra.queued === undefined ? {} : {queued: extra.queued}), ...(extra.work == null ? {} : {work: extra.work})});
  if (page.messages.length !== rows.length || new Set(rows.map(row => row.id)).size !== rows.length
    || page.messages.some((message, index) => message.id !== rows[index].id)) throw invalid();
  return {entries: rows.map((row, index) => ({id: row.id, rev: row.rev, message: page.messages[index]})), activity: page.activity, queued: page.queued, work: page.work};
}

export function parseWatchFrame<M extends {id: string}>(value: unknown, agent: string, parsePage: PageParser<M>): WatchFrame<M> {
  if (!value || typeof value !== 'object') throw invalid();
  const frame = value as Record<string, unknown>;
  switch (frame.type) {
    case 'hello':
      if (frame.protocol !== 1 || (frame.agent !== undefined && frame.agent !== agent)) throw invalid();
      return {type: 'hello'};
    case 'snapshot': {
      const parsed = entries(frame.entries, agent, {activity: frame.activity, queued: frame.queued ?? [], work: frame.work}, parsePage);
      return {type: 'snapshot', gen: integer(frame.gen, 1), seq: integer(frame.seq, 1), entries: parsed.entries, activity: parsed.activity, queued: parsed.queued, work: parsed.work};
    }
    case 'delta': {
      const parsed = entries(frame.upserts, agent, frame, parsePage);
      if (!Array.isArray(frame.drops) || frame.drops.length > 100 || frame.drops.some(id => typeof id !== 'string')) throw invalid();
      return {type: 'delta', gen: integer(frame.gen, 1), seq: integer(frame.seq, 1), upserts: parsed.entries, ...('activity' in frame ? {activity: {value: parsed.activity}} : {}), ...('queued' in frame ? {queued: parsed.queued ?? []} : {}), ...('work' in frame ? {work: {value: parsed.work}} : {})};
    }
    case 'heartbeat': return {type: 'heartbeat'};
    case 'end': return {type: 'end', reason: typeof frame.reason === 'string' ? frame.reason.slice(0, 64) : ''};
    default:
      if (typeof frame.type !== 'string') throw invalid();
      return {type: 'ignored'};
  }
}

/** Tracks one stream: `snapshot` replaces, `delta` patches the same `gen` in order, and anything the
 * client cannot place (another `gen`, a skipped `seq`) asks for a fresh stream instead of guessing.
 * A `seq` or `rev` already seen is dropped, so duplicates change nothing. */
export function createWatchApplier<M extends {id: string}>() {
  let gen = 0, seq = 0;
  const revs = new Map<string, number>();
  return (frame: WatchFrame<M>): WatchOp<M> | 'resync' | undefined => {
    if (frame.type === 'snapshot') {
      if (frame.gen < gen || (frame.gen === gen && frame.seq <= seq)) return undefined;
      gen = frame.gen; seq = frame.seq; revs.clear();
      frame.entries.forEach(entry => revs.set(entry.id, entry.rev));
      return {kind: 'replace', messages: frame.entries.map(entry => entry.message), activity: frame.activity, queued: frame.queued, work: frame.work};
    }
    if (frame.type !== 'delta') return undefined;
    if (gen === 0 || frame.gen !== gen) return 'resync';
    if (frame.seq <= seq) return undefined;
    if (frame.seq !== seq + 1) return 'resync';
    seq = frame.seq;
    const fresh = frame.upserts.filter(entry => entry.rev > (revs.get(entry.id) ?? 0));
    fresh.forEach(entry => revs.set(entry.id, entry.rev));
    return {kind: 'patch', messages: fresh.map(entry => entry.message), activity: frame.activity, queued: frame.queued, work: frame.work};
  };
}

/** A patch replaces a known message where it stands and appends a new one; the window keeps its newest `limit`. */
export function applyWatchOp<M extends {id: string}>(previous: M[], op: WatchOp<M>, limit = 500): M[] {
  if (op.kind === 'replace') return op.messages;
  if (!op.messages.length) return previous;
  const next = previous.slice();
  const index = new Map(next.map((message, position) => [message.id, position]));
  for (const message of op.messages) {
    const at = index.get(message.id);
    if (at === undefined) {index.set(message.id, next.length); next.push(message);} else next[at] = message;
  }
  return next.slice(-limit);
}

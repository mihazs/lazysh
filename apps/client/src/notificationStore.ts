import { useSyncExternalStore } from 'react';
import { parseSnapshot } from './AgentPanel';

export type InboxSession = { id: string; hostId: string; name: string; connected: boolean };
export type InboxRow = { id: string; eventId: string; sessionId: string; hostId: string; hostName: string; agent: string; project: string; agentSessionId: string; state: 'working' | 'needs_attention' | 'done'; updatedAt: string; paneId: string | null };
type InboxState = { version: 1; monitoring: boolean; notifications: boolean; rows: InboxRow[]; latest: Record<string, string>; error: string };
const storageKey = 'lazysh.inbox.v1';
const eventName = 'lazysh-inbox';
const hashPattern = /^[a-f\d]{64}$/;
const text = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length <= limit;
const defaults = (): InboxState => ({ version: 1, monitoring: false, notifications: false, rows: [], latest: {}, error: '' });

export function parseInbox(value: unknown): InboxState {
  if (!value || typeof value !== 'object') return defaults();
  const data = value as Record<string, unknown>;
  if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > 100 || !data.latest || typeof data.latest !== 'object' || Array.isArray(data.latest) || Object.keys(data.latest).length > 4000) return defaults();
  const rows = data.rows.filter((row): row is InboxRow => !!row && typeof row === 'object' && text(row.id, 64) && hashPattern.test(row.id) && text(row.eventId, 64) && hashPattern.test(row.eventId) && text(row.sessionId, 100) && text(row.hostId, 100) && text(row.hostName, 80) && text(row.agent, 80) && text(row.project, 200) && text(row.agentSessionId, 4096) && ['working', 'needs_attention', 'done'].includes(row.state) && text(row.updatedAt, 64) && Number.isFinite(Date.parse(row.updatedAt)) && (row.paneId === null || text(row.paneId, 256))).map(row => ({ id: row.id, eventId: row.eventId, sessionId: row.sessionId, hostId: row.hostId, hostName: row.hostName, agent: row.agent, project: row.project, agentSessionId: row.agentSessionId, state: row.state, updatedAt: row.updatedAt, paneId: row.paneId }));
  const latest = Object.fromEntries(Object.entries(data.latest).filter(([key, value]) => hashPattern.test(key) && typeof value === 'string' && hashPattern.test(value)));
  return { version: 1, monitoring: data.monitoring === true, notifications: data.notifications === true, rows, latest, error: '' };
}
let cached: InboxState | undefined;
let serialized: string | undefined;
export function getInbox(): InboxState {
  if (!cached) {
    try { const stored = localStorage.getItem(storageKey); cached = stored && stored.length < 1500000 ? parseInbox(JSON.parse(stored)) : defaults(); serialized = stored || undefined; }
    catch { cached = defaults(); }
  }
  return cached;
}
export function updateInbox(change: Partial<InboxState>, persist = true) {
  cached = { ...getInbox(), ...change };
  try { if (persist) { const { error: _error, ...stored } = cached; const encoded = JSON.stringify(stored); if (encoded !== serialized) { localStorage.setItem(storageKey, encoded); serialized = encoded; } } }
  catch { cached = { ...cached, error: 'The inbox could not be saved on this device.' }; }
  window.dispatchEvent(new Event(eventName));
}
function subscribe(listener: () => void) {
  const stored = (event: StorageEvent) => { if (event.key === storageKey || event.key === null) { cached = undefined; serialized = undefined; listener(); } };
  window.addEventListener(eventName, listener);
  window.addEventListener('storage', stored);
  return () => { window.removeEventListener(eventName, listener); window.removeEventListener('storage', stored); };
}
export function useInbox() { return useSyncExternalStore(subscribe, getInbox, defaults); }

async function hash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
const summaryText = (value: string, limit: number) => value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, limit);

export async function collectInbox(session: InboxSession, snapshot: unknown, baseline: boolean, canCommit = () => true, persist = true): Promise<InboxRow[]> {
  const reported = parseSnapshot(snapshot);
  const events = await Promise.all(reported.map(async row => {
    const id = await hash([session.hostId, row.agent, row.sessionId]);
    const eventId = await hash([id, row.eventCount, row.updatedAt, row.state]);
    const event: InboxRow = { id, eventId, sessionId: session.id, hostId: session.hostId, hostName: summaryText(session.name, 80), agent: summaryText(row.agent, 80), project: summaryText(row.project, 200), agentSessionId: row.sessionId, state: row.state, updatedAt: new Date(row.updatedAt).toISOString(), paneId: row.paneId?.slice(0, 256) || null };
    return event;
  }));
  if (!canCommit()) return [];
  const state = getInbox();
  const latest = { ...state.latest };
  const rows = new Map(state.rows.map(row => [row.id, row]));
  const alerts: InboxRow[] = [];
  for (const event of events) {
    const previous = latest[event.id];
    delete latest[event.id]; latest[event.id] = event.eventId;
    if (previous === event.eventId) {
      const existing = rows.get(event.id);
      if (existing) rows.set(event.id, { ...existing, sessionId: session.id, hostName: event.hostName });
      continue;
    }
    rows.set(event.id, event);
    if (!baseline && event.state === 'needs_attention') alerts.push(event);
  }
  updateInbox({ latest: Object.fromEntries(Object.entries(latest).slice(-4000)), rows: [...rows.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 100) }, persist);
  return alerts;
}

export function openInboxEvent(eventId: string, sessions: InboxSession[], expectedSessionId?: string): boolean {
  const row = getInbox().rows.find(row => row.eventId === eventId);
  if (!row || (expectedSessionId !== undefined && row.sessionId !== expectedSessionId) || !sessions.some(session => session.id === row.sessionId && session.hostId === row.hostId && session.connected)) return false;
  window.dispatchEvent(new CustomEvent('lazysh-inbox-open', { detail: { sessionId: row.sessionId } }));
  return true;
}

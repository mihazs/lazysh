import {useSyncExternalStore} from 'react';

/**
 * The last sign-in flows, for Settings (#1514). In memory only: it is gone when the app closes. A row holds the host
 * name, the callback port, and two fixed words, never an address, a query, a `code` or a `state`.
 */
export type AuditDecision = 'asked' | 'allowed' | 'always' | 'denied' | 'automatic' | 'blocked' | 'expired';
export type AuditOutcome = 'pending' | 'none' | 'completed' | 'timeout' | 'stopped' | 'hostStopped' | 'noForwarding' | 'connectionLost' | 'failed';
export type AuditEntry = {id: number; at: number; hostName: string; port: number; decision: AuditDecision; outcome: AuditOutcome};
export type AuditSnapshot = {entries: readonly AuditEntry[]; blocked: number};

export const AUDIT_LIMIT = 50;
let snapshot: AuditSnapshot = {entries: [], blocked: 0};
let next = 1;
const listeners = new Set<() => void>();
function publish(value: AuditSnapshot) { snapshot = value; for (const listener of [...listeners]) listener(); }

/** Adds a flow and returns its row id. The newest row is first; the oldest rows drop at the limit. */
export function recordAuth(entry: Pick<AuditEntry, 'hostName' | 'port' | 'decision'> & Partial<Pick<AuditEntry, 'outcome'>>, at = Date.now()): number {
  const id = next++;
  const row: AuditEntry = {id, at, hostName: entry.hostName, port: entry.port, decision: entry.decision, outcome: entry.outcome ?? 'pending'};
  publish({...snapshot, entries: [row, ...snapshot.entries].slice(0, AUDIT_LIMIT)});
  return id;
}
export function updateAuth(id: number, patch: Partial<Pick<AuditEntry, 'decision' | 'outcome'>>) {
  if (!snapshot.entries.some(row => row.id === id)) return;
  publish({...snapshot, entries: snapshot.entries.map(row => row.id === id ? {...row, ...patch} : row)});
}
/** Counts a sign-in a host's Never choice kept from starting. */
export const countBlockedAuth = () => publish({...snapshot, blocked: snapshot.blocked + 1});
export const clearAuthAudit = () => publish({entries: [], blocked: 0});

function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export const authAuditSnapshot = () => snapshot;
export function useAuthAudit() { return useSyncExternalStore(subscribe, authAuditSnapshot, authAuditSnapshot); }

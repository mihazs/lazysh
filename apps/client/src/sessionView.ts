import type {LiveSession} from './terminal';

/** How a session is shown: its terminal, its Agent view, or both side by side. */
export type SessionView = 'terminal' | 'agent' | 'both';
/** Session-area width from which Both is offered. */
export const bothMinWidth = 1100;
const storageKey = 'lazysh-session-views';
const maxSessions = 100;

/** Saved host plus multiplexer target, so a reopened or reconnected session finds its choice.
 * A plain shell has no target to find again: its choice is keyed by this session only and never stored. */
export function sessionViewKey(session: Pick<LiveSession, 'id' | 'hostId' | 'attached'>) {
  const target = session.attached;
  return target ? JSON.stringify([session.hostId, target.kind, target.restoreName ?? target.name, target.tmuxServer ?? null]) : `session:${session.id}`;
}
const stored = (key: string) => key.startsWith('[');

export function readSessionViews(): Record<string, SessionView> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, SessionView] => stored(entry[0]) && (entry[1] === 'agent' || entry[1] === 'both')));
  } catch { return {}; }
}

/** Per-device convenience: Terminal is the default and is not stored. */
export function saveSessionView(views: Record<string, SessionView>, key: string, view: SessionView) {
  const {[key]: _previous, ...rest} = views;
  const next = view === 'terminal' ? rest : Object.fromEntries([...Object.entries(rest), [key, view]].slice(-maxSessions));
  try { localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(Object.entries(next).filter(([key]) => stored(key))))); } catch { /* The choice lasts for this app run. */ }
  return next as Record<string, SessionView>;
}

const fullKey = 'lazysh-agent-view-full';
/** Per-device convenience: the Agent view hides the app bars around it. Off is the default and is not stored. */
export function readAgentFull(): boolean {
  try { return localStorage.getItem(fullKey) === '1'; } catch { return false; }
}
export function saveAgentFull(full: boolean) {
  try { if (full) localStorage.setItem(fullKey, '1'); else localStorage.removeItem(fullKey); } catch { /* The choice lasts for this app run. */ }
}

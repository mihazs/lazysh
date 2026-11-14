import {invoke} from '@tauri-apps/api/core';
import type {AccessLease} from './access';

/**
 * Does the host listen where a sign-in hint says it will (#1510)? One question to the host and the rules
 * that turn a series of answers into a confirmation. Nothing here starts a tunnel or opens a page.
 */
export type AuthListener = {
  /** `companion` is the host's `lazysh-agent listeners`; `fallback` is `ss` or `lsof`, which cannot say how old the process is. */
  source: 'companion' | 'fallback';
  bind: 'loopback' | 'wildcard';
  /** False for another user's process (the NetBird daemon): such a listener is never tunnelled automatically. */
  ownedBySessionUser: boolean;
  /** How long the owning process had run, on the host's own clock. */
  ageSeconds?: number;
  comm?: string;
  pid?: number;
};
/**
 * `absent`: nothing listens. `confirmed`: a process that started up to 120 s before the hint, or up to 30 s
 * after it, listens. `stale`: one listens that started outside that window. `unproven`: one listens and its
 * age is unknown (a host without the newer companion).
 */
export type ListenerVerdict = {state: 'absent' | 'confirmed' | 'stale' | 'unproven'; listener?: AuthListener};

/** The part of a sign-in hint the check needs. */
export type HintSighting = {port: number; firstSeenAt: string};

const pending = new Set<string>();
/** One native question at a time per session and port; a replacement view never overlaps its predecessor. */
export async function checkAuthListener(lease: AccessLease, sessionId: string, port: number, seenSecondsAgo: number): Promise<ListenerVerdict> {
  lease.assert();
  const key = `${sessionId}:${port}`;
  if (pending.has(key)) throw new Error('A listener check for this port is already running.');
  pending.add(key);
  try {
    const verdict = await invoke<ListenerVerdict>('check_auth_listener', {sessionId, port, seenSecondsAgo: Math.max(0, Math.floor(seenSecondsAgo))}, {headers: lease.headers});
    lease.assert();
    return verdict;
  } finally { pending.delete(key); }
}

export type Confirmation = ListenerVerdict & {
  /** The listener was absent at first and showed up later, so its unknown age is no reason to doubt it. */
  appeared: boolean;
};
export type ConfirmOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Questions are this far apart. */
  intervalMs?: number;
};
/** How long after a hint a listener may still appear and count as its own. */
export const APPEAR_WINDOW_SECONDS = 30;

/**
 * Asks about a hint's port until the answer is settled: `confirmed` and `stale` end it at once; a listener of
 * unknown age is `unproven`, unless the port was seen empty first, when it is confirmed because it appeared;
 * a port that stays empty for 30 s after the hint is `absent`. Ends early, as `absent`, when `signal` aborts.
 */
export async function confirmHint(
  hint: HintSighting,
  check: (port: number, seenSecondsAgo: number) => Promise<ListenerVerdict>,
  {now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), signal, intervalMs = 1000}: ConfirmOptions = {},
): Promise<Confirmation> {
  const seen = Date.parse(hint.firstSeenAt);
  if (!Number.isFinite(seen)) throw new Error('A sign-in hint needs the time it was first seen.');
  let wasAbsent = false;
  for (;;) {
    const age = Math.max(0, (now() - seen) / 1000);
    const verdict = await check(hint.port, age);
    if (verdict.state === 'confirmed' || verdict.state === 'stale') return {...verdict, appeared: false};
    if (verdict.state === 'unproven') return wasAbsent ? {...verdict, state: 'confirmed', appeared: true} : {...verdict, appeared: false};
    wasAbsent = true;
    if (signal?.aborted || (now() - seen) / 1000 + intervalMs / 1000 > APPEAR_WINDOW_SECONDS) return {state: 'absent', appeared: false};
    await sleep(intervalMs);
  }
}

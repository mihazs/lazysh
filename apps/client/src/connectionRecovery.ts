import {useEffect, useState} from 'react';

/** What a lost session's banner shows. `attempt` counts attempts already made, except
 * while `connecting`, where it is the attempt in flight; `waiting` counts down to `retryAt`. */
export type RecoveryState =
  | {phase: 'waiting'; attempt: number; retryAt: number}
  | {phase: 'connecting'; attempt: number}
  | {phase: 'offline'; attempt: number}
  | {phase: 'stopped'; attempt: number; message: string; exhausted: boolean};

export type RecoveryOutcome = 'reconnected' | {retry: boolean; message: string};

export const RECOVERY_BASE_DELAY = 1000;
export const RECOVERY_MAX_DELAY = 30_000;
export const RECOVERY_MAX_ATTEMPTS = 10;

/** Exponential backoff capped at RECOVERY_MAX_DELAY, with ±20% jitter so tabs do not retry in lockstep. */
export function reconnectDelay(attempt: number, random: () => number = Math.random) {
  const ideal = Math.min(RECOVERY_MAX_DELAY, RECOVERY_BASE_DELAY * 2 ** Math.max(0, attempt - 1));
  return Math.round(ideal * (0.8 + 0.4 * random()));
}

// A retry cannot fix what the server or the person must decide.
const finalKinds = new Set([
  'authentication_failed', 'credentials_required', 'host_key_changed', 'unknown_host_key',
  'identity_invalid', 'identity_passphrase_required', 'identity_unsupported', 'forwarding_requires_key',
  'credentials_unavailable', 'vault_locked', 'storage', 'host_not_found', 'cancelled',
]);
export function retriableFailure(error: unknown) {
  const kind = error && typeof error === 'object' && 'kind' in error ? (error as {kind: unknown}).kind : undefined;
  return typeof kind !== 'string' || !finalKinds.has(kind);
}

type Options = {
  attempt: (id: string) => Promise<RecoveryOutcome>;
  changed: () => void;
  online: () => boolean;
  random?: () => number;
  now?: () => number;
};

/**
 * Schedules reconnect attempts per lost session. While the device reports no network,
 * attempts slow to the cap instead of stopping, because an OS signal can be wrong
 * (a VPN-only or loopback route); the network's return retries at once. A final
 * failure or the attempt cap stops retrying until the person or the network asks again.
 */
export class ConnectionRecovery {
  private readonly states = new Map<string, RecoveryState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly generation = new Map<string, number>();
  constructor(private readonly options: Options) {}

  state(id: string) { return this.states.get(id); }
  has(id: string) { return this.states.has(id); }

  /** Begins recovering `id`; `automatic` false waits for an explicit retry. */
  start(id: string, automatic: boolean, message = '') {
    if (this.states.has(id)) return;
    if (!automatic) this.set(id, {phase: 'stopped', attempt: 0, message, exhausted: false});
    else this.schedule(id, 1);
  }
  retryNow(id: string) {
    const current = this.states.get(id);
    if (!current || current.phase === 'connecting') return;
    void this.run(id, current.attempt + 1);
  }
  cancel(id: string) {
    this.clearTimer(id);
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    if (this.states.delete(id)) this.options.changed();
  }
  dispose() { for (const id of [...this.states.keys()]) this.cancel(id); }
  networkChanged(online: boolean) {
    for (const [id, current] of this.states) {
      if (online && (current.phase === 'offline' || current.phase === 'waiting' || (current.phase === 'stopped' && current.exhausted))) {
        this.clearTimer(id);
        void this.run(id, current.attempt + 1);
      } else if (!online && current.phase === 'waiting') {
        this.schedule(id, current.attempt + 1);
      }
    }
  }

  private schedule(id: string, attempt: number) {
    const offline = !this.options.online();
    const delay = offline ? RECOVERY_MAX_DELAY : reconnectDelay(attempt, this.options.random);
    this.set(id, offline ? {phase: 'offline', attempt: attempt - 1}
      : {phase: 'waiting', attempt: attempt - 1, retryAt: (this.options.now ?? Date.now)() + delay});
    this.clearTimer(id);
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); void this.run(id, attempt); }, delay));
  }
  private async run(id: string, attempt: number) {
    this.clearTimer(id);
    const generation = (this.generation.get(id) ?? 0) + 1;
    this.generation.set(id, generation);
    this.set(id, {phase: 'connecting', attempt});
    let outcome: RecoveryOutcome;
    try { outcome = await this.options.attempt(id); }
    catch (error) { outcome = {retry: retriableFailure(error), message: error instanceof Error ? error.message : String(error)}; }
    if (this.generation.get(id) !== generation || !this.states.has(id)) return;
    if (outcome === 'reconnected') { this.cancel(id); return; }
    if (!outcome.retry || attempt >= RECOVERY_MAX_ATTEMPTS) this.set(id, {phase: 'stopped', attempt, message: outcome.message, exhausted: outcome.retry});
    else this.schedule(id, attempt + 1);
  }
  private set(id: string, state: RecoveryState) { this.states.set(id, state); this.options.changed(); }
  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer !== undefined) { clearTimeout(timer); this.timers.delete(id); }
  }
}

/** The operating system's network signal, as the WebView reports it. */
export function useNetworkOnline() {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  return online;
}

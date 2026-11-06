import {useEffect, useRef, useState} from 'react';
import type {UiKey} from './i18n/core';

/** What a lost session's banner shows. `attempt` counts attempts already made, except
 * while `connecting`, where it is the attempt in flight; `waiting` counts down to `retryAt`. */
export type RecoveryState =
  | {phase: 'waiting'; attempt: number; retryAt: number}
  | {phase: 'connecting'; attempt: number}
  | {phase: 'offline'; attempt: number}
  | {phase: 'stopped'; attempt: number; message: string; hint?: RecoveryHint; exhausted: boolean};

/** Why a session waits for the person, kept as a key so the banner follows a later language change. */
export type RecoveryHint = Extract<UiKey, 'recoveryConfirmToReconnect' | 'recoverySignInToReconnect' | 'appConnectionClosed'>;
export type RecoveryOutcome = 'reconnected' | {retry: boolean; message?: string; hint?: RecoveryHint};

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
function field(error: unknown, name: 'kind' | 'message') {
  const value = error && typeof error === 'object' && name in error ? (error as Record<string, unknown>)[name] : undefined;
  return typeof value === 'string' ? value : undefined;
}
export function retriableFailure(error: unknown) {
  const kind = field(error, 'kind');
  return kind === undefined || !finalKinds.has(kind);
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
 * A manual session (one whose credentials need a prompt) only ever tries on Retry now:
 * a failure stops again and the network's return leaves it alone.
 */
export class ConnectionRecovery {
  private readonly states = new Map<string, RecoveryState>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly generation = new Map<string, number>();
  private readonly manual = new Set<string>();
  constructor(private readonly options: Options) {}

  state(id: string) { return this.states.get(id); }
  has(id: string) { return this.states.has(id); }

  /** Begins recovering `id`; `automatic` false waits for an explicit retry every time. */
  start(id: string, automatic: boolean, hint?: RecoveryHint) {
    if (this.states.has(id)) return;
    if (automatic) { this.schedule(id, 1); return; }
    this.manual.add(id);
    this.set(id, {phase: 'stopped', attempt: 0, message: '', ...(hint ? {hint} : {}), exhausted: false});
  }
  retryNow(id: string) {
    const current = this.states.get(id);
    if (!current || current.phase === 'connecting') return;
    void this.run(id, current.attempt + 1);
  }
  cancel(id: string) {
    this.clearTimer(id);
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.manual.delete(id);
    if (this.states.delete(id)) this.options.changed();
  }
  dispose() { for (const id of [...this.states.keys()]) this.cancel(id); }
  networkChanged(online: boolean) {
    for (const [id, current] of this.states) {
      if (this.manual.has(id)) continue;
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
    // Native failures arrive as plain {kind, message} objects, not Error instances.
    catch (error) { outcome = {retry: retriableFailure(error), message: field(error, 'message') ?? String(error)}; }
    if (this.generation.get(id) !== generation || !this.states.has(id)) return;
    if (outcome === 'reconnected') { this.cancel(id); return; }
    const manual = this.manual.has(id);
    if (outcome.retry && !manual && attempt < RECOVERY_MAX_ATTEMPTS) { this.schedule(id, attempt + 1); return; }
    this.set(id, {phase: 'stopped', attempt, message: outcome.message ?? '', ...(outcome.hint ? {hint: outcome.hint} : {}), exhausted: outcome.retry && !manual});
  }
  private set(id: string, state: RecoveryState) { this.states.set(id, state); this.options.changed(); }
  private clearTimer(id: string) {
    const timer = this.timers.get(id);
    if (timer !== undefined) { clearTimeout(timer); this.timers.delete(id); }
  }
}

/** The operating system's network signal, as the WebView reports it. `changed` runs, at most
 * once per burst of events, when the network returns or switches (Wi-Fi to cellular, a new address). */
export function useNetworkOnline(changed?: () => void) {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const latest = useRef(changed);
  latest.current = changed;
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const update = () => setOnline(navigator.onLine !== false);
    const settle = () => {
      update();
      if (navigator.onLine === false) return;
      clearTimeout(pending);
      pending = setTimeout(() => latest.current?.(), NETWORK_SETTLE_DELAY);
    };
    const connection = (navigator as Navigator & {connection?: EventTarget}).connection;
    window.addEventListener('online', settle); window.addEventListener('offline', update);
    connection?.addEventListener?.('change', settle);
    return () => {
      clearTimeout(pending);
      window.removeEventListener('online', settle); window.removeEventListener('offline', update);
      connection?.removeEventListener?.('change', settle);
    };
  }, []);
  return online;
}
/** A network switch fires `online` and `change` together; one probe answers both. */
const NETWORK_SETTLE_DELAY = 300;

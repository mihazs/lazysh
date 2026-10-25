import { invoke as nativeInvoke, type InvokeArgs } from '@tauri-apps/api/core';
import { useMemo, useRef, useSyncExternalStore } from 'react';
import { disposeStaleSessionResult } from './pendingSessions';

export type AccessStatus = {
  initialized: boolean; supported: boolean; reason: string; enabled: boolean;
  locked: boolean; generation: string; nonce?: string;
};
type Snapshot = { status: AccessStatus | null; epoch: number };
let snapshot: Snapshot = { status: null, epoch: 0 };
let readyEpoch = 0;
const listeners = new Set<() => void>();
export function subscribeAccess(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function accessSnapshot() { return snapshot; }
/** Observe readiness without replacing an operation's originally captured lease. */
export function isAccessReady() { return readyEpoch === snapshot.epoch && !!snapshot.status?.initialized && !snapshot.status.locked; }
export function useAccessSnapshot() { return useSyncExternalStore(subscribeAccess, accessSnapshot, accessSnapshot); }

export function parseAccessStatus(value: unknown): AccessStatus {
  if (!value || typeof value !== 'object') throw new Error('Invalid native app lock status.');
  const v = value as Record<string, unknown>;
  if (['initialized', 'supported', 'enabled', 'locked'].some(key => typeof v[key] !== 'boolean')
    || typeof v.reason !== 'string' || v.reason.length > 2000
    || typeof v.generation !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(v.generation)
    || BigInt(v.generation) > 18_446_744_073_709_551_615n
    || (v.nonce !== undefined && (typeof v.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(v.nonce)))
    || (v.locked && v.nonce !== undefined)) throw new Error('Invalid native app lock status.');
  return Object.freeze({ initialized: v.initialized as boolean, supported: v.supported as boolean,
    enabled: v.enabled as boolean, locked: v.locked as boolean, reason: v.reason,
    generation: v.generation, ...(v.nonce === undefined ? {} : { nonce: v.nonce as string }) });
}
export function applyAccessStatus(value: unknown) {
  const status = parseAccessStatus(value);
  const old = snapshot.status;
  if (old && BigInt(status.generation) < BigInt(old.generation)) return;
  if (old && JSON.stringify(old) === JSON.stringify(status)) return;
  snapshot = { status, epoch: snapshot.epoch + 1 };
  for (const listener of [...listeners]) listener();
}
export function acknowledgeAccessReady(epoch: number) {
  if (snapshot.epoch !== epoch || !snapshot.status?.initialized || snapshot.status.locked) return;
  readyEpoch = epoch;
  for (const listener of [...listeners]) listener();
}
export class StaleAccessError extends Error {
  constructor() { super('App access changed. Reopen this view and try again.'); this.name = 'StaleAccessError'; }
}
export type AccessLease = ReturnType<typeof captureAccess>;
export function captureAccess() {
  const captured = snapshot;
  return Object.freeze({
    headers: Object.freeze({ 'X-Lazysh-Access': captured.status?.nonce ?? '' }),
    current: () => snapshot.epoch === captured.epoch && (!snapshot.status
      || (snapshot.status.initialized && !snapshot.status.locked)),
    assert() { if (!this.current()) throw new StaleAccessError(); },
  });
}
export function bindProtectedInvoke(lease: AccessLease) {
  return function invoke<T>(command: string, args?: InvokeArgs): Promise<T> {
    if (!lease.current()) return Promise.reject(new StaleAccessError());
    return new Promise<T>((resolve, reject) => {
      const stop = subscribeAccess(() => {
        if (!lease.current()) { stop(); reject(new StaleAccessError()); }
      });
      void nativeInvoke<T>(command, args, { headers: lease.headers }).then(value => {
        stop(); if (lease.current()) resolve(value); else {
          void disposeStaleSessionResult(command, value).catch(() => {});
          reject(new StaleAccessError());
        }
      }, error => { stop(); reject(lease.current() ? error : new StaleAccessError()); });
    });
  };
}
/** Capture before invoking; never retry or replace an old request's nonce. */
export function protectedInvoke<T>(command: string, args?: InvokeArgs): Promise<T> {
  return bindProtectedInvoke(captureAccess())<T>(command, args);
}
export function useProtectedInvoke() {
  const lease = useRef(captureAccess()).current;
  return useMemo(() => bindProtectedInvoke(lease), [lease]);
}
export function bindProtectedApi<T extends object>(api: T, lease: AccessLease): T {
  return new Proxy(api, { get(target, key, receiver) {
    const value = Reflect.get(target, key, receiver);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if (!lease.current()) return Promise.reject(new StaleAccessError());
      return Promise.resolve(Reflect.apply(value, target, args)).then(result => {
        if (!lease.current()) {
          void disposeStaleSessionResult(key, result).catch(() => {});
          throw new StaleAccessError();
        }
        return result;
      }, error => { lease.assert(); throw error; });
    };
  } });
}
export function useProtectedApi<T extends object>(api: T): T {
  const lease = useRef(captureAccess()).current;
  return useMemo(() => bindProtectedApi(api, lease), [api, lease]);
}
export function guardAccessCallback<T>(callback: (value: T) => void) {
  const lease = captureAccess();
  return (value: T) => { if (lease.current()) callback(value); };
}
export function useProtectedCallback() {
  const lease = useRef(captureAccess()).current;
  return useMemo(() => <T,>(callback: (value: T) => void) =>
    (value: T) => { if (lease.current()) callback(value); }, [lease]);
}

/** Live terminals outlast tool mounts. Hold already-delivered output without granting new IPC access. */
export function sessionOutput<T extends { type: string; data?: number[] }>(callback: (value: T) => void) {
  let queued: T[] = []; let bytes = 0; let stop: (() => void) | undefined;
  let disposed = false;
  const paused = () => !!snapshot.status && (!snapshot.status.initialized || snapshot.status.locked || readyEpoch !== snapshot.epoch);
  const drain = () => {
    if (paused()) return;
    const pending = queued; queued = []; bytes = 0; stop?.(); stop = undefined;
    for (const value of pending) callback(value);
  };
  const deliver = (value: T) => {
    if (disposed) return;
    if (!paused()) { callback(value); return; }
    bytes += value.type === 'data' ? value.data?.length ?? 0 : 0;
    // Native SSH and local PTYs each allow at most 256 KiB of unacknowledged output.
    if (bytes > 256 * 1024 || queued.length >= 4096) throw new Error('Invalid terminal output window.');
    const previous = queued.at(-1);
    if (value.type === 'data' && previous?.type === 'data' && previous.data && value.data) {
      // A peer can send tiny frames; coalesce pending bytes rather than retain one object per byte.
      for (const byte of value.data) previous.data.push(byte);
    } else queued.push(value.type === 'data' && value.data ? { ...value, data: [...value.data] } : value);
    stop ??= subscribeAccess(drain);
  };
  return Object.assign(deliver, { dispose() { disposed = true; queued = []; bytes = 0; stop?.(); stop = undefined; } });
}

/** These commands expose only lock state or perform native-controlled OS authentication. */
export const accessControl = {
  status: () => nativeInvoke<AccessStatus>('app_lock_status'),
  configure: (enabled: boolean) => protectedInvoke<AccessStatus>('app_lock_configure', { enabled }),
  ready: (generation: string) => nativeInvoke<void>('app_lock_ready', { generation }),
};

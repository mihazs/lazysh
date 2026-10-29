import { invoke } from '@tauri-apps/api/core';
const retained = new Set<string>();
const output = new Map<string, () => void>();
export function retainSession(id: string) { retained.add(id); }
export function registerSessionOutput(id: string, dispose: () => void) { output.set(id, dispose); }
export function disposeSessionOutput(id: string) { output.get(id)?.(); output.delete(id); }
export function forgetSession(id: string) { retained.delete(id); disposeSessionOutput(id); }

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && !/[\s\x00-\x1f]/.test(id);
}
/** Only teardown: native permits removing an exact session while access is revoked. */
async function disconnectCreatedSession(id: string) {
  if (!validId(id)) throw new Error('Invalid pending session identity.');
  if (retained.has(id)) return;
  disposeSessionOutput(id);
  await invoke(id.startsWith('local:') ? 'local_disconnect' : 'disconnect', { sessionId: id });
}
const creationMethods = new Set(['connect', 'local_connect', 'connect_mosh', 'connect_et', 'attach_tmux',
  'attach_multiplexer', 'attachDefaultMultiplexer', 'connectLocal', 'connectMosh', 'connectEt', 'attachTmux', 'attachMultiplexer']);
/** A successfully serialized creation result can arrive after its renderer lease was revoked. */
export async function disposeStaleSessionResult(method: PropertyKey, value: unknown) {
  if (typeof method !== 'string' || !creationMethods.has(method) || !value || typeof value !== 'object') return;
  const id = (value as { sessionId?: unknown }).sessionId;
  if (validId(id)) await disconnectCreatedSession(id);
}

/** IDs enter only after native creation and leave on adoption; retained terminals are never owned here. */
export class PendingSessions {
  private readonly ids = new Set<string>();
  private readonly closing = new Map<string, Promise<void>>();
  add(id: string) { if (!validId(id)) throw new Error('Invalid pending session identity.'); this.ids.add(id); }
  delete(id: string) { return this.ids.delete(id); }
  clear() { this.ids.clear(); }
  [Symbol.iterator]() { return this.ids[Symbol.iterator](); }
  close(id: string): Promise<void> {
    const existing = this.closing.get(id); if (existing) return existing;
    if (!this.ids.delete(id)) return Promise.resolve();
    const pending = disconnectCreatedSession(id).finally(() => this.closing.delete(id));
    this.closing.set(id, pending); return pending;
  }
  async closeAll() { await Promise.all([...this.ids].map(id => this.close(id))); }
}

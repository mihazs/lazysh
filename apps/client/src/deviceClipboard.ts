import { isTauri } from '@tauri-apps/api/core';
import { useSyncExternalStore } from 'react';
import { api } from './bridge';
import { captureAccess, subscribeAccess, type AccessLease } from './access';
import { ATTACHMENT_LIMIT, imageSize } from './attachment';
import { LocalUiError } from './i18n/localError';

type Kind = 'text' | 'image';
type PlatformPhase = 'unknown' | 'loading' | 'ready' | 'error';
let platform: { lease: AccessLease; phase: PlatformPhase; android?: boolean; pending?: Promise<void> } | undefined;
const platformListeners = new Set<() => void>();
const publishPlatform = () => { for (const listener of platformListeners) listener(); };
function platformPhase(): PlatformPhase {
  return !isTauri() ? 'ready' : platform?.lease.current() ? platform.phase : 'unknown';
}
/** Metadata only: finish before the gesture so browser clipboard APIs keep its activation. */
export function prepareClipboardPlatform(): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (platform?.lease.current() && (platform.phase === 'ready' || platform.phase === 'loading')) return platform.pending ?? Promise.resolve();
  const record = { lease: captureAccess(), phase: 'loading' as PlatformPhase, android: undefined as boolean | undefined, pending: undefined as Promise<void> | undefined };
  platform = record;
  record.pending = (async () => {
    try {
      record.lease.assert();
      const android = await api.clipboardIsAndroid();
      record.lease.assert();
      if (typeof android !== 'boolean') throw new Error();
      record.android = android; record.phase = 'ready';
    } catch { record.phase = 'error'; }
    finally { if (platform === record) publishPlatform(); }
  })();
  publishPlatform();
  return record.pending;
}
export function useClipboardPlatform() {
  const phase = useSyncExternalStore(listener => {
    platformListeners.add(listener); const stop = subscribeAccess(listener);
    return () => { platformListeners.delete(listener); stop(); };
  }, platformPhase, platformPhase);
  return { phase, retry: prepareClipboardPlatform };
}
function nativePlatform(lease: AccessLease, signal: AbortSignal): boolean {
  current(lease, signal);
  if (!isTauri()) return false;
  if (platform?.lease.current() && platform.phase === 'ready' && typeof platform.android === 'boolean') return platform.android;
  throw new LocalUiError('terminalPasteUnavailable');
}
function current(lease: AccessLease, signal: AbortSignal) {
  lease.assert();
  if (signal.aborted) throw new LocalUiError('terminalPasteUnavailable');
}
export type ClipboardPayload = { kind: 'text'; text: string } | { kind: 'image'; mime: 'image/png' | 'image/jpeg'; bytes: string };
export function checkPasteSize(text: string, bracketed = false) {
  if (new TextEncoder().encode(text).length + (bracketed ? 12 : 0) > 65536) throw new LocalUiError('terminalPasteUnavailable');
}
function parsePayload(value: unknown, kind: Kind): ClipboardPayload {
  if (!value || typeof value !== 'object') throw new LocalUiError('terminalPasteUnavailable');
  const v = value as Record<string, unknown>;
  if (v.kind === 'text' && kind === 'text' && Object.keys(v).length === 2 && typeof v.text === 'string') {
    checkPasteSize(v.text); return { kind: 'text', text: v.text };
  }
  if (v.kind === 'image' && kind === 'image' && Object.keys(v).length === 3
    && (v.mime === 'image/png' || v.mime === 'image/jpeg') && typeof v.bytes === 'string'
    && v.bytes.length > 0 && v.bytes.length <= Math.ceil(ATTACHMENT_LIMIT / 3) * 4
    && v.bytes.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(v.bytes)) {
    return { kind: 'image', mime: v.mime, bytes: v.bytes };
  }
  throw new LocalUiError('attachmentClipboardImagesUnavailable');
}
async function readNative(kind: Kind, signal: AbortSignal): Promise<ClipboardPayload> {
  const lease = captureAccess();
  current(lease, signal);
  const token = crypto.randomUUID();
  const cancel = () => { void api.clipboardCancel(token).catch(() => {}); };
  const stop = subscribeAccess(() => { if (!lease.current()) cancel(); });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const value = await api.clipboardRead({ token, kind });
    current(lease, signal);
    return parsePayload(value, kind);
  } catch {
    lease.assert();
    throw new LocalUiError(kind === 'text' ? 'terminalPasteUnavailable' : 'attachmentClipboardImagesUnavailable');
  } finally {
    signal.removeEventListener('abort', cancel); stop();
  }
}
export async function readClipboardText(signal: AbortSignal): Promise<string> {
  const lease = captureAccess();
  if (!nativePlatform(lease, signal)) {
    const text = await navigator.clipboard.readText();
    current(lease, signal); return text;
  }
  const native = await readNative('text', signal);
  current(lease, signal);
  if (native.kind !== 'text') throw new LocalUiError('terminalPasteUnavailable');
  return native.text;
}
export async function readClipboardImage(signal: AbortSignal): Promise<File> {
  const lease = captureAccess();
  let blob: Blob;
  if (nativePlatform(lease, signal)) {
    const native = await readNative('image', signal);
    current(lease, signal);
    if (native.kind !== 'image') throw new LocalUiError('attachmentClipboardImagesUnavailable');
    const bytes = Uint8Array.from(atob(native.bytes), byte => byte.charCodeAt(0));
    if (bytes.length > ATTACHMENT_LIMIT || imageSize(bytes)?.mime !== native.mime) throw new LocalUiError('attachmentTypeMismatch');
    blob = new Blob([bytes], { type: native.mime });
  } else {
    if (!navigator.clipboard?.read) throw new LocalUiError('attachmentClipboardImagesUnavailable');
    const items = await navigator.clipboard.read();
    current(lease, signal);
    const item = items.find(value => value.types.includes('image/png') || value.types.includes('image/jpeg'));
    if (!item) throw new LocalUiError('attachmentClipboardEmpty');
    blob = await item.getType(item.types.includes('image/png') ? 'image/png' : 'image/jpeg');
    current(lease, signal);
  }
  return new File([blob], `clipboard-${Date.now()}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type });
}

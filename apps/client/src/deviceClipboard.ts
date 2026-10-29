import { isTauri } from '@tauri-apps/api/core';
import { api } from './bridge';
import { captureAccess, subscribeAccess } from './access';
import { ATTACHMENT_LIMIT, imageSize } from './attachment';
import { LocalUiError } from './i18n/localError';

type Kind = 'text' | 'image';
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
async function readNative(kind: Kind, signal: AbortSignal): Promise<ClipboardPayload | null> {
  if (!isTauri()) return null;
  const lease = captureAccess();
  lease.assert();
  // An unsupported platform is the only route to browser fallback.
  if (!await api.clipboardIsAndroid()) return null;
  lease.assert();
  if (signal.aborted) throw new LocalUiError('terminalPasteUnavailable');
  const token = crypto.randomUUID();
  const cancel = () => { void api.clipboardCancel(token).catch(() => {}); };
  const stop = subscribeAccess(() => { if (!lease.current()) cancel(); });
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const value = await api.clipboardRead({ token, kind });
    lease.assert();
    if (signal.aborted) throw new LocalUiError('terminalPasteUnavailable');
    return parsePayload(value, kind);
  } catch {
    lease.assert();
    throw new LocalUiError(kind === 'text' ? 'terminalPasteUnavailable' : 'attachmentClipboardImagesUnavailable');
  } finally {
    signal.removeEventListener('abort', cancel); stop();
  }
}
export async function readClipboardText(signal: AbortSignal): Promise<string> {
  if (!isTauri()) return navigator.clipboard.readText();
  const native = await readNative('text', signal);
  if (native) {
    if (native.kind !== 'text') throw new LocalUiError('terminalPasteUnavailable');
    return native.text;
  }
  return navigator.clipboard.readText();
}
export async function readClipboardImage(signal: AbortSignal): Promise<File> {
  const native = await readNative('image', signal);
  let blob: Blob;
  if (native) {
    if (native.kind !== 'image') throw new LocalUiError('attachmentClipboardImagesUnavailable');
    const bytes = Uint8Array.from(atob(native.bytes), byte => byte.charCodeAt(0));
    if (bytes.length > ATTACHMENT_LIMIT || imageSize(bytes)?.mime !== native.mime) throw new LocalUiError('attachmentTypeMismatch');
    blob = new Blob([bytes], { type: native.mime });
  } else {
    if (!navigator.clipboard?.read) throw new LocalUiError('attachmentClipboardImagesUnavailable');
    const items = await navigator.clipboard.read();
    const item = items.find(value => value.types.includes('image/png') || value.types.includes('image/jpeg'));
    if (!item) throw new LocalUiError('attachmentClipboardEmpty');
    blob = await item.getType(item.types.includes('image/png') ? 'image/png' : 'image/jpeg');
  }
  return new File([blob], `clipboard-${Date.now()}.${blob.type === 'image/png' ? 'png' : 'jpg'}`, { type: blob.type });
}

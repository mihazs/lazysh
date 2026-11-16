import {LocalUiError} from '../i18n/localError';

/**
 * One answer to `host_browser_next` (docs/host-browser.md, "App bridge"): `0` alone is nothing, `1` and a JSON
 * object, or `2` and a frame (`sequence:u32be width:u16be height:u16be scrollY:f32be timestampMs:u64be`, then the
 * JPEG). The app already validated every field; they are read again here because the web view is the last
 * boundary before the page's text reaches the screen.
 */
export type RelayMessage =
  | {kind: 'idle'}
  | {kind: 'state'; run: 'running' | 'paused'}
  | {kind: 'page'; title: string; url: string}
  | {kind: 'refused'; reason: string; count: number}
  | {kind: 'closed'; reason: string; detail?: string}
  | {kind: 'frame'; sequence: number; width: number; height: number; scrollY: number; timestampMs: number; jpeg: Uint8Array};

const HEADER = 20;
const MAX_TITLE = 512;
const MAX_URL = 2048;
const MAX_DETAIL = 256;
const invalid = () => new LocalUiError('hostBrowserInvalidMessage');
const text = (value: unknown, most: number) => typeof value === 'string' && [...value].length <= most;

export function decodeRelayMessage(answer: ArrayBuffer | Uint8Array | number[]): RelayMessage {
  const bytes = answer instanceof Uint8Array ? answer : new Uint8Array(answer);
  if (bytes.length === 1 && bytes[0] === 0) return {kind: 'idle'};
  if (bytes[0] === 2) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    if (bytes.length <= 1 + HEADER || view.getUint16(5) === 0 || view.getUint16(7) === 0) throw invalid();
    return {kind: 'frame', sequence: view.getUint32(1), width: view.getUint16(5), height: view.getUint16(7), scrollY: view.getFloat32(9),
      timestampMs: Number(view.getBigUint64(13)), jpeg: bytes.subarray(1 + HEADER)};
  }
  if (bytes[0] !== 1) throw invalid();
  let value: Record<string, unknown>;
  try { value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(1))); } catch { throw invalid(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  switch (value.type) {
    case 'state':
      if (value.state !== 'running' && value.state !== 'paused') throw invalid();
      return {kind: 'state', run: value.state};
    case 'page':
      if (!text(value.title, MAX_TITLE) || !text(value.url, MAX_URL)) throw invalid();
      return {kind: 'page', title: value.title as string, url: value.url as string};
    case 'refused':
      if (typeof value.reason !== 'string' || !Number.isSafeInteger(value.count) || (value.count as number) < 1) throw invalid();
      return {kind: 'refused', reason: value.reason, count: value.count as number};
    case 'closed':
      if (typeof value.reason !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(value.reason)
        || (value.detail !== undefined && !text(value.detail, MAX_DETAIL))) throw invalid();
      return {kind: 'closed', reason: value.reason, ...value.detail === undefined ? {} : {detail: value.detail as string}};
    // A later relay may add messages; the app already skips what it does not know.
    default: return {kind: 'idle'};
  }
}

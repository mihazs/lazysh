import {LocalUiError} from './i18n/localError';

/** Current-file raster previews read at most this many bytes, matching the native reader. */
export const IMAGE_PREVIEW_LIMIT = 2 * 1024 * 1024;
/** Video and audio previews read at most this many bytes, matching the native reader. */
export const MEDIA_PREVIEW_LIMIT = 8 * 1024 * 1024;
const rasterTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const mediaTypes = {
  video: ['video/mp4', 'video/webm'],
  audio: ['audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/flac', 'audio/wav'],
} as const;
const extensions = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
  video: ['mp4', 'm4v', 'webm'],
  audio: ['mp3', 'm4a', 'ogg', 'oga', 'opus', 'wav', 'flac'],
  pdf: ['pdf'],
} as const;

export type MediaKind = keyof typeof mediaTypes;
export type PreviewKind = 'image' | MediaKind | 'pdf' | 'svg' | 'markdown' | 'text';
/** Chooses a viewer by file name; content is still validated after reading. */
export function previewKind(path: string): PreviewKind {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  for (const kind of ['image', 'video', 'audio', 'pdf'] as const) if (extension && (extensions[kind] as readonly string[]).includes(extension)) return kind;
  if (extension === 'svg') return 'svg';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return 'text';
}

/** Whether the host file can be read as text: images, video, audio and PDF are not. */
export const viewsAsText = (path: string) => ['svg', 'markdown', 'text'].includes(previewKind(path));

/** Validates a native sniffed-image response and returns an inert data URL. */
export function imageUrl(value: unknown): string {
  if (!value || typeof value !== 'object') throw new LocalUiError('repoInvalid');
  const {mime, data} = value as {mime?: unknown; data?: unknown};
  if (typeof mime !== 'string' || !rasterTypes.includes(mime) || !Array.isArray(data) || data.length > IMAGE_PREVIEW_LIMIT
    || data.some(n => !Number.isInteger(n) || n < 0 || n > 255)) throw new LocalUiError('repoInvalid');
  let binary = '';
  for (let offset = 0; offset < data.length; offset += 16384) binary += String.fromCharCode(...(data.slice(offset, offset + 16384) as number[]));
  return `data:${mime};base64,${btoa(binary)}`;
}

/** The file as an isolated player's input: a sniffed type and its base64 bytes, never the host's own claim. */
export type MediaClip = Readonly<{kind: MediaKind; mime: string; data: string}>;
/** Validates a native sniffed video or audio response: an allowed type for the kind and bounded, well-formed base64. */
export function mediaClip(value: unknown, kind: MediaKind): MediaClip {
  if (!value || typeof value !== 'object') throw new LocalUiError('repoInvalid');
  const {mime, data} = value as {mime?: unknown; data?: unknown};
  if (typeof mime !== 'string' || !(mediaTypes[kind] as readonly string[]).includes(mime) || typeof data !== 'string'
    || data.length > Math.ceil(MEDIA_PREVIEW_LIMIT / 3) * 4) throw new LocalUiError('repoInvalid');
  try { if (atob(data).length > MEDIA_PREVIEW_LIMIT) throw new Error('oversized'); } catch { throw new LocalUiError('repoInvalid'); }
  return {kind, mime, data};
}

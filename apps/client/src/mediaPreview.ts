import {LocalUiError} from './i18n/localError';

/** Current-file raster previews read at most this many bytes, matching the native reader. */
export const IMAGE_PREVIEW_LIMIT = 2 * 1024 * 1024;
const rasterTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export type PreviewKind = 'image' | 'svg' | 'markdown' | 'text';
/** Chooses a viewer by file name; content is still validated after reading. */
export function previewKind(path: string): PreviewKind {
  const extension = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase();
  if (extension && ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(extension)) return 'image';
  if (extension === 'svg') return 'svg';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  return 'text';
}

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

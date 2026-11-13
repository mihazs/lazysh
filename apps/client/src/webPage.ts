import { native } from './bridge';

/** Opens an HTTPS page in the system browser in the native app, or a new browser tab on the web. */
export function openWebPage(openNative: (url: string) => Promise<void>, url: string): Promise<void> {
  if (native) return openNative(url);
  window.open(url, '_blank', 'noopener,noreferrer');
  return Promise.resolve();
}

/** A web link that is safe to hand to the system browser: http(s), no credentials, no control characters. */
export function webUrl(value: string): string | undefined {
  if (value.length > 4096 || /[\s\x00-\x1f\x7f-\x9f\\]/.test(value) || !/^https?:\/\//i.test(value)) return;
  const authority = value.split('://')[1].split(/[/?#]/)[0];
  if (!authority || authority.includes('@')) return;
  try {
    const url = new URL(value);
    if (url.hostname && !url.username && !url.password && url.href.length <= 4096) return url.href;
  } catch { /* Ignore malformed remote links. */ }
}

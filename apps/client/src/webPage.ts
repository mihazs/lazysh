import { native } from './bridge';

/** Opens an HTTPS page in the system browser in the native app, or a new browser tab on the web. */
export function openWebPage(openNative: (url: string) => Promise<void>, url: string): Promise<void> {
  if (native) return openNative(url);
  window.open(url, '_blank', 'noopener,noreferrer');
  return Promise.resolve();
}

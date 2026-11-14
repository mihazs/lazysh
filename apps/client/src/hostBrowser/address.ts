/**
 * Addresses for the host browser (docs/host-browser.md, "Controls"): what a person may type, and what "Open on this
 * device" does with the page that is showing. The relay applies the same rule again on the host, so this is the
 * friendly first check, not the only one.
 */
const MAX_ADDRESS = 2048;

export type AddressRefusal = { reason: 'empty' | 'invalid' | 'tooLong' } | { reason: 'scheme'; scheme: string };
export type Address = { ok: true; url: string } | { ok: false; refusal: AddressRefusal };

const refuse = (refusal: AddressRefusal): Address => ({ ok: false, refusal });
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
export const isLoopback = (url: URL) => loopbackHosts.has(url.hostname);

/**
 * A typed address becomes an `http` or `https` URL, or `about:blank`, or is refused with a reason. A string without
 * a scheme becomes `https://`, except a loopback host, which becomes `http://` because a development server rarely
 * speaks TLS. `host:port` is an address, not a scheme.
 */
export function normalizeAddress(input: string): Address {
  const text = input.trim();
  if (!text) return refuse({ reason: 'empty' });
  if (text.length > MAX_ADDRESS) return refuse({ reason: 'tooLong' });
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1].toLowerCase();
  const hostAndPort = /^[^/?#:]+:\d+(?:[/?#]|$)/.test(text);
  if (scheme && !hostAndPort) {
    if (scheme === 'about') return text.toLowerCase() === 'about:blank' ? { ok: true, url: 'about:blank' } : refuse({ reason: 'scheme', scheme });
    if (scheme !== 'http' && scheme !== 'https') return refuse({ reason: 'scheme', scheme: scheme.slice(0, 32) });
  }
  let url: URL;
  try {
    if (scheme && !hostAndPort) url = new URL(text);
    else {
      url = new URL(`https://${text.replace(/^\/\//, '')}`);
      if (isLoopback(url)) url = new URL(`http://${text.replace(/^\/\//, '')}`);
    }
  } catch { return refuse({ reason: 'invalid' }); }
  // The parser strips tabs and newlines inside a scheme, so the result is checked, not only the typed text.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return refuse({ reason: 'scheme', scheme: url.protocol.slice(0, -1) });
  return url.href.length > MAX_ADDRESS ? refuse({ reason: 'tooLong' }) : { ok: true, url: url.href };
}

export type DeviceOpen =
  | { kind: 'preview'; port: number; address: '127.0.0.1' | '::1'; path: string }
  | { kind: 'external'; host: string; url: string };

/**
 * What "Open on this device" does with the address of the page that is showing: a loopback address on the host is
 * reached through the existing Preview forward, any other address opens in the device's own browser after a
 * confirmation that names `host`. `undefined` for a page that is not on the web (`about:blank`).
 */
export function openOnDevice(address: string): DeviceOpen | undefined {
  let url: URL;
  try { url = new URL(address); } catch { return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!isLoopback(url)) return { kind: 'external', host: url.hostname, url: url.href };
  return {
    kind: 'preview', port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    // shortcut: `localhost` is forwarded as IPv4, so a server bound only to ::1 needs the address typed as [::1].
    address: url.hostname === '[::1]' ? '::1' : '127.0.0.1', path: `${url.pathname}${url.search}${url.hash}`,
  };
}

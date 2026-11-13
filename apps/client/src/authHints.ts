/**
 * A sign-in the host started: its command printed an address whose callback is `localhost` on the host
 * (#1510). The native scanner finds it in the terminal output and sends it with the terminal's events;
 * `App` announces it here as a window event, the way other session changes are announced. A hint is a
 * sighting only. It starts no tunnel and opens nothing. It never carries the query of the URL, so no
 * `code`, `state` or `login_hint` is here.
 */
export type AuthHint = {
  id: string;
  /** `url` and `osc8` read the authorize URL; `announcement` is a bare `http://localhost:PORT` on a sign-in line. */
  source: 'url' | 'osc8' | 'announcement';
  host: 'localhost' | '127.0.0.1' | '[::1]';
  /** 1024 to 65535. */
  port: number;
  /** The callback path, without a query. */
  path: string;
  /** Host of the authorize URL, when there is one. */
  idpHost?: string;
  pkce: boolean;
  /** A database, cache, remote access or admin port: only ever tunnelled when the user names it. */
  sensitive: boolean;
  firstSeenAt: string;
};
export type AuthHintDetail = { sessionId: string; hint: AuthHint };

export const AUTH_HINT_EVENT = 'lazysh-auth-hint';

export function announceAuthHint(detail: AuthHintDetail) {
  window.dispatchEvent(new CustomEvent<AuthHintDetail>(AUTH_HINT_EVENT, { detail }));
}
/** Calls `handler` for every hint of every session until the returned function runs. */
export function onAuthHint(handler: (detail: AuthHintDetail) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<AuthHintDetail>).detail);
  window.addEventListener(AUTH_HINT_EVENT, listener);
  return () => window.removeEventListener(AUTH_HINT_EVENT, listener);
}

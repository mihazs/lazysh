/** What a host companion that is older than this app says about updating itself to this app's version:
 * `update` in its `snapshot` reply (docs/reference/companion-update.md). A companion that predates it sends none. */
export type CompanionUpdate = Readonly<{state: 'started' | 'running' | 'done' | 'failed' | 'skipped'; from: string; to: string; reason?: string}>;

const states = ['started', 'running', 'done', 'failed', 'skipped'] as const;
const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
/** Sent on `window` when a host's companion has been updated, so open views ask it again instead of waiting. */
export const companionUpdatedEvent = 'lazysh-companion-updated';

/** The `update` field of a snapshot reply. A malformed one is ignored: it never hides the board. */
export function parseCompanionUpdate(snapshot: unknown): CompanionUpdate | undefined {
  const value = snapshot && typeof snapshot === 'object' ? (snapshot as {update?: unknown}).update : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const {state, from, to, reason} = value as Record<string, unknown>;
  if (!states.includes(state as never) || typeof from !== 'string' || !version.test(from) || typeof to !== 'string' || !version.test(to)) return undefined;
  if (reason !== undefined && (typeof reason !== 'string' || !/^[A-Za-z]{1,40}$/.test(reason))) return undefined;
  return {state: state as CompanionUpdate['state'], from, to, ...(reason === undefined ? {} : {reason})};
}

/** The message a row shows, or none when there is nothing the user can act on or wait for. */
export function companionUpdateRow(update: CompanionUpdate): 'running' | 'done' | 'failed' | 'verification' | 'off' | 'waiting' | undefined {
  switch (update.state) {
    case 'started': case 'running': return 'running';
    case 'done': return 'done';
    case 'failed': return update.reason === 'verificationFailed' ? 'verification' : 'failed';
    case 'skipped': return update.reason === 'policyOff' || update.reason === 'policyNotify' ? 'off' : update.reason === 'activeTurn' ? 'waiting' : undefined;
  }
}

/** Strict `X.Y.Z` comparison: a negative number when `a` is older than `b`; `undefined` unless both parse. */
export function compareVersions(a: string, b: string): number | undefined {
  if (!version.test(a) || !version.test(b)) return undefined;
  const [x, y] = [a, b].map(value => value.split('.').map(Number));
  return x.map((part, index) => part - y[index]).find(difference => difference !== 0) ?? 0;
}

/** What the user decided, once, for a host whose companion cannot update itself. `undefined` is "ask". */
export type Consent = 'always' | 'never';
const consentKey = 'lazysh.companion-update-consent.v1';
export const consentEvent = 'lazysh-companion-consent';
function readConsents(): Record<string, Consent> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(consentKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([host, choice]) => host.length <= 256 && (choice === 'always' || choice === 'never'))) as Record<string, Consent>;
  } catch { return {}; }
}
export function readConsent(host: string): Consent | undefined { return readConsents()[host]; }
export function writeConsent(host: string, choice: Consent | undefined) {
  try {
    const all = readConsents();
    if (choice) all[host] = choice; else delete all[host];
    const entries = Object.entries(all).slice(-200);
    localStorage.setItem(consentKey, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* A browser without storage asks again next time. */ }
  window.dispatchEvent(new CustomEvent(consentEvent, {detail: {host}}));
}

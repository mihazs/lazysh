import {useSyncExternalStore} from 'react';
import {deviceSettingSubscriber} from './deviceSetting';

/**
 * What the user decided about host sign-ins (#1514): Ask (the default), Always or Never, per host, with a default
 * for hosts that have no choice of their own. Device-local on purpose: the choice is about what this device lets a
 * host do, so sync never carries it. It holds host ids and three words, never a URL or a port.
 */
export type AuthChoice = 'ask' | 'always' | 'never';
/** Each kind of host request has its own choice. */
export type AuthPolicyKind = 'tunnel';
export const authChoices: readonly AuthChoice[] = ['ask', 'always', 'never'];

type Stored = {defaults: Partial<Record<AuthPolicyKind, AuthChoice>>; hosts: Record<string, Partial<Record<AuthPolicyKind, AuthChoice>>>};
export const authPolicyKey = 'lazysh.auth.policy.v1';
const changed = 'lazysh-auth-policy';
const kinds: readonly AuthPolicyKind[] = ['tunnel'];
const maxHosts = 200;
const empty = (): Stored => ({defaults: {}, hosts: {}});
const none = empty();
/** The latest choices while storage refuses them: they hold until the app restarts. */
let unsaved: Stored | undefined;
let cached: {raw: string | null; value: Stored} | undefined;

const isChoice = (value: unknown): value is AuthChoice => authChoices.some(choice => choice === value);
function choices(value: unknown): Partial<Record<AuthPolicyKind, AuthChoice>> {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(kinds.flatMap(kind => {
    const choice = (value as Record<string, unknown>)[kind];
    return isChoice(choice) ? [[kind, choice]] : [];
  }));
}
/** Anything that is not exactly this shape is dropped, so a damaged or hand-edited value can only mean Ask. */
export function parseAuthPolicy(value: unknown): Stored {
  if (!value || typeof value !== 'object') return empty();
  const {defaults, hosts} = value as {defaults?: unknown; hosts?: unknown};
  const parsed = empty();
  parsed.defaults = choices(defaults);
  if (hosts && typeof hosts === 'object') {
    for (const [id, entry] of Object.entries(hosts).slice(0, maxHosts)) {
      const own = choices(entry);
      if (id && id.length <= 128 && Object.keys(own).length) parsed.hosts[id] = own;
    }
  }
  return parsed;
}
function read(): Stored {
  if (unsaved) return unsaved;
  let raw: string | null = null;
  try { raw = localStorage.getItem(authPolicyKey) ?? null; } catch { return none; }
  if (cached && cached.raw === raw) return cached.value;
  let value = empty();
  try { value = parseAuthPolicy(raw === null ? null : JSON.parse(raw)); } catch { /* A damaged value is Ask everywhere. */ }
  cached = {raw, value};
  return value;
}
function write(next: Stored) {
  try { localStorage.setItem(authPolicyKey, JSON.stringify(next)); unsaved = undefined; } catch { unsaved = next; }
  window.dispatchEvent(new Event(changed));
}

/** The choice for `kind` on this host: its own, else the default, else Ask. */
export function authChoice(hostId: string, kind: AuthPolicyKind): AuthChoice {
  const stored = read();
  return stored.hosts[hostId]?.[kind] ?? stored.defaults[kind] ?? 'ask';
}
export const defaultAuthChoice = (kind: AuthPolicyKind): AuthChoice => read().defaults[kind] ?? 'ask';
/** The host's own choice, when it has one; `undefined` follows the default. */
export const ownAuthChoice = (hostId: string, kind: AuthPolicyKind): AuthChoice | undefined => read().hosts[hostId]?.[kind];

export function setDefaultAuthChoice(kind: AuthPolicyKind, choice: AuthChoice) {
  const stored = read();
  write({...stored, defaults: {...stored.defaults, [kind]: choice}});
}
/** `undefined` removes the host's own choice, so it follows the default again. */
export function setHostAuthChoice(hostId: string, kind: AuthPolicyKind, choice: AuthChoice | undefined) {
  const stored = read();
  const own = {...stored.hosts[hostId]};
  if (choice) own[kind] = choice; else delete own[kind];
  const hosts = {...stored.hosts};
  if (Object.keys(own).length) hosts[hostId] = own; else delete hosts[hostId];
  write({...stored, hosts});
}
const subscribe = deviceSettingSubscriber(changed);
export function useAuthPolicy() { return useSyncExternalStore(subscribe, read, () => none); }

const introKey = 'lazysh.auth.intro.v1';
let introDone = false;
/** The first detected sign-in carries a short explanation; once any answer is given it never comes back. */
export function authIntroSeen() { try { return introDone || localStorage.getItem(introKey) === '1'; } catch { return introDone; } }
export function markAuthIntroSeen() { introDone = true; try { localStorage.setItem(introKey, '1'); } catch { /* It shows again next run. */ } }

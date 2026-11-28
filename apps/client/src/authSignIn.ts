import {useMemo, useSyncExternalStore} from 'react';
import {accessSnapshot, captureAccess, StaleAccessError, subscribeAccess} from './access';
import {countBlockedAuth, recordAuth, updateAuth, type AuditDecision, type AuditOutcome} from './authAudit';
import type {AuthHint} from './authHints';
import {checkAuthListener, confirmHint, type ConfirmOptions, type ListenerVerdict} from './authListeners';
import {authChoice, setHostAuthChoice} from './authPolicy';
import {api, type AuthTunnelConsent, type AuthTunnelEndReason, type AuthTunnelEvent, type AuthTunnelHint} from './bridge';
import {LocalUiError} from './i18n/localError';

/**
 * The consent and lifecycle of host sign-ins (#1514, ADR 0004). A hint the terminal scanner found becomes a request the
 * user answers, or that the host's saved choice answers; only an answer starts a tunnel. Nothing here keeps an address:
 * a request holds a port, a callback path and the identity provider's host, never a query, `code` or `state`.
 */
export type SignInPhase = 'asking' | 'starting' | 'active' | 'ended' | 'failed' | 'blocked';
export type SignInRequest = {
  key: string;
  sessionId: string;
  hostId: string;
  hostName: string;
  hint: AuthHint;
  phase: SignInPhase;
  /** What asking the host about the port found; `unknown` when the question could not be asked. */
  listener: 'checking' | ListenerVerdict['state'] | 'unknown';
  /** The listener belongs to another user of the host (NetBird's daemon): never "Always". */
  otherUser: boolean;
  /** A request waits out its listener check unseen when the answer decides whether anyone is asked at all. */
  visible: boolean;
  /** Started by the host's saved Always, with nobody asked. */
  automatic: boolean;
  /** The host received the callback request. */
  callback: boolean;
  /** An unanswered request shrinks to one line after a minute. */
  collapsed: boolean;
  tunnelId?: string;
  reason?: AuthTunnelEndReason;
  /** The engine's error kind when the start failed. */
  failure?: string;
  /** The raw message for an error kind this client has no sentence for. */
  detail?: string;
  auditId?: number;
};
export type SignInContext = {sessionId: string; hostId: string; hostName: string};
export type SignInDeps = {
  start: (sessionId: string, hint: AuthTunnelHint, consent: AuthTunnelConsent, onEvent: (event: AuthTunnelEvent) => void) => Promise<{id: string}>;
  stop: (sessionId: string, tunnelId: string) => Promise<void>;
  check: (sessionId: string, port: number, seenSecondsAgo: number) => Promise<ListenerVerdict>;
  inspect: (url: string) => Promise<{callbackPorts: number[]}>;
  openAuth: (sessionId: string, url: string, tunnelId: string) => Promise<unknown>;
  openWeb: (url: string) => Promise<void>;
  confirm?: ConfirmOptions;
};

export const COLLAPSE_MS = 60_000;
export const EXPIRE_MS = 10 * 60_000;
export const DISMISS_MS = 8_000;
/** The engine allows four flows per session; a fifth hint is not a sign-in. */
export const MAX_PER_SESSION = 4;
const outcomes: Record<AuthTunnelEndReason, AuditOutcome> = {
  callbackDelivered: 'completed', timeout: 'timeout', cancelled: 'stopped', sessionEnded: 'stopped', lockEnded: 'stopped',
  hostStoppedListening: 'hostStopped', forwardingDisabled: 'noForwarding', controlConnectionLost: 'connectionLost',
};
const errorKind = (error: unknown) => error && typeof error === 'object' && 'kind' in error ? String(error.kind) : 'unknown';
const errorMessage = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : '';

/** A hint keeps only the fields below, so nothing a future scanner adds (a query, a `code`) can ride along into a request. */
const plainHint = (hint: AuthHint): AuthHint => ({id: hint.id, source: hint.source, host: hint.host, port: hint.port, path: hint.path, ...hint.idpHost === undefined ? {} : {idpHost: hint.idpHost}, pkce: hint.pkce, sensitive: hint.sensitive, firstSeenAt: hint.firstSeenAt});
/** `abort` ends everything for the request; `check` only the listener question, which an answer to the user cuts short. */
type Entry = {request: SignInRequest; abort: AbortController; check: AbortController; timers: Set<ReturnType<typeof setTimeout>>};
const fresh = (request: SignInRequest): Entry => ({request, abort: new AbortController(), check: new AbortController(), timers: new Set()});

export function createSignIn(deps: SignInDeps) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const told = new Set<string>();
  let snapshot: readonly SignInRequest[] = [];
  const publish = () => { snapshot = [...entries.values()].map(entry => entry.request); for (const listener of [...listeners]) listener(); };
  function update(key: string, patch: Partial<SignInRequest>) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.request = {...entry.request, ...patch};
    publish();
  }
  function later(key: string, ms: number, action: () => void) {
    const entry = entries.get(key);
    if (!entry) return;
    const timer = setTimeout(() => { entry.timers.delete(timer); if (entries.get(key) === entry) action(); }, ms);
    entry.timers.add(timer);
  }
  function remove(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    entry.abort.abort(); entry.check.abort();
    for (const timer of entry.timers) clearTimeout(timer);
    entries.delete(key);
    publish();
  }
  /** The row in the audit list appears the first time the user could see the request. */
  function audited(key: string, decision: AuditDecision) {
    const entry = entries.get(key);
    if (!entry) return;
    const {request} = entry;
    if (request.auditId === undefined) update(key, {auditId: recordAuth({hostName: request.hostName, port: request.hint.port, decision})});
    else updateAuth(request.auditId, {decision});
  }
  const finished = (key: string, outcome: AuditOutcome) => {
    const id = entries.get(key)?.request.auditId;
    if (id !== undefined) updateAuth(id, {outcome});
  };
  const tunnelHint = (request: SignInRequest): AuthTunnelHint => ({
    port: request.hint.port, path: request.hint.path, evidence: 'url', confirmed: request.listener === 'confirmed',
    owner: request.otherUser ? 'otherUser' : request.listener === 'confirmed' ? 'sessionUser' : 'unknown',
    ...request.hint.host === '[::1]' ? {family: 'v6' as const} : {},
  });

  function onEvent(key: string, event: AuthTunnelEvent) {
    if (!entries.has(key)) return;
    if (event.type === 'callback') return update(key, {callback: true});
    update(key, {phase: 'ended', reason: event.reason});
    finished(key, outcomes[event.reason]);
    later(key, DISMISS_MS, () => remove(key));
  }
  async function start(key: string, consent: AuthTunnelConsent, automatic: boolean) {
    const request = entries.get(key)?.request;
    if (!request) return;
    update(key, {phase: 'starting', automatic});
    try {
      const tunnel = await deps.start(request.sessionId, tunnelHint(request), consent, event => onEvent(key, event));
      const entry = entries.get(key);
      if (!entry || entry.abort.signal.aborted) return void deps.stop(request.sessionId, tunnel.id).catch(() => {});
      // The flow may already have ended: its end event can arrive before this answer.
      update(key, {tunnelId: tunnel.id, ...entry.request.phase === 'starting' ? {phase: 'active' as const} : {}});
    } catch (error) {
      if (!entries.has(key)) return;
      const kind = errorKind(error);
      if (error instanceof StaleAccessError) return remove(key);
      // The engine asks even under Always when the port is sensitive or the host started many flows lately.
      if (automatic && kind === 'auth_tunnel_consent_required') return update(key, {phase: 'asking', automatic: false, visible: true});
      update(key, {phase: 'failed', failure: kind, detail: errorMessage(error), visible: true});
      finished(key, 'failed');
    }
  }

  /** Asks the host whether it listens on the hint's port; under Always a confirmed answer is the whole consent. */
  async function confirm(key: string) {
    const entry = entries.get(key);
    if (!entry) return;
    const {sessionId, hint} = entry.request;
    const confirmation = await confirmHint(hint, (port, seenSecondsAgo) => deps.check(sessionId, port, seenSecondsAgo), {signal: entry.check.signal, ...deps.confirm}).catch(() => undefined);
    const current = entries.get(key);
    if (!current || current.abort.signal.aborted || current.request.phase !== 'asking') return;
    const {request} = current;
    // A bare announcement is only worth asking about once a listener proves it.
    if (request.hint.source === 'announcement' && confirmation?.state !== 'confirmed') return remove(key);
    const otherUser = confirmation?.listener?.ownedBySessionUser === false;
    update(key, {listener: confirmation?.state ?? 'unknown', otherUser, visible: true});
    const automatic = confirmation?.state === 'confirmed' && !request.hint.sensitive && !otherUser && authChoice(request.hostId, 'tunnel') === 'always';
    if (automatic) { audited(key, 'automatic'); return start(key, {kind: 'policy', policy: 'always'}, true); }
    audited(key, 'asked');
  }

  function blocked(context: SignInContext, hint: AuthHint) {
    countBlockedAuth();
    recordAuth({hostName: context.hostName, port: hint.port, decision: 'blocked', outcome: 'none'});
    // Silent apart from this, once per host and app run: a sign-in that cannot finish deserves one explanation.
    if (told.has(context.hostId)) return;
    told.add(context.hostId);
    const key = `${context.sessionId}:${hint.port}`;
    entries.set(key, fresh({key, ...context, hint, phase: 'blocked', listener: 'unknown', otherUser: false, visible: true, automatic: false, callback: false, collapsed: false}));
    publish();
    later(key, 30_000, () => remove(key));
  }

  const controller = {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => snapshot,
    /** A sign-in the scanner found on a session. A repeat of a request in progress only refreshes what it knows. */
    hint(context: SignInContext, sighting: AuthHint) {
      const hint = plainHint(sighting);
      const key = `${context.sessionId}:${hint.port}`;
      const known = entries.get(key);
      if (known) { if (known.request.phase === 'asking') update(key, {hint}); return; }
      if ([...entries.values()].filter(entry => entry.request.sessionId === context.sessionId).length >= MAX_PER_SESSION) return;
      const choice = authChoice(context.hostId, 'tunnel');
      if (choice === 'never') return blocked(context, hint);
      entries.set(key, fresh({key, ...context, hint, phase: 'asking', listener: 'checking', otherUser: false, visible: choice === 'ask' && hint.source !== 'announcement', automatic: false, callback: false, collapsed: false}));
      publish();
      if (entries.get(key)!.request.visible) audited(key, 'asked');
      later(key, COLLAPSE_MS, () => update(key, {collapsed: true}));
      later(key, EXPIRE_MS, () => { if (entries.get(key)?.request.phase === 'asking') { audited(key, 'expired'); finished(key, 'none'); remove(key); } });
      void confirm(key);
    },
    /** "Allow once" and, with `always`, "Always for this host". A sensitive port needs `confirmRisky`, and is never Always. */
    allow(key: string, options: {always?: boolean; confirmRisky?: boolean} = {}) {
      const request = entries.get(key)?.request;
      if (request?.phase !== 'asking' || (request.hint.sensitive && !options.confirmRisky)) return;
      const always = !!options.always && !request.hint.sensitive && !request.otherUser;
      entries.get(key)?.check.abort();
      if (always) setHostAuthChoice(request.hostId, 'tunnel', 'always');
      audited(key, always ? 'always' : 'allowed');
      void start(key, {kind: 'allow', confirmRisky: !!options.confirmRisky}, false);
    },
    deny(key: string) {
      if (entries.get(key)?.request.phase !== 'asking') return;
      audited(key, 'denied'); finished(key, 'none'); remove(key);
    },
    /** Ends a running tunnel; its end event shows the result. */
    stop(key: string) {
      const request = entries.get(key)?.request;
      if (request?.phase === 'active' && request.tunnelId) void deps.stop(request.sessionId, request.tunnelId).catch(() => {});
    },
    dismiss: remove,
    expand: (key: string) => update(key, {collapsed: false}),
    /** A failed start asks again, for example once the program holding the port has stopped. */
    retry(key: string) {
      if (entries.get(key)?.request.phase === 'failed') update(key, {phase: 'asking', failure: undefined, detail: undefined, collapsed: false});
    },
    /** Ends the requests of sessions that are no longer live: their tunnels end with the session natively. */
    retain(live: ReadonlySet<string>) {
      for (const [key, entry] of entries) if (!live.has(entry.request.sessionId)) { finished(key, entry.request.phase === 'active' ? 'stopped' : 'none'); remove(key); }
    },
    clear() { for (const key of [...entries.keys()]) remove(key); told.clear(); },
    /** Whether a tunnel for this port runs on this session, so a link that redirects to it can open. */
    isListening: (sessionId: string, port: number) => entries.get(`${sessionId}:${port}`)?.request.phase === 'active',
    /** The live flow of the tunnel listening on `port`, which the native opener binds the page to. */
    tunnelOf: (sessionId: string, port: number) => { const request = entries.get(`${sessionId}:${port}`)?.request; return request?.phase === 'active' ? request.tunnelId : undefined; },
    /**
     * Opens a link the user tapped in the terminal. A link whose sign-in redirects to the host's `localhost` opens in the
     * device browser only once its tunnel runs (the page would otherwise end on a dead port); any other link opens as before.
     */
    async openLink(sessionId: string, url: string) {
      if (sessionId.startsWith('local:')) return deps.openWeb(url);
      // An address the checker rejects still goes to the ordinary opener, which says why.
      const ports = (await Promise.resolve().then(() => deps.inspect(url)).catch(() => undefined))?.callbackPorts ?? [];
      if (!ports.length) return deps.openWeb(url);
      const waiting = ports.find(port => controller.tunnelOf(sessionId, port) === undefined);
      if (waiting !== undefined) throw new LocalUiError('authLinkNeedsTunnelValue1', String(waiting));
      await deps.openAuth(sessionId, url, controller.tunnelOf(sessionId, ports[0]!)!);
    },
  };
  return controller;
}

export const signIn = createSignIn({
  start: (sessionId, hint, consent, onEvent) => api.startAuthTunnel(sessionId, hint, consent, onEvent),
  stop: (sessionId, tunnelId) => api.stopAuthTunnel(sessionId, tunnelId),
  check: (sessionId, port, seenSecondsAgo) => checkAuthListener(captureAccess(), sessionId, port, seenSecondsAgo),
  inspect: url => api.inspectAuthUrl(url),
  openAuth: (sessionId, url, tunnelId) => api.openAuthUrl(sessionId, url, {tunnelId}),
  openWeb: url => api.openWebUrl(url),
});
// Locking the app ends every tunnel natively; nothing may stay on screen asking about it.
subscribeAccess(() => { const status = accessSnapshot().status; if (status && (!status.initialized || status.locked)) signIn.clear(); });

/** The requests the user can see for one session, in the order they arrived. */
export function useSignInRequests(sessionId: string) {
  const all = useSyncExternalStore(signIn.subscribe, signIn.snapshot, signIn.snapshot);
  return useMemo(() => all.filter(request => request.sessionId === sessionId && request.visible), [all, sessionId]);
}

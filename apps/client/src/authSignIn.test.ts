// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {AuthHint} from './authHints';
import {authAuditSnapshot, clearAuthAudit} from './authAudit';
import type {ListenerVerdict} from './authListeners';
import {authChoice, authPolicyKey, setDefaultAuthChoice, setHostAuthChoice} from './authPolicy';
import {COLLAPSE_MS, createSignIn, DISMISS_MS, EXPIRE_MS, MAX_PER_SESSION, type SignInRequest} from './authSignIn';
import type {AuthTunnelEvent} from './bridge';
import {LocalUiError} from './i18n/localError';

const hint = (port = 8085, extra: Partial<AuthHint> = {}): AuthHint => ({id: `hint-${port}`, source: 'url', host: 'localhost', port, path: '/oauth/callback', idpHost: 'idp.example', pkce: true, sensitive: false, firstSeenAt: new Date().toISOString(), ...extra});
const context = {sessionId: 'session-1', hostId: 'host-1', hostName: 'Build box'};
const confirmed: ListenerVerdict = {state: 'confirmed', listener: {source: 'companion', bind: 'loopback', ownedBySessionUser: true, ageSeconds: 2}};

function harness(verdict: ListenerVerdict | (() => ListenerVerdict) = confirmed) {
  const flows: {onEvent: (event: AuthTunnelEvent) => void}[] = [];
  // The listener question repeats every second for 30 s while the port is empty; this clock lets that pass at once.
  let clock = Date.now();
  const deps = {
    start: vi.fn(async (_session: string, _hint: unknown, _consent: unknown, onEvent: (event: AuthTunnelEvent) => void) => { flows.push({onEvent}); return {id: `tunnel-${flows.length}`}; }),
    stop: vi.fn(async () => {}),
    check: vi.fn(async () => typeof verdict === 'function' ? verdict() : verdict),
    inspect: vi.fn(async () => ({callbackPorts: [] as number[]})),
    openAuth: vi.fn(async () => 'opened'),
    openWeb: vi.fn(async () => {}),
    confirm: {now: () => clock, sleep: async (ms: number) => { clock += ms; }},
  };
  return {deps, flows, signIn: createSignIn(deps)};
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const only = (signIn: ReturnType<typeof harness>['signIn']): SignInRequest => { const [request] = signIn.snapshot(); return request; };

beforeEach(() => { localStorage.clear(); clearAuthAudit(); });
afterEach(() => { vi.useRealTimers(); });

it('asks first: a printed callback shows a request and starts nothing until the user allows', async () => {
  const {deps, signIn} = harness();
  signIn.hint(context, hint());
  await settle();
  expect(only(signIn)).toMatchObject({phase: 'asking', visible: true, listener: 'confirmed', otherUser: false});
  expect(deps.start).not.toHaveBeenCalled();
  signIn.allow(only(signIn).key);
  await settle();
  expect(deps.start).toHaveBeenCalledTimes(1);
  // The engine gets a port, a path and the user's answer; the evidence is the printed URL, never a bare listener.
  expect(deps.start.mock.calls[0].slice(0, 3)).toEqual(['session-1', {port: 8085, path: '/oauth/callback', evidence: 'url', confirmed: true, owner: 'sessionUser'}, {kind: 'allow', confirmRisky: false}]);
  expect(only(signIn)).toMatchObject({phase: 'active', tunnelId: 'tunnel-1'});
  expect(authChoice('host-1', 'tunnel')).toBe('ask');
});

it('a denied sign-in never starts a tunnel, opens a page or asks the host again about that port', async () => {
  const {deps, signIn} = harness();
  signIn.hint(context, hint());
  await settle();
  signIn.deny(only(signIn).key);
  await settle();
  expect(signIn.snapshot()).toEqual([]);
  expect(deps.start).not.toHaveBeenCalled();
  expect(deps.openAuth).not.toHaveBeenCalled();
  expect(deps.openWeb).not.toHaveBeenCalled();
  expect(authAuditSnapshot().entries).toMatchObject([{hostName: 'Build box', port: 8085, decision: 'denied', outcome: 'none'}]);
});

it('Always for this host remembers the host, starts the flow and then starts later flows by itself once the host confirms them', async () => {
  const {deps, signIn} = harness();
  signIn.hint(context, hint(8085));
  await settle();
  signIn.allow(only(signIn).key, {always: true});
  await settle();
  expect(authChoice('host-1', 'tunnel')).toBe('always');
  expect(authChoice('host-2', 'tunnel')).toBe('ask');
  expect(deps.start.mock.calls[0][2]).toEqual({kind: 'allow', confirmRisky: false});
  signIn.hint(context, hint(1455));
  await settle();
  expect(deps.start).toHaveBeenCalledTimes(2);
  expect(deps.start.mock.calls[1][1]).toMatchObject({port: 1455, confirmed: true});
  expect(deps.start.mock.calls[1][2]).toEqual({kind: 'policy', policy: 'always'});
  expect(signIn.snapshot().find(request => request.hint.port === 1455)).toMatchObject({phase: 'active', automatic: true, visible: true});
  expect(authAuditSnapshot().entries.map(row => row.decision)).toEqual(['automatic', 'always']);
});

it('Always still asks when the host has not confirmed the port, or the listener is another user\'s, or the port is sensitive', async () => {
  setHostAuthChoice('host-1', 'tunnel', 'always');
  for (const [verdict, extra] of [
    [{state: 'absent'} as ListenerVerdict, {}],
    [{state: 'stale', listener: confirmed.listener} as ListenerVerdict, {}],
    [{state: 'confirmed', listener: {...confirmed.listener!, ownedBySessionUser: false}} as ListenerVerdict, {}],
    [confirmed, {sensitive: true}],
  ] as const) {
    const {deps, signIn} = harness(verdict);
    signIn.hint(context, hint(5432, extra));
    await settle();
    expect(only(signIn)).toMatchObject({phase: 'asking', visible: true});
    expect(deps.start).not.toHaveBeenCalled();
  }
});

it('falls back to asking when the engine asks even though the policy says Always', async () => {
  setHostAuthChoice('host-1', 'tunnel', 'always');
  const {deps, signIn} = harness();
  deps.start.mockRejectedValueOnce({kind: 'auth_tunnel_consent_required', message: 'Ask the user first'});
  signIn.hint(context, hint());
  await settle();
  expect(only(signIn)).toMatchObject({phase: 'asking', automatic: false, visible: true});
  signIn.allow(only(signIn).key);
  await settle();
  expect(only(signIn).phase).toBe('active');
});

it('Never keeps a denied host silent: no request, no listener question, no tunnel, one explanation per host', async () => {
  setHostAuthChoice('host-1', 'tunnel', 'never');
  const {deps, signIn} = harness();
  signIn.hint(context, hint(8085));
  signIn.hint(context, hint(1455));
  await settle();
  expect(deps.check).not.toHaveBeenCalled();
  expect(deps.start).not.toHaveBeenCalled();
  expect(signIn.snapshot().map(request => [request.phase, request.hint.port])).toEqual([['blocked', 8085]]);
  expect(authAuditSnapshot()).toMatchObject({blocked: 2});
  signIn.allow(only(signIn).key);
  expect(deps.start).not.toHaveBeenCalled();
});

it('the default choice applies to a host without its own choice, and a host\'s own choice wins', async () => {
  setDefaultAuthChoice('tunnel', 'never');
  setHostAuthChoice('host-2', 'tunnel', 'ask');
  const {signIn} = harness();
  signIn.hint(context, hint());
  signIn.hint({...context, sessionId: 'session-2', hostId: 'host-2', hostName: 'Other'}, hint());
  await settle();
  expect(signIn.snapshot().map(request => [request.hostId, request.phase])).toEqual([['host-1', 'blocked'], ['host-2', 'asking']]);
});

it('a sensitive port needs the stronger confirmation and is never remembered as Always', async () => {
  const {deps, signIn} = harness();
  signIn.hint(context, hint(5432, {sensitive: true}));
  await settle();
  const {key} = only(signIn);
  signIn.allow(key);
  signIn.allow(key, {always: true});
  expect(deps.start).not.toHaveBeenCalled();
  signIn.allow(key, {always: true, confirmRisky: true});
  await settle();
  expect(deps.start.mock.calls[0][2]).toEqual({kind: 'allow', confirmRisky: true});
  expect(authChoice('host-1', 'tunnel')).toBe('ask');
});

it('another user\'s listener is tunnelled only when asked each time, and tells the engine', async () => {
  const {deps, signIn} = harness({state: 'confirmed', listener: {source: 'companion', bind: 'wildcard', ownedBySessionUser: false}});
  signIn.hint(context, hint(53000));
  await settle();
  signIn.allow(only(signIn).key, {always: true});
  await settle();
  expect(authChoice('host-1', 'tunnel')).toBe('ask');
  expect(deps.start.mock.calls[0][1]).toMatchObject({port: 53000, owner: 'otherUser'});
});

it('a bare announcement asks only once a listener confirms it, and vanishes when none does', async () => {
  const {deps, signIn} = harness({state: 'absent'});
  signIn.hint(context, hint(1455, {source: 'announcement', idpHost: undefined}));
  expect(signIn.snapshot()[0]).toMatchObject({visible: false});
  await vi.waitFor(() => expect(signIn.snapshot()).toEqual([]), {timeout: 3000});
  expect(deps.start).not.toHaveBeenCalled();
  expect(authAuditSnapshot().entries).toEqual([]);
  const confirmedOne = harness();
  confirmedOne.signIn.hint(context, hint(1455, {source: 'announcement'}));
  await settle();
  expect(only(confirmedOne.signIn)).toMatchObject({phase: 'asking', visible: true});
});

it('shrinks an unanswered request after a minute and drops it, as not answered, after ten', async () => {
  vi.useFakeTimers();
  const {deps, signIn} = harness();
  signIn.hint(context, hint());
  await vi.advanceTimersByTimeAsync(0);
  expect(only(signIn).collapsed).toBe(false);
  await vi.advanceTimersByTimeAsync(COLLAPSE_MS);
  expect(only(signIn)).toMatchObject({collapsed: true, phase: 'asking'});
  signIn.expand(only(signIn).key);
  expect(only(signIn).collapsed).toBe(false);
  await vi.advanceTimersByTimeAsync(EXPIRE_MS);
  expect(signIn.snapshot()).toEqual([]);
  expect(deps.start).not.toHaveBeenCalled();
  expect(authAuditSnapshot().entries).toMatchObject([{decision: 'expired', outcome: 'none'}]);
});

it('follows the tunnel to its end: the callback, the close, the audit outcome and the clean-up of the notice', async () => {
  vi.useFakeTimers();
  const {flows, signIn} = harness();
  signIn.hint(context, hint());
  await vi.advanceTimersByTimeAsync(0);
  signIn.allow(only(signIn).key);
  await vi.advanceTimersByTimeAsync(0);
  flows[0].onEvent({type: 'callback'});
  expect(only(signIn)).toMatchObject({phase: 'active', callback: true});
  flows[0].onEvent({type: 'ended', reason: 'callbackDelivered'});
  expect(only(signIn)).toMatchObject({phase: 'ended', reason: 'callbackDelivered'});
  expect(authAuditSnapshot().entries[0]).toMatchObject({decision: 'allowed', outcome: 'completed'});
  await vi.advanceTimersByTimeAsync(DISMISS_MS);
  expect(signIn.snapshot()).toEqual([]);
});

it.each([
  ['timeout', 'timeout'], ['cancelled', 'stopped'], ['sessionEnded', 'stopped'], ['lockEnded', 'stopped'],
  ['hostStoppedListening', 'hostStopped'], ['forwardingDisabled', 'noForwarding'], ['controlConnectionLost', 'connectionLost'],
] as const)('records a tunnel that ended with %s as %s', async (reason, outcome) => {
  const {flows, signIn} = harness();
  signIn.hint(context, hint());
  await settle();
  signIn.allow(only(signIn).key);
  await settle();
  flows[0].onEvent({type: 'ended', reason});
  expect(authAuditSnapshot().entries[0].outcome).toBe(outcome);
});

it('stopping asks the engine to close the tunnel and leaves the notice to its end event', async () => {
  const {deps, flows, signIn} = harness();
  signIn.hint(context, hint());
  await settle();
  signIn.allow(only(signIn).key);
  await settle();
  signIn.stop(only(signIn).key);
  expect(deps.stop).toHaveBeenCalledWith('session-1', 'tunnel-1');
  flows[0].onEvent({type: 'ended', reason: 'cancelled'});
  expect(only(signIn)).toMatchObject({phase: 'ended', reason: 'cancelled'});
});

it('reports a start the device refuses, offers another try and keeps no raw text for kinds it knows', async () => {
  const {deps, signIn} = harness();
  deps.start.mockRejectedValueOnce({kind: 'auth_tunnel_port_busy', message: 'Another program on this device uses port 8085'});
  signIn.hint(context, hint());
  await settle();
  signIn.allow(only(signIn).key);
  await settle();
  expect(only(signIn)).toMatchObject({phase: 'failed', failure: 'auth_tunnel_port_busy'});
  expect(authAuditSnapshot().entries[0].outcome).toBe('failed');
  signIn.retry(only(signIn).key);
  expect(only(signIn)).toMatchObject({phase: 'asking', failure: undefined});
  signIn.allow(only(signIn).key);
  await settle();
  expect(only(signIn).phase).toBe('active');
});

it('closes a tunnel that started after the user already dismissed the request', async () => {
  const {deps, signIn} = harness();
  let finish!: (value: {id: string}) => void;
  deps.start.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  signIn.hint(context, hint());
  await settle();
  signIn.allow(only(signIn).key);
  signIn.dismiss(only(signIn).key);
  finish({id: 'late'});
  await settle();
  expect(deps.stop).toHaveBeenCalledWith('session-1', 'late');
  expect(signIn.snapshot()).toEqual([]);
});

it('an end event that arrives before the start answer is not overwritten by it', async () => {
  const {deps, signIn} = harness();
  deps.start.mockImplementationOnce(async (_s, _h, _c, onEvent) => { onEvent({type: 'ended', reason: 'hostStoppedListening'}); return {id: 'quick'}; });
  signIn.hint(context, hint());
  await settle();
  signIn.allow(only(signIn).key);
  await settle();
  expect(only(signIn)).toMatchObject({phase: 'ended', reason: 'hostStoppedListening', tunnelId: 'quick'});
});

it('caps the requests of one session and keeps repeated hints for the same port as one request', async () => {
  const {signIn} = harness({state: 'absent'});
  for (let port = 3000; port < 3000 + MAX_PER_SESSION + 3; port++) signIn.hint(context, hint(port));
  signIn.hint(context, hint(3000, {pkce: false}));
  expect(signIn.snapshot()).toHaveLength(MAX_PER_SESSION);
  expect(signIn.snapshot()[0].hint.pkce).toBe(false);
  await settle();
});

it('ends the requests of sessions that are gone and everything when asked to clear', async () => {
  const {signIn} = harness();
  signIn.hint(context, hint(8085));
  signIn.hint({...context, sessionId: 'session-2'}, hint(8086));
  await settle();
  signIn.retain(new Set(['session-2']));
  expect(signIn.snapshot().map(request => request.sessionId)).toEqual(['session-2']);
  signIn.clear();
  expect(signIn.snapshot()).toEqual([]);
});

it('never keeps an address, a query, a code or a state: requests, audit and storage hold only fixed fields', async () => {
  const {deps, signIn} = harness();
  const leaky = {...hint(), query: 'code=SECRET-CODE&state=SECRET-STATE', url: 'https://idp.example/a?code=SECRET-CODE&state=SECRET-STATE'} as AuthHint;
  signIn.hint(context, leaky);
  await settle();
  signIn.allow(only(signIn).key, {always: true});
  await settle();
  const dump = JSON.stringify({requests: signIn.snapshot(), audit: authAuditSnapshot(), storage: localStorage.getItem(authPolicyKey), calls: deps.start.mock.calls.map(call => call.slice(0, 3))});
  expect(dump).not.toMatch(/SECRET|code=|state=|\?/);
});

it('opens an ordinary link as before, a sign-in link only once its tunnel runs, and never before', async () => {
  const {deps, signIn} = harness();
  await signIn.openLink('session-1', 'https://docs.example/page');
  expect(deps.openWeb).toHaveBeenCalledWith('https://docs.example/page');
  expect(deps.openAuth).not.toHaveBeenCalled();
  deps.inspect.mockResolvedValue({callbackPorts: [8085]});
  const link = 'https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2Fcb';
  await expect(signIn.openLink('session-1', link)).rejects.toBeInstanceOf(LocalUiError);
  expect(deps.openAuth).not.toHaveBeenCalled();
  signIn.hint(context, hint(8085));
  await settle();
  await expect(signIn.openLink('session-1', link)).rejects.toBeInstanceOf(LocalUiError);
  signIn.allow(only(signIn).key);
  await settle();
  await signIn.openLink('session-1', link);
  expect(deps.openAuth).toHaveBeenCalledWith('session-1', link, 'tunnel-1');
  expect(deps.openWeb).toHaveBeenCalledTimes(1);
});

it('lets a link the checker cannot read, and any link in a local terminal, go to the ordinary opener', async () => {
  const {deps, signIn} = harness();
  deps.inspect.mockRejectedValue(new Error('Invalid browser URL'));
  await signIn.openLink('session-1', 'not a url');
  await signIn.openLink('local:1', 'https://idp.example/a?redirect_uri=http%3A%2F%2Flocalhost%3A8085');
  expect(deps.openWeb).toHaveBeenCalledTimes(2);
  expect(deps.inspect).toHaveBeenCalledTimes(1);
});

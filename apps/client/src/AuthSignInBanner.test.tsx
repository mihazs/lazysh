// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, waitFor, within} from '@testing-library/react';
import {AuthSignInBanner} from './AuthSignInBanner';
import {AuthSignInSettings} from './AuthSignInSettings';
import {clearAuthAudit} from './authAudit';
import type {AuthHint} from './authHints';
import {authChoice, setHostAuthChoice} from './authPolicy';
import {signIn} from './authSignIn';
import {api, type AuthTunnelEvent} from './bridge';
import * as listeners from './authListeners';
import {t, uiI18n} from './i18n/core';

const session = {sessionId: 'session-1', hostId: 'host-1', hostName: 'Build box'};
const hint = (extra: Partial<AuthHint> = {}): AuthHint => ({id: 'hint', source: 'url', host: 'localhost', port: 8085, path: '/cb', idpHost: 'idp.example', pkce: true, sensitive: false, firstSeenAt: new Date().toISOString(), ...extra});
let onEvent: (event: AuthTunnelEvent) => void;
const confirmed = {state: 'confirmed', listener: {source: 'companion', bind: 'loopback', ownedBySessionUser: true, ageSeconds: 1}} as const;

beforeEach(() => {
  localStorage.clear(); clearAuthAudit(); signIn.clear();
  vi.spyOn(listeners, 'checkAuthListener').mockResolvedValue(confirmed);
  vi.spyOn(api, 'startAuthTunnel').mockImplementation(async (_session, _hint, _consent, handler) => { onEvent = handler; return {id: 'tunnel', sessionId: 'session-1', port: 8085, addresses: ['127.0.0.1']}; });
  vi.spyOn(api, 'stopAuthTunnel').mockResolvedValue();
});
afterEach(async () => { cleanup(); signIn.clear(); vi.restoreAllMocks(); await uiI18n.changeLanguage('en'); });

const banner = () => screen.getByRole('region', {name: 'Sign-in tunnel for Build box'});
async function ask(extra: Partial<AuthHint> = {}) {
  render(<AuthSignInBanner sessionId="session-1"/>);
  await act(async () => { signIn.hint(session, hint(extra)); });
  await screen.findByText(`Sign-in on Build box needs localhost:${extra.port ?? 8085}`, {selector: 'strong'});
}

it('shows nothing for a session with no sign-in, and nothing for another session\'s', async () => {
  render(<AuthSignInBanner sessionId="session-2"/>);
  await act(async () => { signIn.hint(session, hint()); });
  expect(screen.queryByRole('region')).toBeNull();
});

it('names the host and port, the identity provider and what the host listens on, and asks without taking focus', async () => {
  const input = document.body.appendChild(document.createElement('input'));
  input.focus();
  await ask();
  expect(within(banner()).getByText('Sign-in page: idp.example')).toBeTruthy();
  await within(banner()).findByText('The host is listening on port 8085.');
  expect(within(banner()).getByText(/First sign-in noticed/)).toBeTruthy();
  expect(screen.getAllByRole('status').some(status => status.textContent === 'Sign-in on Build box needs localhost:8085')).toBe(true);
  expect(document.activeElement).toBe(input);
  for (const name of ['Allow once', 'Always for this host', 'Deny']) expect(within(banner()).getByRole('button', {name})).toBeTruthy();
  expect(api.startAuthTunnel).not.toHaveBeenCalled();
  input.remove();
});

it('Allow once starts the tunnel with that answer, then shows it ready and closes on its end', async () => {
  await ask();
  fireEvent.click(within(banner()).getByRole('button', {name: 'Allow once'}));
  await within(banner()).findByText('Tunnel ready on localhost:8085. Open the sign-in link from the terminal on this device.', {selector: 'strong'});
  expect(vi.mocked(api.startAuthTunnel).mock.calls[0].slice(0, 3)).toEqual(['session-1', expect.objectContaining({port: 8085, evidence: 'url'}), {kind: 'allow', confirmRisky: false}]);
  expect(authChoice('host-1', 'tunnel')).toBe('ask');
  act(() => onEvent({type: 'callback'}));
  await within(banner()).findByText('The sign-in reached Build box. Closing the tunnel on localhost:8085.', {selector: 'strong'});
  expect(within(banner()).queryByRole('button', {name: 'Stop'})).toBeNull();
  act(() => onEvent({type: 'ended', reason: 'callbackDelivered'}));
  await within(banner()).findByText('Sign-in finished on Build box. The tunnel on localhost:8085 is closed.', {selector: 'strong'});
  fireEvent.click(within(banner()).getByRole('button', {name: 'Dismiss'}));
  expect(screen.queryByRole('region')).toBeNull();
});

it('Stop asks the engine to close a running tunnel', async () => {
  await ask();
  fireEvent.click(within(banner()).getByRole('button', {name: 'Allow once'}));
  fireEvent.click(await within(banner()).findByRole('button', {name: 'Stop'}));
  expect(api.stopAuthTunnel).toHaveBeenCalledWith('session-1', 'tunnel');
});

it('Always for this host remembers the choice for this host only', async () => {
  await ask();
  fireEvent.click(within(banner()).getByRole('button', {name: 'Always for this host'}));
  await waitFor(() => expect(api.startAuthTunnel).toHaveBeenCalled());
  expect(authChoice('host-1', 'tunnel')).toBe('always');
  expect(authChoice('host-2', 'tunnel')).toBe('ask');
});

it('Deny starts nothing and removes the notice', async () => {
  await ask();
  fireEvent.click(within(banner()).getByRole('button', {name: 'Deny'}));
  expect(screen.queryByRole('region')).toBeNull();
  expect(api.startAuthTunnel).not.toHaveBeenCalled();
});

it('a host set to Never shows one explanation and never a button that starts a tunnel', async () => {
  setHostAuthChoice('host-1', 'tunnel', 'never');
  render(<AuthSignInBanner sessionId="session-1"/>);
  await act(async () => { signIn.hint(session, hint()); });
  expect(await screen.findByText(/Sign-in tunnels are off for Build box/, {selector: 'strong'})).toBeTruthy();
  expect(screen.queryByRole('button', {name: /Allow|Always|Tunnel/})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: 'Dismiss'}));
  expect(api.startAuthTunnel).not.toHaveBeenCalled();
});

it('warns about a missing PKCE challenge, an internationalized name, another user\'s listener and a sensitive port', async () => {
  vi.mocked(listeners.checkAuthListener).mockResolvedValue({state: 'confirmed', listener: {source: 'companion', bind: 'wildcard', ownedBySessionUser: false}});
  await ask({pkce: false, idpHost: 'xn--login-9ra.example', sensitive: true, port: 5432});
  await within(banner()).findByText(/Another user|A program of another user/);
  expect(within(banner()).getByText(/does not use PKCE/)).toBeTruthy();
  expect(within(banner()).getByText(/internationalized characters/)).toBeTruthy();
  expect(within(banner()).getByText(/database, cache, remote-access or admin service/)).toBeTruthy();
  expect(within(banner()).queryByRole('button', {name: 'Always for this host'})).toBeNull();
  expect(within(banner()).queryByRole('button', {name: 'Allow once'})).toBeNull();
  fireEvent.click(within(banner()).getByRole('button', {name: 'Tunnel anyway'}));
  await waitFor(() => expect(vi.mocked(api.startAuthTunnel).mock.calls[0][2]).toEqual({kind: 'allow', confirmRisky: true}));
});

it('reports a refused start in plain words and offers another try', async () => {
  vi.mocked(api.startAuthTunnel).mockRejectedValueOnce({kind: 'auth_tunnel_port_busy', message: 'raw'});
  await ask();
  fireEvent.click(within(banner()).getByRole('button', {name: 'Allow once'}));
  expect(await within(banner()).findByText(/Port 8085 is already in use on this device/, {selector: 'strong'})).toBeTruthy();
  fireEvent.click(within(banner()).getByRole('button', {name: 'Try again'}));
  expect(await within(banner()).findByRole('button', {name: 'Allow once'})).toBeTruthy();
});

it.each(['pt-BR', 'es'])('speaks %s for every state without leaving a placeholder or the English sentence', async locale => {
  await uiI18n.changeLanguage(locale);
  render(<AuthSignInBanner sessionId="session-1"/>);
  await act(async () => { signIn.hint(session, hint({pkce: false})); });
  const region = await screen.findByRole('region');
  const asking = region.textContent!;
  expect(asking).toContain('localhost:8085');
  expect(asking).toContain(t('authAllowOnce'));
  expect(asking).not.toMatch(/\{\{|Allow once|Sign-in on/);
  fireEvent.click(within(region).getByRole('button', {name: t('authAllowOnce')}));
  await within(region).findByText(t('authActive', {port: 8085}), {selector: 'strong'});
  act(() => onEvent({type: 'ended', reason: 'forwardingDisabled'}));
  const ended = t('authEndedForwardingDisabled', {host: 'Build box'});
  expect(within(region).getByText(ended, {selector: 'strong'})).toBeTruthy();
  expect(ended).not.toMatch(/\{\{|AllowTcpForwarding no in its SSH server settings/);
  expect(within(region).getByRole('button', {name: t('authDismiss')})).toBeTruthy();
});

it('settings choose the default and each host, list recent sign-ins without any address and clear them', async () => {
  const hosts = [{id: 'host-1', name: 'Build box'}, {id: 'host-2', name: 'Lab'}];
  render(<><AuthSignInBanner sessionId="session-1"/><AuthSignInSettings hosts={hosts}/></>);
  expect(screen.getByText('No sign-in has been noticed since the app opened.')).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', {name: 'Auto tunnel for auth callbacks'}), {target: {value: 'always'}});
  expect(authChoice('host-2', 'tunnel')).toBe('always');
  fireEvent.change(screen.getByRole('combobox', {name: 'Build box: auto tunnel for auth callbacks'}), {target: {value: 'never'}});
  expect([authChoice('host-1', 'tunnel'), authChoice('host-2', 'tunnel')]).toEqual(['never', 'always']);
  expect((screen.getByRole('combobox', {name: 'Lab: auto tunnel for auth callbacks'}) as HTMLSelectElement).value).toBe('');
  expect(screen.getAllByRole('option', {name: 'Default (Always)'})).toHaveLength(2);
  await act(async () => { signIn.hint(session, hint()); });
  expect(screen.getByText('Kept from starting by Never: 1')).toBeTruthy();
  const row = screen.getByRole('list', {name: 'Recent sign-ins'}).textContent!;
  expect(row).toContain('Build box, localhost:8085, blocked by Never, nothing ran');
  expect(row).not.toMatch(/idp\.example|https?:|\?/);
  fireEvent.click(screen.getByRole('button', {name: 'Clear list'}));
  expect(screen.getByText('No sign-in has been noticed since the app opened.')).toBeTruthy();
});

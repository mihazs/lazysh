import { installNativeBridge } from './fixtures/nativeBridge';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

type Call = {command: string; args: Record<string, unknown>};
type Events = {onmessage: (event: unknown) => void};
type Fixture = {calls: Call[]; session?: Events; tunnel?: Events; listener: unknown; startError?: unknown};
declare global { interface Window { signin: Fixture } }

const hint = {id: 'hint-1', source: 'url', host: 'localhost', port: 8085, path: '/oauth/callback', idpHost: 'idp.example', pkce: true, sensitive: false, firstSeenAt: new Date().toISOString()};
const confirmed = {state: 'confirmed', listener: {source: 'companion', bind: 'loopback', ownedBySessionUser: true, ageSeconds: 2}};

async function open(page: Page, policy?: unknown) {
  await installNativeBridge(page);
  await page.addInitScript(({policy, confirmed}) => {
    localStorage.setItem('lazysh.workspace.v1', JSON.stringify([{hostId: 'box', attached: {kind: 'tmux', name: 'agents', tmuxServer: 'work'}}]));
    if (policy) localStorage.setItem('lazysh.auth.policy.v1', JSON.stringify(policy));
    window.signin = {calls: [], listener: confirmed};
    window.nativeFixtureInvoke = async (command, args = {}) => {
      if (command.startsWith('plugin:event|')) return 1;
      if (command === 'list_hosts') return [{id: 'box', name: 'Agent box', hostname: 'box.invalid', port: 22, username: 'dev', fingerprint: 'SHA256:fixture', credentialsStored: true}];
      if (command === 'local_capability' || command === 'apple_status_capability') return {available: false, reason: 'Sign-in fixture'};
      if (command === 'agent_snapshot') return {schemaVersion: 1, sessions: []};
      window.signin.calls.push({command, args});
      if (command === 'connect') return {sessionId: 'native-1'};
      if (command === 'attach_tmux') { window.signin.session = args.events as Events; return {sessionId: 'native-2'}; }
      if (command === 'check_auth_listener') return window.signin.listener;
      if (command === 'start_auth_tunnel') {
        if (window.signin.startError) throw window.signin.startError;
        window.signin.tunnel = args.events as Events;
        return {id: 'tunnel-1', sessionId: 'native-2', port: (args.hint as {port: number}).port, addresses: ['127.0.0.1']};
      }
      if (['stop_auth_tunnel', 'resize', 'ack_output', 'disconnect', 'write_stdin', 'probe_connections', 'cancel_credential_auth'].includes(command)) return;
      if (command === 'has_credentials') return false;
      throw new Error(`Sign-in fixture does not provide ${command}`);
    };
  }, {policy, confirmed});
  await page.goto('/');
  await page.locator('.workspace-restore').getByRole('button', {name: 'Restore previous workspace', exact: true}).click();
  await expect(page.locator('.terminal-canvas')).toHaveCount(1);
}
const calls = (page: Page, command: string) => page.evaluate(command => window.signin.calls.filter(call => call.command === command), command);
const emitHint = (page: Page, value: unknown = hint) => page.evaluate(value => window.signin.session!.onmessage({type: 'authHint', hint: value}), value);
const tunnelEvent = (page: Page, event: unknown) => page.evaluate(event => window.signin.tunnel!.onmessage(event), event);
const banner = (page: Page) => page.getByRole('region', {name: 'Sign-in tunnel for Agent box', exact: true});

test('a detected sign-in asks, and Allow once tunnels the port and follows it to the end', async ({page}) => {
  await open(page);
  await emitHint(page);
  await expect(banner(page)).toContainText('Sign-in on Agent box needs localhost:8085');
  await expect(banner(page)).toContainText('Sign-in page: idp.example');
  await expect(banner(page)).toContainText('The host is listening on port 8085.');
  expect(await calls(page, 'start_auth_tunnel')).toHaveLength(0);

  await banner(page).getByRole('button', {name: 'Allow once', exact: true}).click();
  await expect(banner(page)).toContainText('Tunnel ready on localhost:8085');
  const [start] = await calls(page, 'start_auth_tunnel');
  expect(start.args).toMatchObject({sessionId: 'native-2', hint: {port: 8085, path: '/oauth/callback', evidence: 'url', confirmed: true}, consent: {kind: 'allow', confirmRisky: false}});
  expect(JSON.stringify(start.args)).not.toMatch(/code=|state=|\?/);

  await tunnelEvent(page, {type: 'callback'});
  await expect(banner(page)).toContainText('The sign-in reached Agent box');
  await tunnelEvent(page, {type: 'ended', reason: 'callbackDelivered'});
  await expect(banner(page)).toContainText('Sign-in finished on Agent box. The tunnel on localhost:8085 is closed.');
  await banner(page).getByRole('button', {name: 'Dismiss', exact: true}).click();
  await expect(banner(page)).toHaveCount(0);
});

test('Deny starts no tunnel, and a host answering Never is never asked', async ({page}) => {
  await open(page);
  await emitHint(page);
  await banner(page).getByRole('button', {name: 'Deny', exact: true}).click();
  await expect(banner(page)).toHaveCount(0);
  expect(await calls(page, 'start_auth_tunnel')).toHaveLength(0);
});

test('a host set to Never explains once, asks the host nothing and starts nothing', async ({page}) => {
  await open(page, {defaults: {}, hosts: {box: {tunnel: 'never'}}});
  await emitHint(page);
  await expect(banner(page)).toContainText('Sign-in tunnels are off for Agent box');
  await expect(banner(page).getByRole('button', {name: /Allow|Always|Tunnel/})).toHaveCount(0);
  expect(await calls(page, 'check_auth_listener')).toHaveLength(0);
  expect(await calls(page, 'start_auth_tunnel')).toHaveLength(0);
});

test('a host set to Always starts a confirmed sign-in by itself and shows a Stop', async ({page}) => {
  await open(page, {defaults: {}, hosts: {box: {tunnel: 'always'}}});
  await emitHint(page);
  await expect(banner(page)).toContainText('Tunnel started on localhost:8085 because Agent box is set to Always');
  const [start] = await calls(page, 'start_auth_tunnel');
  expect(start.args).toMatchObject({consent: {kind: 'policy', policy: 'always'}, hint: {confirmed: true, owner: 'sessionUser'}});
  await banner(page).getByRole('button', {name: 'Stop', exact: true}).click();
  expect(await calls(page, 'stop_auth_tunnel')).toHaveLength(1);
});

test('a port the device cannot give is reported and can be tried again after it is freed', async ({page}) => {
  await open(page);
  await page.evaluate(() => { window.signin.startError = {kind: 'auth_tunnel_port_busy', message: 'raw'}; });
  await emitHint(page);
  await banner(page).getByRole('button', {name: 'Allow once', exact: true}).click();
  await expect(banner(page)).toContainText('Port 8085 is already in use on this device');
  await page.evaluate(() => { window.signin.startError = undefined; });
  await banner(page).getByRole('button', {name: 'Try again', exact: true}).click();
  await banner(page).getByRole('button', {name: 'Allow once', exact: true}).click();
  await expect(banner(page)).toContainText('Tunnel ready on localhost:8085');
});

test('the keyboard reaches every answer and the terminal keeps focus until then', async ({page}) => {
  await open(page);
  await emitHint(page);
  await expect(banner(page)).toBeVisible();
  const focused = await page.evaluate(selector => !document.querySelector(selector)?.contains(document.activeElement), '.auth-signin');
  expect(focused).toBe(true);
  await banner(page).getByRole('button', {name: 'Allow once', exact: true}).focus();
  await page.keyboard.press('Tab');
  await expect(banner(page).getByRole('button', {name: 'Always for this host', exact: true})).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(banner(page).getByRole('button', {name: 'Deny', exact: true})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(banner(page)).toHaveCount(0);
});

/** What a screen reader or a keyboard user would trip over inside the banner, by axe's rules (names, roles, contrast, targets). */
const violations = async (page: Page) => (await new AxeBuilder({page}).include('.auth-signin-stack').analyze()).violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.target.join(' ')).join(', ')}`);

test('the banner passes axe in every state a person meets', async ({page}) => {
  await open(page);
  await emitHint(page, {...hint, pkce: false, idpHost: 'xn--login-9ra.example'});
  await expect(banner(page)).toContainText('Sign-in on Agent box needs localhost:8085');
  expect(await violations(page)).toEqual([]);
  await banner(page).getByRole('button', {name: 'Allow once', exact: true}).click();
  await expect(banner(page)).toContainText('Tunnel ready on localhost:8085');
  expect(await violations(page)).toEqual([]);
  await tunnelEvent(page, {type: 'ended', reason: 'forwardingDisabled'});
  await expect(banner(page)).toContainText('does not allow TCP forwarding');
  expect(await violations(page)).toEqual([]);
});

for (const [locale, title, allow] of [['pt-BR', 'O login em Agent box precisa de localhost:8085', 'Permitir uma vez'], ['es', 'El inicio de sesión en Agent box necesita localhost:8085', 'Permitir una vez']] as const) {
  test(`${locale} shows the question and its answers without overflowing the screen`, async ({page}) => {
    await open(page);
    await page.evaluate(async locale => { const {uiI18n} = await import('/src/i18n/core.ts'); await uiI18n.changeLanguage(locale); }, locale);
    await emitHint(page, {...hint, pkce: false});
    const region = page.getByRole('region', {name: /Agent box/});
    await expect(region).toContainText(title);
    await expect(region.getByRole('button', {name: allow, exact: true})).toBeVisible();
    expect(await region.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const boxes = await region.getByRole('button').evaluateAll(buttons => buttons.map(button => button.getBoundingClientRect().height));
    for (const height of boxes) expect(height).toBeGreaterThanOrEqual(44);
  });
}

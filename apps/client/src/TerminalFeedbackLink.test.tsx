// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {act, cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const opener = vi.hoisted(() => ({openWebUrl: vi.fn(), native: true}));
vi.mock('./bridge', () => ({api: {openWebUrl: opener.openWebUrl}, get native() { return opener.native; }}));
vi.mock('./terminalBackends', () => ({backendRefusal: async () => 'no Vulkan', recordedNativeFailure: () => undefined}));
import TerminalEngineChoice from './TerminalEngineChoice';
import TerminalEngineNotice from './TerminalEngineNotice';
import TerminalFeedbackLink from './TerminalFeedbackLink';
import {defaults, savePreferences} from './preferences';

const network = {fetch: vi.fn(), xhr: vi.fn(), beacon: vi.fn(), open: vi.fn()};
beforeEach(() => {
  opener.native = true;
  opener.openWebUrl.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', network.fetch);
  vi.stubGlobal('XMLHttpRequest', class { constructor() { network.xhr(); } });
  vi.stubGlobal('open', network.open);
  Object.defineProperty(navigator, 'sendBeacon', {value: network.beacon, configurable: true});
  localStorage.clear(); savePreferences(defaults);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); Object.values(network).forEach(spy => spy.mockReset()); });

const report = () => screen.getByRole('button', {name: 'Report a terminal problem'});
const reported = () => new URL(opener.openWebUrl.mock.calls.at(-1)![0] as string);
/** The app makes no request of its own: the browser opens the page. */
const noRequestFromTheApp = () => expect([network.fetch, network.xhr, network.beacon, network.open].map(spy => spy.mock.calls.length)).toEqual([0, 0, 0, 0]);

it('opens the prefilled issue form through the app\'s browser opener, and makes no request itself', async () => {
  render(<TerminalFeedbackLink report={{engine: 'native', preference: 'native', reasons: ['preference']}} />);
  await userEvent.click(report());
  expect(opener.openWebUrl).toHaveBeenCalledOnce();
  const url = reported();
  expect([url.origin + url.pathname, url.searchParams.get('body')]).toEqual(['https://github.com/mihazs/lazysh/issues/new', expect.stringContaining('- Engine: native\n- Setting: native\n- Reason: preference')]);
  noRequestFromTheApp();
});

it('opens it in a new browser tab, without an opener, outside the app', async () => {
  opener.native = false;
  render(<TerminalFeedbackLink report={{engine: 'xterm'}} />);
  await userEvent.click(report());
  expect(opener.openWebUrl).not.toHaveBeenCalled();
  expect(network.open).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/github\.com\/mihazs\/lazysh\/issues\/new\?/), '_blank', 'noopener,noreferrer');
});

it('says so when the browser cannot be opened, and forgets it on the next try', async () => {
  opener.openWebUrl.mockRejectedValueOnce(new Error('no browser'));
  render(<TerminalFeedbackLink report={{engine: 'xterm'}} />);
  await userEvent.click(report());
  expect((await screen.findByRole('alert')).textContent).toBe('The browser could not open the issue form. Go to github.com/mihazs/lazysh/issues instead.');
  await userEvent.click(report());
  expect(screen.queryByRole('alert')).toBeNull();
});

it('is offered beside the Native option in Settings, with the setting and the refusal that apply', async () => {
  render(<TerminalEngineChoice engine="native" screenReader={false} update={vi.fn()} />);
  await screen.findByText(/Native is turned off/);
  expect(screen.getByText(/lazysh sends nothing itself/)).toBeTruthy();
  await userEvent.click(report());
  const body = reported().searchParams.get('body')!;
  expect(body).toContain('- Setting: native\n- Reason: native: no Vulkan');
  expect(body).not.toContain('Engine:');
  noRequestFromTheApp();
});

it('is offered on the one-time notice, naming the engine the default became', async () => {
  localStorage.setItem('lazysh.terminal.defaultEngineSeen', 'xterm');
  render(<TerminalEngineNotice onOpenSettings={vi.fn()} resolve={async () => 'native'} />);
  await act(async () => { await Promise.resolve(); });
  await userEvent.click(await screen.findByRole('button', {name: 'Report a terminal problem'}));
  expect(reported().searchParams.get('body')).toContain('- Engine: native\n- Setting: auto\n- Reason: default engine changed');
  noRequestFromTheApp();
});

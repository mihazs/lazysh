// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {mocks, openConnection} from './test/appHarness';
import {afterEach, expect, it, vi} from 'vitest';
import {act, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {defaults, getPreferences, savePreferences} from './preferences';
import type {LiveSession} from './terminal';

afterEach(() => act(() => savePreferences(defaults)));

const sessionNamed = (id: string) => mocks.terminalPaneProps.mock.calls.map(([props]) => props.session as LiveSession).find(session => session.id === id)!;
const choose = (terminalEngine: 'native' | 'xterm') => act(() => savePreferences({...getPreferences(), terminalEngine}));
async function connect(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(screen.getByRole('button', {name: 'Connect'}));
  await waitFor(() => expect(sessionNamed(id)).toBeDefined());
  return sessionNamed(id);
}
async function connectAnother(user: ReturnType<typeof userEvent.setup>, id: string) {
  await user.click(screen.getByRole('button', {name: 'Connect to Home'}));
  await user.type(screen.getByLabelText('Password'), `${id}-secret`);
  return connect(user, id);
}

it('gives a new session the engine chosen in Settings and records why, while an open session keeps its engine', async () => {
  mocks.api.connect.mockResolvedValueOnce({sessionId: 'first'}).mockResolvedValueOnce({sessionId: 'second'}).mockResolvedValueOnce({sessionId: 'third'});
  const user = await openConnection();
  const first = await connect(user, 'first');
  await screen.findByText('Live SSH terminal');
  expect(first.adapter.backend).toBe('xterm');
  expect(first.selection).toEqual({id: 'xterm', reason: 'automatic', fallbacks: []});

  // This build has no native core: choosing Native cannot change the engine, and the session records the app's reason for refusing it.
  mocks.invoke.mockImplementation(async (command: string) => command === 'terminal_core_available' ? {available: false, reason: 'The native terminal core is not built into this app'} : undefined);
  choose('native');
  const second = await connectAnother(user, 'second');
  expect(second.adapter.backend).toBe('xterm');
  expect(second.selection).toEqual({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'The native terminal core is not built into this app'}]});

  choose('xterm');
  const third = await connectAnother(user, 'third');
  expect(third.selection).toEqual({id: 'xterm', reason: 'preference', fallbacks: []});

  expect(first.selection).toEqual({id: 'xterm', reason: 'automatic', fallbacks: []});
  expect(second.selection.reason).toBe('fallback');
  expect([first, second, third].every(session => !session.disposed && session.connected)).toBe(true);
  expect(mocks.terminal.dispose).not.toHaveBeenCalled();
});

it('tells a device whose default engine changed, and its button opens Settings', async () => {
  vi.mocked(localStorage.getItem).mockImplementation(key => key === 'lazysh.terminal.defaultEngineSeen' ? 'native' : null);
  const user = await openConnection();
  const notice = await screen.findByText('The terminal engine changed on this platform. Switch back in Settings, Terminal engine.');
  await user.click(within(notice.parentElement!).getByRole('button', {name: 'Open Settings'}));
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.terminal.defaultEngineSeen', 'xterm');
  expect(screen.queryByText(notice.textContent!)).toBeNull();
  expect(await screen.findByRole('dialog', {name: 'Preferences'})).toBeTruthy();
});

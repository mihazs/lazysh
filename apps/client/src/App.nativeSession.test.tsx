// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {mocks, openConnection} from './test/appHarness';
import {afterEach, expect, it} from 'vitest';
import {act, screen, waitFor} from '@testing-library/react';
import {defaults, getPreferences, savePreferences} from './preferences';
import type {LiveSession} from './terminal';

afterEach(() => act(() => savePreferences(defaults)));

it('starts a session on the native engine with the core as its data path: no output through JS, no credit returned from it, and the core freed with the session', async () => {
  mocks.api.connect.mockResolvedValueOnce({sessionId: 'core-session'});
  mocks.invoke.mockImplementation(async (command: string) => command === 'terminal_core_available' || command === 'native_terminal_probe' ? {available: true} : undefined);
  act(() => savePreferences({...getPreferences(), terminalEngine: 'native'}));
  const user = await openConnection();
  await user.click(screen.getByRole('button', {name: 'Connect'}));
  await waitFor(() => expect(mocks.terminalPaneProps).toHaveBeenCalled());
  const session = mocks.terminalPaneProps.mock.calls.at(-1)![0].session as LiveSession;
  expect(session.adapter).toMatchObject({backend: 'native', dataPath: 'runtime'});
  expect(session.selection).toMatchObject({id: 'native'});
  const onEvent = mocks.api.connect.mock.calls.at(-1)![2] as ((event: unknown) => void) & {link: {events: unknown; bind(session: Promise<string>): void}};
  // The mocked bridge does not start the transport, so the test plays its part: the session that started on the core's channel.
  onEvent.link.bind(Promise.resolve('core-session'));
  expect(onEvent.link).toBe(session.adapter.transport);
  expect(mocks.invoke).toHaveBeenCalledWith('terminal_core_open', expect.objectContaining({events: onEvent.link.events}), expect.anything());
  // The core's output never reaches the app; what does arrive is the transport's own notices.
  act(() => onEvent({type: 'closed', message: 'Host closed the session'}));
  expect(session.connected).toBe(false);
  expect(session.message).toBe('Host closed the session');
  expect(mocks.api.ackOutput).not.toHaveBeenCalled();
  await session.adapter.dispose();
  expect(mocks.invoke).toHaveBeenCalledWith('terminal_core_close', {sessionId: 'core-session'});
});

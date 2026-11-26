// @vitest-environment jsdom
// The harness registers the module mocks, so it has to be the first import.
import {mocks, openConnection, selectConnectionTransport} from './test/appHarness';
import {afterEach, expect, it, vi} from 'vitest';
import {act, screen, waitFor} from '@testing-library/react';
import {defaults, getPreferences, savePreferences} from './preferences';
import type {LiveSession} from './terminal';

afterEach(() => act(() => savePreferences(defaults)));

/** The app's answers when the native engine can be used: its probe passes, and `core` says what opening a core does. */
const withCore = (core: (command: string, args: {events: unknown}) => unknown = () => undefined) =>
  mocks.invoke.mockImplementation(async (command: string, args: {events: unknown}) => command === 'terminal_core_available' || command === 'native_terminal_probe' ? {available: true} : core(command, args));

/** Opens a session after the user chose Native; the mocked transport is told which session started on the core's Channel. */
async function connectNative(sessionId: string) {
  mocks.api.connect.mockResolvedValueOnce({sessionId});
  act(() => savePreferences({...getPreferences(), terminalEngine: 'native'}));
  const user = await openConnection();
  await user.click(screen.getByRole('button', {name: 'Connect'}));
  await waitFor(() => expect(mocks.terminalPaneProps).toHaveBeenCalled());
  const session = mocks.terminalPaneProps.mock.calls.at(-1)![0].session as LiveSession;
  const onEvent = mocks.api.connect.mock.calls.at(-1)![2] as ((event: unknown) => void) & {link?: {events: unknown; bind(session: Promise<string>): void}};
  return {session, onEvent};
}

it('starts a session on the native engine with the core as its data path: no output through JS, no credit returned from it, and the core freed with the session', async () => {
  withCore();
  const {session, onEvent: transport} = await connectNative('core-session');
  const onEvent = transport as typeof transport & {link: NonNullable<typeof transport.link>};
  expect(session.adapter).toMatchObject({backend: 'native', dataPath: 'runtime'});
  expect(session.selection).toMatchObject({id: 'native'});
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

it('starts a Mosh session on the native engine: the core opens for Mosh frames, the session resizes canonically, and a frame the core refuses ends it', async () => {
  mocks.api.connect.mockResolvedValueOnce({sessionId: 'ssh-control'});
  mocks.api.connectMosh.mockResolvedValueOnce({sessionId: 'core-mosh'});
  mocks.invoke.mockImplementation(async (command: string) => command === 'transport_capabilities' ? {mosh: true} : command === 'terminal_core_available' || command === 'native_terminal_probe' ? {available: true} : undefined);
  act(() => savePreferences({...getPreferences(), terminalEngine: 'native', cursorStyle: 'underline', cursorBlink: false}));
  const user = await openConnection();
  await selectConnectionTransport(user, 'mosh');
  await user.click(screen.getByRole('button', {name: 'Connect'}));
  await waitFor(() => expect(mocks.api.connectMosh).toHaveBeenCalled());
  const onEvent = mocks.api.connectMosh.mock.calls.at(-1)![2] as ((event: unknown) => void) & {link: {events: {onmessage(event: unknown): void}; bind(session: Promise<string>): void}};
  onEvent.link.bind(Promise.resolve('core-mosh'));
  await waitFor(() => expect(mocks.terminalPaneProps.mock.calls.some(([props]) => (props.session as LiveSession).id === 'core-mosh')).toBe(true));
  const session = mocks.terminalPaneProps.mock.calls.map(([props]) => props.session as LiveSession).find(live => live.id === 'core-mosh')!;
  expect(session.adapter).toMatchObject({backend: 'native', dataPath: 'runtime'});
  expect(session.selection).toMatchObject({id: 'native', reason: 'preference'});
  expect(mocks.invoke).toHaveBeenCalledWith('terminal_core_open', expect.objectContaining({config: {canonicalFrames: true, cursorStyle: 'underline', cursorBlink: false}}), expect.anything());
  expect(session.moshResize).toBeDefined();
  expect(session.connected).toBe(true);
  // The core applies the frames itself: its refusal of one is how the app learns the display cannot follow the transport.
  act(() => onEvent.link.events.onmessage({type: 'failure', reason: 'invalid-frame'}));
  expect(session.moshResize!.failure).toBe('invalid-frame');
  expect(session.connected).toBe(false);
  await waitFor(() => expect(mocks.api.disconnect).toHaveBeenCalledWith('core-mosh'));
  expect(session.leaveNative).toBeTypeOf('function');
});

it('starts the session on xterm.js when the core cannot be opened, says why, and remembers the failure on the device', async () => {
  withCore(command => command === 'terminal_core_open' ? Promise.reject('no surface host') : undefined);
  const {session} = await connectNative('fell-back');
  expect(session.adapter.backend).toBe('xterm');
  expect(session.selection).toEqual({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'failed: no surface host'}]});
  expect(session.connected).toBe(true);
  expect(session.leaveNative).toBeUndefined();
  expect(localStorage.setItem).toHaveBeenCalledWith('lazysh.terminal.failure.native', expect.stringContaining('failed: no surface host'));
});

it('moves a live native session to xterm.js: the snapshot first, then the new Channel\'s output, acknowledged through the normal path', async () => {
  let handed: {onmessage?: (event: unknown) => void} | undefined;
  withCore((command, args) => command === 'terminal_core_release' ? (handed = args.events as typeof handed, {ansi: 'SNAPSHOT', columns: 80, rows: 24}) : undefined);
  // The page's xterm.js terminal here is a stand-in that applies a write at once.
  Object.assign(mocks.terminal, {resize: vi.fn()});
  mocks.terminal.write.mockImplementation((_bytes: Uint8Array, applied?: () => void) => applied?.());
  const {session, onEvent: transport} = await connectNative('handed-back');
  transport.link!.bind(Promise.resolve('handed-back'));
  const native = session.adapter;
  expect(await session.leaveNative!()).toBe(true);
  expect(mocks.invoke).toHaveBeenCalledWith('terminal_core_release', {sessionId: 'handed-back', events: handed}, expect.anything());
  expect(session.adapter).not.toBe(native);
  expect(session.adapter.backend).toBe('xterm');
  expect(session.selection).toEqual({id: 'xterm', reason: 'switched', fallbacks: []});
  expect(mocks.invoke).toHaveBeenCalledWith('terminal_core_close', {sessionId: 'handed-back'});
  expect(mocks.terminal.write).toHaveBeenCalledWith(new TextEncoder().encode('SNAPSHOT'), expect.any(Function));

  act(() => handed!.onmessage!({type: 'data', data: [104, 105]}));
  await waitFor(() => expect(mocks.api.ackOutput).toHaveBeenCalledWith('handed-back', 2));
  expect(mocks.terminal.write).toHaveBeenLastCalledWith(new Uint8Array([104, 105]), expect.any(Function));
  expect(mocks.terminal.write).toHaveBeenCalledTimes(2);
});

/** The status bar's right-hand text, where the terminal type is shown. */
const statusBar = () => document.querySelector('.workspace-footer')!.textContent;

it('names the engine of the session in the status bar next to the terminal type, and follows the session when it moves to xterm.js', async () => {
  withCore(command => command === 'terminal_core_release' ? {ansi: 'SNAPSHOT', columns: 80, rows: 24} : undefined);
  Object.assign(mocks.terminal, {resize: vi.fn()});
  mocks.terminal.write.mockImplementation((_bytes: Uint8Array, applied?: () => void) => applied?.());
  const {session, onEvent} = await connectNative('bar-session');
  onEvent.link!.bind(Promise.resolve('bar-session'));
  expect(statusBar()).toContain('Native');
  expect(statusBar()).toContain('xterm-256color');
  await act(async () => { await session.leaveNative!(); });
  expect(statusBar()).toContain('xterm.js');
  expect(statusBar()).not.toContain('Native');
});

it('names xterm.js in the status bar when the native engine could not be opened', async () => {
  withCore(command => command === 'terminal_core_open' ? Promise.reject('no surface host') : undefined);
  await connectNative('bar-fallback');
  expect(statusBar()).toContain('xterm.js');
  expect(statusBar()).not.toContain('Native');
});

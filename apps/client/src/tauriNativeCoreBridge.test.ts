// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
const inApp = vi.hoisted(() => ({value: true}));
vi.mock('@tauri-apps/api/core', () => ({invoke, isTauri: () => inApp.value, Channel: class { onmessage?: (event: unknown) => void; }}));
import {setLocked} from './test/accessLock';
import type {TerminalPreferences, TerminalTheme} from './terminalAdapter';
import {createNativeTerminalAdapter, probeNativeCore, type NativeTerminalOptions, type NativeTerminalOpening} from './tauriNativeCoreBridge';

const modes = {bracketedPaste: true, mouseTracking: 'vt200', alternateScreen: false, applicationCursorKeys: true};
/** What the Rust commands answer: the state without the History lines setting, and the text of a window of rows. */
const answer = {
  state: {columns: 80, rows: 24, cursor: {x: 3, y: 1}, modes, viewport: {top: 40, rows: 24, length: 64, following: false}},
  window: {first: 40, rows: ['$ ls', 'file.txt']},
};
const commands = () => invoke.mock.calls.map(([command]) => command);
const flush = () => vi.advanceTimersByTimeAsync(0);

const transport = vi.fn();

async function open(session: Promise<string> = Promise.resolve('local:7'), options: Partial<NativeTerminalOptions> = {}): Promise<NativeTerminalOpening> {
  const opening = await createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: 5000, onTransportEvent: transport, ...options});
  opening.bind(session);
  await flush();
  return opening;
}
/** What the preferences hand the adapter whenever one changes; only the theme concerns the core. */
const preferences = (theme: TerminalTheme): TerminalPreferences => ({
  fontFamily: 'monospace', fontSize: 14, cursorStyle: 'block', cursorBlink: false, scrollbackLines: 5000, optionAsMeta: false, screenReader: false, brightBold: true, theme,
});
const forest: TerminalTheme = {background: '#101311', foreground: '#d9e0d6', cursor: '#c4eb89', red: '#f48781'};
const paper: TerminalTheme = {background: '#faf8f2', foreground: '#242822', cursor: '#375c29', extendedAnsi: ['#000000']};
const ring = (opening: NativeTerminalOpening, times = 1) => { for (let i = 0; i < times; i++) opening.events.onmessage!({type: 'changed'}); };

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
  inApp.value = true;
  invoke.mockImplementation(async (command: string) => command === 'terminal_core_snapshot' || command === 'terminal_core_scroll' ? structuredClone(answer) : undefined);
  transport.mockReset();
  setLocked(false);
});
afterEach(() => vi.useRealTimers());

describe('the native core over the Tauri commands', () => {
  it('opens the core first, waits for the session the transport started and keeps the commands in order', async () => {
    const opening = await createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: 5000});
    const {adapter, events, bind} = opening;
    expect(commands()).toEqual(['terminal_core_open']);
    expect(invoke.mock.calls[0][1]).toEqual({events, cols: 80, rows: 24, scrollbackLines: 5000});
    expect(adapter).toMatchObject({backend: 'native', dataPath: 'runtime'});
    expect(adapter.write).toBeUndefined();
    // Until the transport names its session nothing can be asked of the core, and the screen is the blank one it opened with.
    adapter.scroll({kind: 'toTop'});
    ring(opening);
    await flush();
    expect(commands()).toEqual(['terminal_core_open']);
    expect(adapter.size()).toEqual({columns: 80, rows: 24});
    expect(adapter.viewport()).toEqual({top: 0, rows: 24, length: 24, following: true});
    bind(Promise.resolve('local:7'));
    await flush();
    expect(invoke.mock.calls.slice(1).map(([command, args]) => [command, args])).toEqual([
      ['terminal_core_scroll', {sessionId: 'local:7', action: {kind: 'toTop'}}],
      ['terminal_core_snapshot', {sessionId: 'local:7'}],
    ]);
    await adapter.dispose();
  });

  it('turns the commands\' answers into the adapter\'s state, with the History lines it opened the core with', async () => {
    const {adapter} = await open();
    adapter.scroll({kind: 'toTop'});
    await flush();
    expect(adapter.viewport()).toEqual(answer.state.viewport);
    expect(adapter.modes()).toEqual(modes);
    expect(adapter.cursor()).toEqual({x: 3, y: 1});
    expect(adapter.readRows!(40, 3)).toEqual(['$ ls', 'file.txt', '']);
    expect(adapter.metrics().scrollbackLines).toBe(5000);
    await adapter.dispose();
  });

  it('opens the core with the app\'s colours and the Mosh mode, and without a config when it has neither', async () => {
    const plain = await open();
    expect(invoke.mock.calls[0][1].config).toBeUndefined();
    await plain.adapter.dispose();
    invoke.mockClear();
    const mosh = await open(undefined, {theme: forest, canonicalFrames: true});
    expect(invoke.mock.calls[0][1]).toEqual({events: mosh.events, cols: 80, rows: 24, scrollbackLines: 5000, config: {theme: forest, canonicalFrames: true}});
    // The theme the core was opened with is not sent again.
    mosh.adapter.applyPreferences(preferences({...forest}));
    await flush();
    expect(commands()).toEqual(['terminal_core_open']);
    await mosh.adapter.dispose();
  });

  it('follows Mosh\'s frames only when it was opened for them, takes sizes as intents for the transport and tells its owner when the core refuses a frame', async () => {
    const plain = await open();
    expect(() => plain.adapter.enableCanonicalResize()).toThrow('cannot apply canonical Mosh resizing');
    await plain.adapter.dispose();
    const mosh = await open(undefined, {canonicalFrames: true});
    const canonical = mosh.adapter.enableCanonicalResize();
    const heard: unknown[] = [];
    canonical.onResizeIntent(size => heard.push(size));
    mosh.adapter.subscribe(event => heard.push(event), ['failure', 'geometry']);
    invoke.mockClear();
    mosh.adapter.requestSize({columns: 100, rows: 30});
    mosh.adapter.requestSize({columns: 100, rows: 30});
    await flush();
    expect(heard).toEqual([{cols: 100, rows: 30}]);
    expect(invoke).not.toHaveBeenCalled();
    expect(mosh.adapter.size()).toEqual({columns: 80, rows: 24});
    // The core's refusal is the adapter's event, not a notice of the transport, and the display stays failed.
    mosh.events.onmessage!({type: 'failure', reason: 'partial-frame'} as never);
    mosh.events.onmessage!({type: 'failure', reason: 'invalid-frame'} as never);
    expect(heard.slice(1)).toEqual([{type: 'failure', reason: 'partial-frame'}]);
    expect(canonical.failure).toBe('partial-frame');
    expect(transport).not.toHaveBeenCalled();
    mosh.adapter.requestSize({columns: 120, rows: 40});
    expect(heard).toHaveLength(2);
    await expect(canonical.close()).resolves.toBeUndefined();
    await mosh.adapter.dispose();
  });

  it('tells an open core to keep the new History lines once, then reports the state with that number, and tries again after a refusal', async () => {
    const {adapter} = await open(undefined, {theme: forest});
    invoke.mockClear();
    adapter.applyPreferences(preferences(forest));
    await flush();
    expect(commands(), 'the number it opened with is no change').toEqual([]);
    adapter.applyPreferences({...preferences(forest), scrollbackLines: 800});
    adapter.applyPreferences({...preferences(forest), scrollbackLines: 800});
    await flush();
    expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['terminal_core_scrollback', {sessionId: 'local:7', lines: 800}],
      ['terminal_core_snapshot', {sessionId: 'local:7'}],
    ]);
    expect(adapter.metrics().scrollbackLines).toBe(800);

    // A core that refuses (a locked app, a closed session) is asked again with the next preferences.
    invoke.mockClear();
    invoke.mockRejectedValueOnce('App access is locked or this operation belongs to an earlier unlock');
    adapter.applyPreferences({...preferences(forest), scrollbackLines: 2000});
    await flush();
    expect(adapter.metrics().scrollbackLines).toBe(800);
    adapter.applyPreferences({...preferences(forest), scrollbackLines: 2000});
    await flush();
    expect(commands().filter(command => command === 'terminal_core_scrollback')).toHaveLength(2);
    expect(adapter.metrics().scrollbackLines).toBe(2000);
    await adapter.dispose();
  });

  it('tells the core about a theme change once, in order after the session starts, and not after the terminal is gone', async () => {
    const opening = await open(undefined, {theme: forest});
    opening.adapter.applyPreferences(preferences(paper));
    opening.adapter.applyPreferences(preferences({...paper}));
    await flush();
    expect(invoke.mock.calls.slice(1).map(([command, args]) => [command, args])).toEqual([['terminal_core_theme', {sessionId: 'local:7', theme: paper}]]);
    opening.adapter.applyPreferences(preferences(forest));
    await flush();
    expect(invoke).toHaveBeenLastCalledWith('terminal_core_theme', {sessionId: 'local:7', theme: forest}, expect.anything());
    await opening.adapter.dispose();
    invoke.mockClear();
    opening.adapter.applyPreferences(preferences(paper));
    await flush();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('sends the theme chosen while the app was locked once it is unlocked', async () => {
    const {adapter} = await open();
    setLocked(true);
    adapter.applyPreferences(preferences(paper));
    await flush();
    expect(commands()).toEqual(['terminal_core_open']);
    const nonce = setLocked(false);
    await flush();
    expect(invoke).toHaveBeenLastCalledWith('terminal_core_theme', {sessionId: 'local:7', theme: paper}, {headers: {'X-Lazysh-Access': nonce}});
    await adapter.dispose();
  });

  it('answers a burst of doorbells with one pull per refresh interval', async () => {
    const opening = await open();
    ring(opening, 1000);
    await flush();
    expect(commands().filter(command => command === 'terminal_core_snapshot')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15);
    expect(commands().filter(command => command === 'terminal_core_snapshot')).toHaveLength(1);
    // What rang while the pull was answered is pulled once the interval passed, and then the adapter is quiet.
    await vi.advanceTimersByTimeAsync(1);
    expect(commands().filter(command => command === 'terminal_core_snapshot')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(commands().filter(command => command === 'terminal_core_snapshot')).toHaveLength(2);
    await opening.adapter.dispose();
  });

  it('tells the core when its session is hidden and pulls nothing until it is shown again', async () => {
    const opening = await open();
    opening.adapter.setActive(false);
    ring(opening, 3);
    await vi.advanceTimersByTimeAsync(100);
    expect(commands()).toEqual(['terminal_core_open', 'terminal_core_set_active']);
    expect(invoke).toHaveBeenLastCalledWith('terminal_core_set_active', {sessionId: 'local:7', active: false}, expect.anything());
    opening.adapter.setActive(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(commands()).toEqual(['terminal_core_open', 'terminal_core_set_active', 'terminal_core_set_active', 'terminal_core_snapshot']);
    await opening.adapter.dispose();
  });

  it('forwards the program\'s reports and leaves the transport\'s own notices to its owner', async () => {
    const opening = await open();
    const seen: unknown[] = [];
    opening.adapter.subscribe(event => seen.push(event), ['title', 'bell', 'cwd', 'clipboard']);
    for (const event of [{type: 'title', title: 'build'}, {type: 'bell'}, {type: 'cwd', path: '/srv'}, {type: 'clipboard', text: 'hi'}, {type: 'closed', message: 'gone', lost: true}]) {
      opening.events.onmessage!(event as never);
    }
    expect(seen).toEqual([{type: 'title', title: 'build'}, {type: 'bell'}, {type: 'cwd', path: '/srv'}, {type: 'clipboard', text: 'hi'}]);
    expect(transport).toHaveBeenCalledExactlyOnceWith({type: 'closed', message: 'gone', lost: true});
    await opening.adapter.dispose();
  });

  it('hands the transport\'s notices to the adapter\'s transport link and frees a core whose transport never started without waiting', async () => {
    const opening = await createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: 5000});
    const notices = vi.fn();
    opening.adapter.transport!.onEvent = notices;
    opening.events.onmessage!({type: 'closed', message: 'gone'} as never);
    expect(notices).toHaveBeenCalledExactlyOnceWith({type: 'closed', message: 'gone'});
    await opening.adapter.dispose();
    expect(commands()).toEqual(['terminal_core_open']);
  });

  it('sends typed text and pasted bytes to the core as the text the program should receive', async () => {
    const {adapter} = await open();
    adapter.sendInput('ls\r', 'keyboard');
    adapter.sendInput(new TextEncoder().encode('é'), 'ime');
    // Bytes that are not text cannot be sent as text, and are dropped like input the core refuses.
    adapter.sendInput(new Uint8Array([0xff]), 'keyboard');
    adapter.sendInput('after', 'keyboard');
    await flush();
    expect(invoke.mock.calls.slice(1).map(([command, args]) => [command, args])).toEqual([
      ['terminal_core_input', {sessionId: 'local:7', input: {type: 'text', text: 'ls\r'}}],
      ['terminal_core_input', {sessionId: 'local:7', input: {type: 'text', text: 'é'}}],
      ['terminal_core_input', {sessionId: 'local:7', input: {type: 'text', text: 'after'}}],
    ]);
    await adapter.dispose();
  });

  it('sends a key as the key input the core encodes, in order with the text around it', async () => {
    const {adapter} = await open();
    const key = {type: 'key', code: 'PageUp', key: 'PageUp', mods: {shift: false, ctrl: false, alt: false, meta: false}, repeat: false, release: false, composing: false} as const;
    adapter.sendInput('a', 'ime');
    adapter.sendKey(key);
    adapter.sendKey({...key, release: true});
    adapter.sendInput('b', 'ime');
    await flush();
    expect(invoke.mock.calls.slice(1).map(([command, args]) => [command, args])).toEqual([
      ['terminal_core_input', {sessionId: 'local:7', input: {type: 'text', text: 'a'}}],
      ['terminal_core_input', {sessionId: 'local:7', input: key}],
      ['terminal_core_input', {sessionId: 'local:7', input: {...key, release: true}}],
      ['terminal_core_input', {sessionId: 'local:7', input: {type: 'text', text: 'b'}}],
    ]);
    await adapter.dispose();
  });

  it('asks the core for the selected text and for a search, and tells it which cells to highlight', async () => {
    const {adapter} = await open();
    invoke.mockClear();
    invoke.mockImplementation(async (command: string) => command === 'terminal_core_selection_text' ? 'as the core reads it' : command === 'terminal_core_search' ? {row: 9, column: 1, length: 4} : undefined);
    const range = {start: {x: 0, y: 2}, end: {x: 5, y: 3}};
    adapter.select(range);
    await flush();
    expect(adapter.selectedText()).toBe('as the core reads it');
    expect(await adapter.searchBuffer!('file', -1, 12)).toEqual({row: 9, column: 1, length: 4});
    adapter.clearSelection();
    await flush();
    expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['terminal_core_select', {sessionId: 'local:7', range}],
      ['terminal_core_selection_text', {sessionId: 'local:7', range}],
      ['terminal_core_search', {sessionId: 'local:7', query: 'file', direction: 'backward', from: 12}],
      ['terminal_core_select', {sessionId: 'local:7', range: null}],
    ]);
    await adapter.dispose();
  });

  it('asks the core which link a tap opens with one command per cell, and takes no link for no answer', async () => {
    const {adapter} = await open();
    invoke.mockClear();
    const link = {kind: 'url', uri: 'https://example.com/docs'};
    invoke.mockImplementation(async (command: string, args: {cell: {x: number}}) => command === 'terminal_core_link_at' && args.cell.x === 4 ? link : null);
    expect(await adapter.linkAt({x: 4, y: 7})).toEqual(link);
    expect(await adapter.linkAt({x: 0, y: 0})).toBeUndefined();
    expect(invoke.mock.calls.map(([command, args]) => [command, args])).toEqual([
      ['terminal_core_link_at', {sessionId: 'local:7', cell: {x: 4, y: 7}}],
      ['terminal_core_link_at', {sessionId: 'local:7', cell: {x: 0, y: 0}}],
    ]);
    await adapter.dispose();
  });

  it('drops the input of a locked app and wakes the core again after the unlock', async () => {
    const {adapter} = await open();
    setLocked(true);
    adapter.sendInput('typed while locked', 'keyboard');
    adapter.scroll({kind: 'toBottom'});
    await flush();
    expect(commands()).toEqual(['terminal_core_open']);
    const nonce = setLocked(false);
    await flush();
    // The core sends under the lease of the reader's latest command: one command under the new lease brings its doorbell back.
    expect(invoke).toHaveBeenLastCalledWith('terminal_core_set_active', {sessionId: 'local:7', active: true}, {headers: {'X-Lazysh-Access': nonce}});
    adapter.sendInput('typed after', 'keyboard');
    await flush();
    expect(invoke).toHaveBeenLastCalledWith('terminal_core_input', {sessionId: 'local:7', input: {type: 'text', text: 'typed after'}}, {headers: {'X-Lazysh-Access': nonce}});
    expect(commands().filter(command => command === 'terminal_core_input')).toHaveLength(1);
    await adapter.dispose();
  });

  it('keeps asking after a command is refused', async () => {
    const opening = await open();
    invoke.mockRejectedValueOnce('App access is locked or this operation belongs to an earlier unlock');
    ring(opening);
    await vi.advanceTimersByTimeAsync(20);
    ring(opening);
    await vi.advanceTimersByTimeAsync(20);
    expect(commands().filter(command => command === 'terminal_core_snapshot')).toHaveLength(2);
    expect(opening.adapter.viewport()).toEqual(answer.state.viewport);
    await opening.adapter.dispose();
  });

  it('frees the core once, after the commands in flight, and never touches the lease to do it', async () => {
    const {adapter} = await open();
    adapter.scroll({kind: 'toTop'});
    const first = adapter.dispose();
    expect(adapter.dispose()).toBe(first);
    await first;
    await adapter.dispose();
    expect(commands()).toEqual(['terminal_core_open', 'terminal_core_scroll', 'terminal_core_close']);
    // No lease header: a locked app may free its cores.
    expect(invoke).toHaveBeenLastCalledWith('terminal_core_close', {sessionId: 'local:7'});
  });

  it('leaves a session that never started to the failed start that already freed its core', async () => {
    const {adapter} = await open(Promise.reject(new Error('connect refused')));
    adapter.scroll({kind: 'toTop'});
    await adapter.dispose();
    expect(commands()).toEqual(['terminal_core_open']);
  });

  it('reports why a core could not be opened as an error, locked or not built in', async () => {
    invoke.mockRejectedValueOnce('The native terminal core is not built into this app');
    await expect(createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: 5000})).rejects.toThrow('not built into this app');
    setLocked(true);
    invoke.mockClear();
    await expect(createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: 5000})).rejects.toThrow('App access changed');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('the native backend probe', () => {
  const asks = (answer: unknown) => { invoke.mockResolvedValueOnce(answer); return probeNativeCore(); };

  it('passes only when the app says the core and its surface host are present and the device can draw it', async () => {
    invoke.mockResolvedValueOnce({available: true, reason: 'The native terminal core and its surface host are present'});
    expect(await asks({available: true, reason: 'The native terminal can draw on Radeon (Vulkan)', elapsedMs: 41})).toEqual({ok: true});
    expect(commands()).toEqual(['terminal_core_available', 'native_terminal_probe']);
  });

  it('refuses a device whose GPU cannot draw the terminal with the reason the app gives', async () => {
    const reason = 'The native terminal cannot draw on this device: renderer unsupported: no hardware GPU, only a software rasterizer';
    invoke.mockResolvedValueOnce({available: true, reason: 'present'});
    expect(await asks({available: false, reason, elapsedMs: 12})).toEqual({ok: false, reason});
  });

  it.each([undefined, null, {available: 'yes'}, {}])('refuses, with a reason, a device answer that is not an explicit yes (%j)', async answer => {
    invoke.mockResolvedValueOnce({available: true, reason: 'present'});
    expect(await asks(answer)).toEqual({ok: false, reason: 'the app did not report whether this device can draw a native terminal'});
  });

  it('does not probe the device of a build without the core', async () => {
    await asks({available: false, reason: 'The native terminal core is not built into this app'});
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('carries the reason the app gives for a refusal', async () => {
    expect(await asks({available: false, reason: 'The native terminal core is not built into this app'})).toEqual({ok: false, reason: 'The native terminal core is not built into this app'});
  });

  it.each([undefined, null, {available: 'yes'}, {}])('refuses, with a reason, an answer that is not an explicit yes (%j)', async answer => {
    expect(await asks(answer)).toEqual({ok: false, reason: 'the app did not report a native terminal core'});
  });

  it('refuses outside the app without calling it', async () => {
    inApp.value = false;
    expect(await probeNativeCore()).toEqual({ok: false, reason: 'this is not the lazysh app'});
    expect(invoke).not.toHaveBeenCalled();
  });

  it('leaves a rejected command to the registry, which records it', async () => {
    invoke.mockRejectedValueOnce('command not allowed');
    await expect(probeNativeCore()).rejects.toBe('command not allowed');
  });
});

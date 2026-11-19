// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({invoke, isTauri: () => true, Channel: class { onmessage?: (event: unknown) => void; }}));
import {acknowledgeAccessReady, accessSnapshot, applyAccessStatus} from './access';
import {createNativeTerminalAdapter, type NativeTerminalOpening} from './tauriNativeCoreBridge';

const modes = {bracketedPaste: true, mouseTracking: 'vt200', alternateScreen: false, applicationCursorKeys: true};
/** What the Rust commands answer: the state without the History lines setting, and the text of a window of rows. */
const answer = {
  state: {columns: 80, rows: 24, cursor: {x: 3, y: 1}, modes, viewport: {top: 40, rows: 24, length: 64, following: false}},
  window: {first: 40, rows: ['$ ls', 'file.txt']},
};
const commands = () => invoke.mock.calls.map(([command]) => command);
const flush = () => vi.advanceTimersByTimeAsync(0);

const transport = vi.fn();
let generation = 0;
/** The app's access state as the native lock reports it; an unlock is acknowledged the way the shell does. */
function setLocked(locked: boolean) {
  const nonce = String(++generation).padStart(64, 'a');
  applyAccessStatus({initialized: true, supported: true, reason: '', enabled: true, locked, generation: String(generation), ...(locked ? {} : {nonce})});
  if (!locked) acknowledgeAccessReady(accessSnapshot().epoch);
  return nonce;
}

async function open(session: Promise<string> = Promise.resolve('local:7')): Promise<NativeTerminalOpening> {
  const opening = await createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: 5000, onTransportEvent: transport});
  opening.bind(session);
  await flush();
  return opening;
}
const ring = (opening: NativeTerminalOpening, times = 1) => { for (let i = 0; i < times; i++) opening.events.onmessage!({type: 'changed'}); };

beforeEach(() => {
  vi.useFakeTimers();
  invoke.mockReset();
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

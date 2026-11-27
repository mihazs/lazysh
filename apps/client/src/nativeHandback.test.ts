// @vitest-environment jsdom
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({invoke, isTauri: () => true, Channel: class { onmessage?: (event: unknown) => void; }}));
import {StaleAccessError} from './access';
import {setLocked} from './test/accessLock';
import type {SshEvent} from './bridge';
import {handBackToXterm} from './nativeHandback';
import {openNativeTerminalAdapter} from './nativeTerminalAdapter';
import {stubMatchMedia} from './test/stubMatchMedia';
import type {LiveSession} from './terminal';
import type {TerminalAdapter} from './terminalAdapter';
import {createHeadlessCore} from './xterm/nativeCoreHeadless';
import {createXtermAdapter} from './xterm/contractHarness';

beforeAll(stubMatchMedia);

/** The pinned bytes the Rust core writes as the snapshot of a program's screen, and what xterm.js must show for it (`ansi-snapshot.json`). */
type Case = {id: string; cols: number; rows: number; scrollback: number; write: string; snapshot: string};
const fixture = resolve(process.cwd(), '../../packages/terminal-runtime/fixtures/ansi-snapshot.json');
const {cases} = JSON.parse(readFileSync(fixture, 'utf8')) as {cases: Case[]};
const program = cases.find(({id}) => id === 'history-styles-and-modes')!;
const snapshot = {ansi: program.snapshot, columns: program.cols, rows: program.rows};

const encode = (text: string) => new TextEncoder().encode(text);
const data = (text: string): SshEvent => ({type: 'data', data: [...encode(text)]});
/** What the program prints after the screen was snapshotted: three chunks, each a line, so a repeated or swapped chunk shows. */
const tail = ['\r\nfirst', '\r\nsecond', '\r\nthird'];

/** The Rust command: from its call on the transport's output goes to the new Channel; what it answers is the snapshot. */
const release = vi.hoisted(() => ({channel: undefined as undefined | {onmessage?: (event: unknown) => void}, answer: undefined as undefined | (() => Promise<typeof snapshot | null>), before: [] as unknown[]}));
beforeEach(() => {
  invoke.mockReset();
  release.channel = undefined; release.before = [];
  release.answer = async () => snapshot;
  invoke.mockImplementation(async (command: string, args: {events?: typeof release.channel}) => {
    if (command !== 'terminal_core_release') return undefined;
    release.channel = args.events;
    release.before.forEach(event => release.channel!.onmessage!(event));
    return release.answer!();
  });
  setLocked(false);
});
afterEach(() => setLocked(false));

/** A native session over the stand-in core, showing what the program wrote, and the way it handles transport events once it is on xterm.js. */
async function nativeSession() {
  const core = createHeadlessCore({columns: program.cols, rows: program.rows, scrollbackLines: program.scrollback, window: program.rows});
  const adapter = await openNativeTerminalAdapter(core);
  await adapter.write!(encode(program.write));
  const closed: SshEvent[] = [], acknowledged: number[] = [];
  const session = {id: 'native-1', adapter, selection: {id: 'native', reason: 'preference', fallbacks: []}, connected: true} as unknown as LiveSession;
  // What `prepareSession` does with a Channel terminal's events: write the data to the session's terminal, acknowledge what was applied, note the close.
  const onEvent = (event: SshEvent) => {
    if (event.type === 'data') void session.adapter.write!(new Uint8Array(event.data), () => acknowledged.push(event.data.length));
    else closed.push(event);
  };
  return {core, session, onEvent, closed, acknowledged};
}

/** The screen of an adapter: visible rows, cursor and modes. */
const shown = (adapter: TerminalAdapter) => ({lines: adapter.readRows!(adapter.viewport().top, adapter.size().rows), cursor: adapter.cursor(), modes: adapter.modes()});

describe('leaving the native engine for xterm.js', () => {
  it('shows the program\'s screen, cursor and modes, then writes every byte that arrives during and after the switch once and in order', async () => {
    const {core, session, onEvent, acknowledged, closed} = await nativeSession();
    // A fresh terminal of another size, so the size is the native one's by the switch and not by chance.
    const fresh = createXtermAdapter({cols: 80, rows: 24});
    const written: string[] = [];
    let applySnapshot!: () => void;
    const snapshotApplied = new Promise<void>(resolve => { applySnapshot = resolve; });
    const write = fresh.write.bind(fresh);
    fresh.write = (bytes, onApplied) => {
      written.push(new TextDecoder().decode(bytes));
      // The snapshot takes its time to reach the screen, so what the transport sends meanwhile has to wait for it.
      return written.length === 1 ? snapshotApplied.then(() => write(bytes, onApplied)) : write(bytes, onApplied);
    };

    release.before = [data(tail[0])];
    const switching = handBackToXterm(session, {onEvent, createXterm: async () => fresh});
    await vi.waitFor(() => expect(written).toEqual([program.snapshot]));
    release.channel!.onmessage!(data(tail[1]));
    expect(session.adapter.backend).toBe('native');
    expect(written).toEqual([program.snapshot]);

    applySnapshot();
    expect(await switching).toBe(true);
    expect(session.adapter).toBe(fresh);
    release.channel!.onmessage!(data(tail[2]));
    release.channel!.onmessage!({type: 'closed', message: 'done', lost: false});
    await vi.waitFor(() => expect(acknowledged).toHaveLength(3));

    expect(written).toEqual([program.snapshot, ...tail]);
    expect(acknowledged).toEqual(tail.map(chunk => chunk.length));
    expect(closed).toEqual([{type: 'closed', message: 'done', lost: false}]);
    expect(fresh.size()).toEqual({columns: program.cols, rows: program.rows});
    expect(session.selection).toEqual({id: 'xterm', reason: 'switched', fallbacks: []});
    expect(session.leaveNative).toBeUndefined();
    expect(core.closed).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0].slice(0, 2)).toEqual(['terminal_core_release', {sessionId: 'native-1', events: release.channel}]);

    // The screen is the one a terminal that had run the whole program shows.
    const reference = createXtermAdapter({cols: program.cols, rows: program.rows, scrollback: program.scrollback});
    await reference.write(encode(program.write + tail.join('')));
    expect(shown(fresh)).toEqual(shown(reference));
    await Promise.all([fresh.dispose(), reference.dispose()]);
  });

  it('uses the grid that accompanies the snapshot when the native mirror is stale', async () => {
    const {session, onEvent} = await nativeSession();
    vi.spyOn(session.adapter, 'size').mockReturnValue({columns: 80, rows: 24});
    const fresh = createXtermAdapter();
    expect(await handBackToXterm(session, {onEvent, createXterm: async () => fresh})).toBe(true);
    expect(fresh.size()).toEqual({columns: program.cols, rows: program.rows});
    await fresh.dispose();
  });

  it('restores Mosh geometry before queued frames and keeps resize requests as intents', async () => {
    const {session, onEvent, acknowledged} = await nativeSession();
    const previous = session.moshResize = session.adapter.enableCanonicalResize!();
    const fresh = createXtermAdapter({cols: 80, rows: 24});
    release.answer = async () => ({ansi: 'restored', columns: 30, rows: 6});
    const frame = '\x1b]7777;lazysh-mosh;1;begin;8;42;9\x1b\\next\x1b]7777;lazysh-mosh;1;end;8\x1b\\';
    release.before = [data(frame)];
    const snapshotSizes: {columns: number; rows: number}[] = [];
    const write = fresh.write.bind(fresh);
    fresh.write = (bytes, applied) => { snapshotSizes.push(fresh.size()); return write(bytes, applied); };
    expect(await handBackToXterm(session, {onEvent, createXterm: async () => fresh})).toBe(true);
    await vi.waitFor(() => expect(acknowledged).toEqual([frame.length]));
    expect(snapshotSizes[0]).toEqual({columns: 30, rows: 6});
    expect(fresh.size()).toEqual({columns: 42, rows: 9});
    expect(session.moshResize).not.toBe(previous);
    expect(session.moshResize?.failure).toBeNull();
    const intent = vi.fn();
    session.moshResize?.onResizeIntent(intent);
    fresh.requestSize({columns: 50, rows: 12});
    expect(intent).toHaveBeenCalledWith({cols: 50, rows: 12});
    expect(fresh.size()).toEqual({columns: 42, rows: 9});
    await fresh.dispose();
  });

  it('records the failure as the reason when the native engine broke, so the session says why it is on xterm.js', async () => {
    const {session, onEvent} = await nativeSession();
    await handBackToXterm(session, {onEvent, createXterm: async () => createXtermAdapter(), failure: 'failed: surface lost'});
    expect(session.selection).toEqual({id: 'xterm', reason: 'fallback', fallbacks: [{id: 'native', reason: 'failed: surface lost'}]});
    await session.adapter.dispose();
  });

  it('still moves the session when the core cannot answer, because the output already flows to xterm.js', async () => {
    const {session, onEvent, acknowledged} = await nativeSession();
    release.answer = async () => null;
    release.before = [data(tail[0])];
    expect(await handBackToXterm(session, {onEvent, createXterm: async () => createXtermAdapter({cols: program.cols, rows: program.rows})})).toBe(false);
    expect(session.adapter.backend).toBe('xterm');
    release.channel!.onmessage!(data(tail[1]));
    await vi.waitFor(() => expect(acknowledged).toEqual([tail[0].length, tail[1].length]));
    expect(shown(session.adapter).lines.join('\n')).toContain('first\nsecond');
    await session.adapter.dispose();
  });

  it('keeps the native adapter when the bridge refuses before redirecting output', async () => {
    const {session, onEvent, core} = await nativeSession();
    const native = session.adapter;
    const fresh = createXtermAdapter();
    release.answer = async () => { throw new Error('Handback refused'); };
    await expect(handBackToXterm(session, {onEvent, createXterm: async () => fresh})).rejects.toThrow('Handback refused');
    expect(session.adapter).toBe(native);
    expect(core.closed).toBe(false);
    await expect(fresh.write(encode('late'))).rejects.toThrow('disposed');
    await native.dispose();
  });

  it('leaves the session on the native engine when the app is locked: nothing was sent', async () => {
    const {session, onEvent} = await nativeSession();
    setLocked(true);
    const native = session.adapter;
    await expect(handBackToXterm(session, {onEvent, createXterm: async () => createXtermAdapter()})).rejects.toBeInstanceOf(StaleAccessError);
    expect(session.adapter).toBe(native);
    expect(invoke).not.toHaveBeenCalled();
    await native.dispose();
  });

  it('does not start a handback under a new lease after preparing xterm', async () => {
    const {session, onEvent} = await nativeSession();
    const native = session.adapter;
    const fresh = createXtermAdapter();
    const createXterm = async () => {
      setLocked(true);
      setLocked(false);
      return fresh;
    };
    await expect(handBackToXterm(session, {onEvent, createXterm})).rejects.toBeInstanceOf(StaleAccessError);
    expect(invoke).not.toHaveBeenCalled();
    expect(session.adapter).toBe(native);
    await native.dispose();
  });

  it('keeps a committed channel after lock and never applies a stale snapshot', async () => {
    const {session, onEvent, acknowledged} = await nativeSession();
    const fresh = createXtermAdapter();
    const write = vi.spyOn(fresh, 'write');
    release.answer = async () => {
      setLocked(true);
      release.channel!.onmessage!(data(tail[0]));
      return snapshot;
    };
    expect(await handBackToXterm(session, {onEvent, createXterm: async () => fresh})).toBe(false);
    expect(session.adapter).toBe(fresh);
    expect(write).not.toHaveBeenCalled();
    setLocked(false);
    await vi.waitFor(() => expect(acknowledged).toEqual([tail[0].length]));
    expect(shown(fresh).lines.join('\n')).toContain('first');
    await fresh.dispose();
  });

  it('refuses a session that is not on the native engine', async () => {
    const {session, onEvent} = await nativeSession();
    session.adapter = createXtermAdapter();
    await expect(handBackToXterm(session, {onEvent, createXterm: async () => createXtermAdapter()})).rejects.toThrow('not on the native engine');
    await session.adapter.dispose();
  });

  it('drops the new terminal when the session was closed while it moved', async () => {
    const {session, onEvent} = await nativeSession();
    const fresh = createXtermAdapter();
    release.answer = async () => { session.disposed = true; return snapshot; };
    expect(await handBackToXterm(session, {onEvent, createXterm: async () => fresh})).toBe(false);
    expect(session.adapter.backend).toBe('native');
    await expect(fresh.write(encode('late'))).rejects.toThrow('disposed');
    await session.adapter.dispose();
  });
});

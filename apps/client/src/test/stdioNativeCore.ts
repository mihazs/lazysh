/**
 * A {@link NativeCoreBridge} over the real core: the runtime crate's stdio harness (`examples/control_stdio.rs`, JSON-RPC
 * lines) as a child process, so the adapter runs over libghostty-vt and not over the stand-in of `nativeCoreHeadless.ts`.
 * Like the stand-in, the WebView hands it the transport's bytes (`feed`) and sizes it (`resize`). Test-only.
 */
import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {createInterface} from 'node:readline';
import type {NativeCoreBridge, NativeCoreEvent, NativeCoreSnapshot} from '../nativeCoreBridge';

/** What the harness answers: a snapshot without the History lines setting, which the client opened the core with. */
type Answer = {state: Omit<NativeCoreSnapshot['state'], 'scrollbackLines'>; window: NativeCoreSnapshot['window']};

export type StdioCoreOptions = {columns?: number; rows?: number; scrollbackLines?: number};

const noop = () => {};

export async function openStdioCore(binary: string, {columns = 20, rows = 5, scrollbackLines: opened = 200}: StdioCoreOptions = {}): Promise<NativeCoreBridge> {
  const child = spawn(binary, [], {stdio: ['pipe', 'pipe', 'inherit']});
  child.stdin.on('error', noop);
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  const pending = new Map<number, {resolve(result: unknown): void; reject(error: Error): void}>();
  const events = new EventEmitter();
  let lastId = 0;

  createInterface({input: child.stdout}).on('line', line => {
    const message = JSON.parse(line) as {id?: number; method?: string; params?: NativeCoreEvent; result?: unknown; error?: {message: string}};
    if (message.method === 'event') {
      // `changed` is the doorbell of a core that owns its transport; here the WebView feeds the core and every answer carries the state.
      if (message.params!.type !== 'changed') events.emit('event', message.params);
      return;
    }
    const call = pending.get(message.id!);
    pending.delete(message.id!);
    if (message.error) call?.reject(new Error(message.error.message)); else call?.resolve(message.result);
  });
  const ended = (reason: string) => () => { pending.forEach(call => call.reject(new Error(reason))); pending.clear(); };
  child.once('exit', ended('The core process ended.'));
  // A binary that cannot start never exits: fail its requests with the reason instead of waiting for it.
  child.once('error', error => ended(`The core process did not start: ${error.message}`)());

  const request = <T>(method: string, params: object = {}) => new Promise<T>((resolve, reject) => {
    const id = ++lastId;
    pending.set(id, {resolve: resolve as (result: unknown) => void, reject});
    child.stdin.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
  });
  let scrollbackLines = opened;
  const state = (method: string, params?: object) => request<Answer>(method, params).then((answer): NativeCoreSnapshot => ({window: answer.window, state: {...answer.state, scrollbackLines}}));

  await request('open', {columns, rows, scrollbackLines: opened});
  let closing: Promise<void> | undefined;
  return {
    snapshot: () => state('snapshot'),
    scroll: action => state('scroll', {action}),
    feed: bytes => state('feed', {data: Buffer.from(bytes).toString('base64')}),
    resize: size => state('resize', size),
    setScrollback: async lines => { const snapshot = await state('scrollback', {lines}); scrollbackLines = lines; return {...snapshot, state: {...snapshot.state, scrollbackLines}}; },
    canonicalFrames: () => request<null>('canonical').then(noop),
    async input(data) { await request('input', {text: typeof data === 'string' ? data : new TextDecoder().decode(data)}); },
    // shortcut: the harness encodes text only; give it a `key` method when a real-core key case exists.
    async key() { throw new Error('The stdio harness has no key input.'); },
    setActive(active) { request('setActive', {active}).catch(noop); },
    query: query => request('query', {query}),
    select(range) { request('select', {range: range ?? null}).catch(noop); },
    subscribe(listener) {
      events.on('event', listener);
      return {dispose: () => { events.off('event', listener); }};
    },
    close() { return closing ??= request('close').catch(noop).then(() => exited); },
  };
}

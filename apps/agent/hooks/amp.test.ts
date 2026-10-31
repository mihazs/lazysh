import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import lazysh from './amp.js';

afterEach(() => mock.restore());

function sdk() {
  const handlers = new Map<string, Function>();
  const subscriptions: { unsubscribe: ReturnType<typeof mock> }[] = [];
  let dispose!: () => Promise<void>;
  const amp = {
    system: { workspaceRoot: 'file:///owned/project' },
    helpers: { filePathFromURI: (uri: string) => new URL(uri).pathname },
    on(name: string, callback: Function) { handlers.set(name, callback); const sub = { unsubscribe: mock() }; subscriptions.push(sub); return sub; },
    onDispose(callback: () => Promise<void>) { dispose = callback; },
  };
  lazysh(amp);
  function thread(id: string, initial: Promise<string> = Promise.resolve('running')) {
    let receive!: (state: string) => void;
    const unsubscribe = mock();
    const context = { thread: { id, state: { subscribe(callback: (state: string) => void) { receive = callback; return { unsubscribe }; }, get: () => initial } }, messages: ['PRIVATE_CONTEXT'] };
    return { context, emit: (state: string) => receive(state), unsubscribe };
  }
  return { handlers, thread, subscriptions, dispose: () => dispose() };
}

async function settle() { await Bun.sleep(0); }

function companion() {
  const payloads: unknown[] = [];
  const spawn = spyOn(childProcess, 'spawn').mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.kill = mock(() => { child.emit('close', null, 'SIGKILL'); return true; });
    let input = '';
    child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
    child.stdin.on('finish', () => { payloads.push(JSON.parse(input)); queueMicrotask(() => child.emit('close', 0)); });
    return child;
  });
  return { payloads, spawn };
}

test('actual Amp asset observes exact native states and thread identities without tool decisions or private messages', async () => {
  const { payloads, spawn } = companion();
  const amp = sdk();
  expect([...amp.handlers.keys()]).toEqual(['session.start', 'agent.start']);
  const first = amp.thread('T-first');
  expect(amp.handlers.get('session.start')!({}, first.context)).toBeUndefined();
  await settle();
  for (const state of ['awaiting-approval', 'running', 'idle', 'error']) { first.emit(state); await settle(); }
  amp.handlers.get('agent.start')!({}, first.context);
  const second = amp.thread('T-second', Promise.resolve('idle'));
  amp.handlers.get('agent.start')!({}, second.context);
  await settle();
  expect(payloads).toEqual([
    ...['running', 'awaiting-approval', 'running', 'idle', 'error'].map(state => ({ schemaVersion: 1, threadId: 'T-first', directory: '/owned/project', state })),
    { schemaVersion: 1, threadId: 'T-second', directory: '/owned/project', state: 'idle' },
  ]);
  expect(JSON.stringify(payloads)).not.toContain('PRIVATE_CONTEXT');
  expect(spawn.mock.calls[0]).toEqual(['lazysh-agent', ['ingest', '--agent', 'amp'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000, killSignal: 'SIGKILL' }]);
  await amp.dispose();
  expect(first.unsubscribe).toHaveBeenCalledOnce();
  expect(second.unsubscribe).toHaveBeenCalledOnce();
  for (const registration of amp.subscriptions) expect(registration.unsubscribe).toHaveBeenCalledOnce();
  first.emit('running');
  amp.handlers.get('agent.start')!({}, amp.thread('T-after-dispose').context);
  expect(spawn).toHaveBeenCalledTimes(6);
});

test('a delayed initial state cannot overwrite a newer approval or revive a disposed observer', async () => {
  const { payloads, spawn } = companion();
  const amp = sdk();
  let initial!: (state: string) => void;
  const thread = amp.thread('T-race', new Promise(resolve => { initial = resolve; }));
  amp.handlers.get('session.start')!({}, thread.context);
  thread.emit('awaiting-approval');
  await settle();
  initial('running');
  await settle();
  expect(payloads).toEqual([{ schemaVersion: 1, threadId: 'T-race', directory: '/owned/project', state: 'awaiting-approval' }]);
  let late!: (state: string) => void;
  const pending = amp.thread('T-disposed', new Promise(resolve => { late = resolve; }));
  amp.handlers.get('session.start')!({}, pending.context);
  await amp.dispose();
  late('running');
  await settle();
  expect(spawn).toHaveBeenCalledOnce();
});

test('companion absence cannot reject native events or make approval decisions', async () => {
  const actualSpawn = childProcess.spawn.bind(childProcess);
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((_command, _args, options) => actualSpawn('/lazysh-owned-missing-companion/not-present', [], options));
  const amp = sdk();
  const thread = amp.thread('T-no-companion');
  expect(amp.handlers.get('session.start')!({}, thread.context)).toBeUndefined();
  await settle();
  thread.emit('awaiting-approval');
  await settle();
  await amp.dispose();
  expect(spawn).toHaveBeenCalledTimes(2);
});

test('native observer deadline and disposal kill and reap actual SIGTERM-resistant companions', async () => {
  for (const mode of ['deadline', 'disposal']) {
  const actualSpawn = childProcess.spawn.bind(childProcess);
  let child!: ReturnType<typeof childProcess.spawn>;
  let ready!: Promise<string>;
  spyOn(childProcess, 'spawn').mockImplementation((_command, _args, options) => {
    child = actualSpawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)"], { ...options, stdio: ['pipe', 'pipe', 'ignore'] });
    ready = once(child.stdout!, 'data').then(([data]) => data.toString().trim());
    return child;
  });
  const amp = sdk();
  amp.handlers.get('session.start')!({}, amp.thread('T-child').context);
  await settle();
  try {
    expect(await Promise.race([ready, Bun.sleep(1000).then(() => 'NOT_READY')])).toBe('READY');
    const started = performance.now();
    if (mode === 'disposal') await amp.dispose();
    else { await once(child, 'close'); await amp.dispose(); }
    expect(performance.now() - started).toBeLessThan(mode === 'disposal' ? 1000 : 4500);
    expect(child.signalCode).toBe('SIGKILL');
    expect(child.exitCode).not.toBe(0);
  } finally { if (child && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'close'); } }
  mock.restore();
  }
});


test('per-thread writes stay ordered and coalesce state while another write is pending', async () => {
  const payloads: any[] = [];
  const close: (() => void)[] = [];
  spyOn(childProcess, 'spawn').mockImplementation(() => {
    const child = new EventEmitter() as any;
    child.stdin = new PassThrough();
    child.kill = () => { child.emit('close', null, 'SIGKILL'); return true; };
    let input = '';
    child.stdin.on('data', (chunk: Buffer) => { input += chunk.toString(); });
    child.stdin.on('finish', () => { payloads.push(JSON.parse(input)); close.push(() => child.emit('close', 0)); });
    return child;
  });
  const amp = sdk();
  const thread = amp.thread('T-ordered');
  amp.handlers.get('agent.start')!({}, thread.context);
  await settle();
  thread.emit('awaiting-approval');
  thread.emit('running');
  thread.emit('idle');
  await settle();
  expect(payloads.map(item => item.state)).toEqual(['running']);
  close.shift()!();
  await settle();
  expect(payloads.map(item => item.state)).toEqual(['running', 'idle']);
  close.shift()!();
  await settle();
  await amp.dispose();
});

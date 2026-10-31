import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { LazyshPlugin } from './opencode.js';

afterEach(() => mock.restore());

test('actual plugin projects native lifecycle metadata without prompts, errors or approval decisions', async () => {
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({ exited: Promise.resolve(0), kill() {} }) as ReturnType<typeof Bun.spawn>);
  const plugin = await LazyshPlugin({ directory: '/owned/project' });
  for (const type of ['session.status', 'permission.asked', 'question.asked', 'session.deleted', 'session.error']) {
    await plugin.event({ event: { type, properties: { sessionID: 'ses_owned', status: { type: 'busy', message: 'PRIVATE' }, prompt: 'SECRET', patterns: ['PRIVATE'], error: { message: 'PRIVATE' } } } });
    const [command, options] = spawn.mock.calls.at(-1)!;
    expect(command).toEqual(['lazysh-agent', 'ingest', '--agent', 'opencode']);
    expect(options!.stdout).toBe('ignore');
    expect(options!.stderr).toBe('ignore');
    const payload = JSON.parse(await (options!.stdin as Blob).text());
    expect(payload).toEqual({ type, directory: '/owned/project', properties: { sessionID: 'ses_owned', ...(type === 'session.status' ? { status: { type: 'busy' } } : {}) } });
  }
  const before = spawn.mock.calls.length;
  for (const event of [{ type: 'message.updated', properties: { sessionID: 'secret' } }, { type: 'session.idle', properties: { sessionID: 'ses_owned' } }, { type: 'session.error', properties: {} }]) {
    expect(await plugin.event({ event })).toBeUndefined();
  }
  expect(spawn).toHaveBeenCalledTimes(before);
});

test('missing companion never rejects the native plugin callback', async () => {
  spyOn(Bun, 'spawn').mockImplementation(() => { throw new Error('missing companion'); });
  const plugin = await LazyshPlugin({ directory: '/owned/project' });
  await expect(plugin.event({ event: { type: 'permission.asked', properties: { sessionID: 'ses_owned' } } })).resolves.toBeUndefined();
});

test('slow companion is killed at the bounded deadline and its completion is observed', async () => {
  let finish!: (code: number) => void;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const kill = mock(() => finish(143));
  spyOn(Bun, 'spawn').mockImplementation(() => ({ exited, kill }) as unknown as ReturnType<typeof Bun.spawn>);
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { callback(); return 1; }) as typeof setTimeout);
  const clear = spyOn(globalThis, 'clearTimeout');
  const plugin = await LazyshPlugin({ directory: '/owned/project' });
  await expect(plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_owned', status: { type: 'busy' } } } })).resolves.toBeUndefined();
  expect(timer.mock.calls[0][1]).toBe(3000);
  expect(kill).toHaveBeenCalledOnce();
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  expect(clear).toHaveBeenCalledWith(1);
});

test('deadline terminates and reaps an actual owned child without rejecting the event', async () => {
  const actualSpawn = Bun.spawn.bind(Bun);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let ready: Promise<string> | undefined;
  spyOn(Bun, 'spawn').mockImplementation((_command, options) => {
    child = actualSpawn([process.execPath, '-e', "process.on('SIGTERM', () => {}); console.log('READY'); await Bun.sleep(60_000)"], { ...options, stdout: 'pipe' });
    ready = (child.stdout as ReadableStream<Uint8Array>).getReader().read().then(({ value }) => new TextDecoder().decode(value).trim());
    return child;
  });
  const plugin = await LazyshPlugin({ directory: '/owned/project' });
  const started = performance.now();
  const completed = plugin.event({ event: { type: 'permission.asked', properties: { sessionID: 'ses_owned' } } });
  try {
    expect(await Promise.race([ready, Bun.sleep(1000).then(() => 'NOT_READY')])).toBe('READY');
    await expect(completed).resolves.toBeUndefined();
  } finally {
    child?.kill('SIGKILL');
    await child?.exited;
  }
  expect(performance.now() - started).toBeLessThan(5000);
  expect(child!.signalCode).toBe('SIGKILL');
  expect(await child!.exited).not.toBe(0);
});

test('v2 default exposes both native loaders and scopes lifecycle metadata to its location', async () => {
  const definition = (await import('./opencode.js')).default;
  expect(definition.id).toBe('lazysh');
  expect(definition.server).toBe(LazyshPlugin);
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({ exited: Promise.resolve(0), kill() {} }) as ReturnType<typeof Bun.spawn>);
  async function* events() {
    for (const directory of ['/other/project', '/owned/project']) {
      yield { type: 'session.status', location: { directory }, data: { sessionID: 'ses_owned', status: { type: 'busy', message: 'SECRET' } } };
    }
    yield { type: 'form.created', location: { directory: '/owned/project' }, data: { form: { sessionID: 'global', title: 'SECRET' } } };
    yield { type: 'form.created', location: { directory: '/owned/project' }, data: { form: { sessionID: 'ses_child', fields: ['SECRET'] } } };
    yield { type: 'session.execution.failed', location: { directory: '/owned/project' }, data: { sessionID: 'ses_child', error: { message: 'SECRET' } } };
    yield { type: 'permission.asked', location: { directory: '/owned/project' }, data: { sessionID: 'ses_child', resources: ['SECRET'] } };
    yield { type: 'session.deleted', location: { directory: '/owned/project' }, data: { sessionID: 'ses_child' } };
  }
  const dispose = await definition.setup({ location: { directory: '/owned/project' }, event: { subscribe: () => events() } });
  await Bun.sleep(20);
  await dispose();
  const payloads = await Promise.all(spawn.mock.calls.map(async ([, options]) => JSON.parse(await (options!.stdin as Blob).text())));
  expect(payloads).toEqual([
    { type: 'session.status', directory: '/owned/project', properties: { sessionID: 'ses_owned', status: { type: 'busy' } } },
    { type: 'question.asked', directory: '/owned/project', properties: { sessionID: 'ses_child' } },
    { type: 'session.error', directory: '/owned/project', properties: { sessionID: 'ses_child' } },
    { type: 'permission.asked', directory: '/owned/project', properties: { sessionID: 'ses_child' } },
    { type: 'session.deleted', directory: '/owned/project', properties: { sessionID: 'ses_child' } },
  ]);
});

test('concurrent native callbacks keep the latest pending state and unload reaps the active writer', async () => {
  let finish!: (code: number) => void;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const kill = mock(() => finish(137));
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({ exited, kill }) as unknown as ReturnType<typeof Bun.spawn>);
  const plugin = await LazyshPlugin({ directory: '/owned/project' });
  const send = (id: string, type: string) => plugin.event({ event: { type: 'session.status', properties: { sessionID: id, status: { type } } } });
  const active = send('ses_active', 'busy');
  const replaced = send('ses_pending', 'busy');
  const pending = send('ses_pending', 'idle');
  await replaced;
  expect(spawn).toHaveBeenCalledOnce();
  await plugin.dispose();
  await Promise.all([active, pending]);
  await send('ses_after_unload', 'busy');
  expect(kill).toHaveBeenCalledWith('SIGKILL');
  expect(spawn).toHaveBeenCalledOnce();
});

test('pending state cannot overtake an active write and then drains in native session order', async () => {
  let finish!: (code: number) => void;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const spawn = spyOn(Bun, 'spawn')
    .mockImplementationOnce(() => ({ exited, kill() {} }) as ReturnType<typeof Bun.spawn>)
    .mockImplementation(() => ({ exited: Promise.resolve(0), kill() {} }) as ReturnType<typeof Bun.spawn>);
  const plugin = await LazyshPlugin({ directory: '/owned/project' });
  const send = (type: string) => plugin.event({ event: { type: 'session.status', properties: { sessionID: 'ses_owned', status: { type } } } });
  const active = send('busy');
  const pending = send('idle');
  expect(spawn).toHaveBeenCalledOnce();
  finish(0);
  await Promise.all([active, pending]);
  const states = await Promise.all(spawn.mock.calls.map(async ([, options]) => JSON.parse(await (options!.stdin as Blob).text()).properties.status.type));
  expect(states).toEqual(['busy', 'idle']);
  await plugin.dispose();
});

test('an overloaded native callback burst stays bounded and queued writes are discarded on unload', async () => {
  let finish!: (code: number) => void;
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({ exited, kill: () => finish(137) }) as ReturnType<typeof Bun.spawn>);
  const plugin = await LazyshPlugin({ directory: '/owned/project' });
  const writes = Array.from({ length: 80 }, (_, index) => plugin.event({ event: {
    type: 'session.status', properties: { sessionID: `ses_${index}`, status: { type: 'busy' } },
  } }));
  let evicted = 0;
  for (const write of writes.slice(1)) void write.then(() => { evicted++; });
  await Bun.sleep(0);
  expect(evicted).toBe(15);
  expect(spawn).toHaveBeenCalledOnce();
  await plugin.dispose();
  await Promise.all(writes);
  expect(spawn).toHaveBeenCalledOnce();
});

async function v2Fixture(list: () => Promise<unknown>) {
  const definition = (await import('./opencode.js')).default;
  const queue: unknown[] = [];
  let wake = () => {};
  const dispose = await definition.setup({ location: { directory: '/owned/project' }, session: { list }, event: {
    subscribe: ({ signal }: { signal: AbortSignal }) => ({ async *[Symbol.asyncIterator]() {
      signal.addEventListener('abort', () => wake(), { once: true });
      while (!signal.aborted) {
        if (queue.length) yield queue.shift();
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } }),
  } });
  return { dispose, async emit(type: string, data: unknown) { queue.push({ type, data }); wake(); await Bun.sleep(0); } };
}

test('live create, move and deletion win over a held initial inventory without resurrecting stale ownership', async () => {
  let finish!: (value: unknown) => void;
  const list = mock(() => new Promise(resolve => { finish = resolve; }));
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({ exited: Promise.resolve(0), kill() {} }) as ReturnType<typeof Bun.spawn>);
  const fixture = await v2Fixture(list);
  await fixture.emit('session.created', { sessionID: 'ses_moved', location: { directory: '/owned/project' } });
  await fixture.emit('session.moved', { sessionID: 'ses_moved', location: { directory: '/other/project' } });
  await fixture.emit('session.created', { sessionID: 'ses_deleted', location: { directory: '/owned/project' } });
  await fixture.emit('session.deleted', { sessionID: 'ses_deleted' });
  expect(spawn).toHaveBeenCalledOnce();
  finish({ data: ['ses_moved', 'ses_deleted', 'ses_existing'].map(id => ({ id, location: { directory: '/owned/project' } })) });
  await Bun.sleep(0);
  for (const sessionID of ['ses_moved', 'ses_deleted', 'ses_existing']) await fixture.emit('session.deleted', { sessionID });
  expect(spawn).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenCalledWith({ directory: '/owned/project', limit: 128 });
  const last = JSON.parse(await (spawn.mock.calls.at(-1)![1]!.stdin as Blob).text());
  expect(last.properties.sessionID).toBe('ses_existing');
  await fixture.dispose();
});

test('overflow discards the whole held bootstrap and disposal ignores its uncancellable late result', async () => {
  let finish!: (value: unknown) => void;
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({ exited: Promise.resolve(0), kill() {} }) as ReturnType<typeof Bun.spawn>);
  const fixture = await v2Fixture(() => new Promise(resolve => { finish = resolve; }));
  for (let index = 0; index < 257; index++) await fixture.emit('session.moved', { sessionID: `ses_${index}`, location: { directory: '/other/project' } });
  finish({ data: [{ id: 'ses_existing', location: { directory: '/owned/project' } }] });
  await Bun.sleep(0);
  await fixture.emit('session.deleted', { sessionID: 'ses_existing' });
  expect(spawn).not.toHaveBeenCalled();
  await fixture.dispose();
  let late!: (value: unknown) => void;
  const closed = await v2Fixture(() => new Promise(resolve => { late = resolve; }));
  await closed.dispose();
  late({ data: [{ id: 'ses_late', location: { directory: '/owned/project' } }] });
  await closed.emit('session.deleted', { sessionID: 'ses_late' });
  expect(spawn).not.toHaveBeenCalled();
});

test('verified location ownership is bounded and a timed-out inventory cannot attribute later events', async () => {
  const spawn = spyOn(Bun, 'spawn').mockImplementation(() => ({ exited: Promise.resolve(0), kill() {} }) as ReturnType<typeof Bun.spawn>);
  const fixture = await v2Fixture(async () => ({ data: [] }));
  for (let index = 0; index < 257; index++) await fixture.emit('session.created', { sessionID: `ses_${index}`, location: { directory: '/owned/project' } });
  await fixture.emit('session.deleted', { sessionID: 'ses_0' });
  expect(spawn).not.toHaveBeenCalled();
  await fixture.emit('session.deleted', { sessionID: 'ses_256' });
  expect(spawn).toHaveBeenCalledOnce();
  await fixture.dispose();
  let late!: (value: unknown) => void;
  const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void) => { queueMicrotask(callback); return 1; }) as typeof setTimeout);
  const timed = await v2Fixture(() => new Promise(resolve => { late = resolve; }));
  expect(timer.mock.calls[0][1]).toBe(3000);
  timer.mockRestore();
  late({ data: [{ id: 'ses_late', location: { directory: '/owned/project' } }] });
  await timed.emit('session.deleted', { sessionID: 'ses_late' });
  expect(spawn).toHaveBeenCalledOnce();
  await timed.dispose();
});

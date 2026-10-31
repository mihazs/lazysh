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

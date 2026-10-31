import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import childProcess from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';

afterEach(() => mock.restore());
let imports = 0;
async function plugin() {
  const value = (await import(`./cline.js?owned=${imports++}`)).default;
  let dispose!: () => Promise<void>;
  value.setup({}, { cwd: '/owned/project', onDispose(callback: () => Promise<void>) { dispose = callback; } });
  return { hooks: value.hooks, dispose: () => dispose(), value };
}
function snapshot(runId = 'run_one', extra = {}) {
  return { agentId: 'agent_root', conversationId: 'conv_root', runId, parentAgentId: null, messages: ['PRIVATE'], ...extra };
}
function recorder() {
  const payloads: any[] = [];
  const exec = spyOn(childProcess, 'execFile').mockImplementation((_file: any, _args: any, _options: any, callback: any) => {
    const child: any = new EventEmitter();
    child.stdin = new PassThrough();
    child.kill = mock(() => { callback(null, '', ''); return true; });
    let input = '';
    child.stdin.on('data', (data: Buffer) => { input += data.toString(); });
    child.stdin.on('finish', () => { payloads.push(JSON.parse(input)); queueMicrotask(() => callback(null, '', '')); });
    return child;
  });
  return { payloads, exec };
}

test('original Cline plugin observes only attributed root runs without policy or private content', async () => {
  const { payloads, exec } = recorder();
  const p = await plugin();
  expect(p.value.manifest.capabilities).toEqual(['hooks']);
  expect(Object.keys(p.hooks)).toEqual(['beforeRun', 'afterRun']);
  const first = snapshot();
  expect(await p.hooks.beforeRun({ snapshot: first })).toBeUndefined();
  expect(await p.hooks.afterRun({ snapshot: first, result: { runId: first.runId, status: 'completed', outputText: 'SECRET' } })).toBeUndefined();
  const second = snapshot('run_two');
  await p.hooks.beforeRun({ snapshot: second });
  await p.hooks.afterRun({ snapshot: second, result: { runId: second.runId, status: 'failed', error: { message: 'SECRET' } } });
  expect(payloads).toEqual(['start', 'completed', 'start', 'failed'].map((status, index) => ({ schemaVersion: 1, agentId: first.agentId, conversationId: first.conversationId, runId: index < 2 ? 'run_one' : 'run_two', parentAgentId: null, directory: '/owned/project', status })));
  expect(exec.mock.calls[0].slice(0,3)).toEqual(['lazysh-agent', ['ingest','--agent','cline'], { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024, windowsHide: true }]);
  await p.dispose();
});

test('child runs, unknown finishes and stale native run identities never change root reports', async () => {
  const { payloads } = recorder(); const p = await plugin();
  for (const extra of [{ parentAgentId: 'agent_parent' }, { runId: '' }, { conversationId: '' }]) {
    await p.hooks.beforeRun({ snapshot: snapshot('run_child', extra) });
  }
  await p.hooks.afterRun({ snapshot: snapshot('run_unknown'), result: { runId: 'run_unknown', status: 'completed' } });
  await p.hooks.beforeRun({ snapshot: snapshot() });
  await p.hooks.beforeRun({ snapshot: snapshot('run_new') });
  for (const [state, result] of [[snapshot(), { runId:'run_one',status:'completed' }], [snapshot('run_new'), { runId:'run_wrong',status:'completed' }], [snapshot('run_new'), { runId:'run_new',status:'unknown' }]]) await p.hooks.afterRun({ snapshot:state, result });
  expect(payloads.map(p=>p.status)).toEqual(['start','start']);
  await p.dispose();
  await p.hooks.beforeRun({ snapshot: snapshot('run_disposed') });
  expect(payloads).toHaveLength(2);
});

test('the fixed writer deadline and disposal reap actual owned children without rejecting Cline', async () => {
  const original = childProcess.execFile.bind(childProcess);
  for (const disposeEarly of [false, true]) {
    let child!: childProcess.ChildProcess;
    let spawned!: Promise<unknown>;
    spyOn(childProcess, 'execFile').mockImplementation((_file: any, _args: any, options: any, callback: any) => {
      child = original(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], options, callback);
      spawned = once(child, 'spawn');
      return child as any;
    });
    const p = await plugin();
    const started = performance.now();
    const writing = p.hooks.beforeRun({ snapshot: snapshot() });
    await Bun.sleep(0);
    try {
      await spawned;
      if (disposeEarly) await p.dispose();
      await expect(writing).resolves.toBeUndefined();
      expect(child.signalCode).toBe('SIGKILL');
      expect(performance.now() - started).toBeLessThan(disposeEarly ? 1000 : 3000);
    } finally { child?.kill('SIGKILL'); await p.dispose(); }
    mock.restore();
  }
});

test('missing companion never rejects native callbacks or changes their control result', async () => {
  const original = childProcess.execFile.bind(childProcess);
  spyOn(childProcess, 'execFile').mockImplementation((_file: any, _args: any, options: any, callback: any) => original('/lazysh-owned-missing/not-installed', [], options, callback) as any);
  const missing = await plugin();
  await expect(missing.hooks.beforeRun({ snapshot: snapshot() })).resolves.toBeUndefined();
  await missing.dispose();
});

test('held writes serialize native generations and disposal retires queued observations', async () => {
  const callbacks: Array<() => void> = [];
  const payloads: any[] = [];
  spyOn(childProcess, 'execFile').mockImplementation((_file: any, _args: any, _options: any, callback: any) => {
    const child: any = new EventEmitter(); child.stdin = new PassThrough();
    let raw = ''; child.stdin.on('data', (value: Buffer) => { raw += value; });
    child.stdin.on('finish', () => payloads.push(JSON.parse(raw)));
    const finish = () => callback(null, '', ''); callbacks.push(finish);
    child.kill = mock(() => { finish(); return true; }); return child;
  });
  const p = await plugin();
  const first = p.hooks.beforeRun({ snapshot: snapshot() }); await Bun.sleep(0);
  const next = p.hooks.beforeRun({ snapshot: snapshot('run_next') });
  await p.hooks.afterRun({ snapshot: snapshot(), result: { runId: 'run_one', status: 'completed' } });
  expect(payloads.map(p=>p.runId)).toEqual(['run_one']);
  callbacks.shift()!(); await first; await Bun.sleep(0);
  expect(payloads.map(p=>p.runId)).toEqual(['run_one','run_next']);
  const ended = p.hooks.afterRun({ snapshot: snapshot('run_next'), result: { runId: 'run_next', status: 'completed' } });
  await p.dispose(); await Promise.all([next, ended]);
  expect(payloads.map(p=>p.status)).toEqual(['start','start']);
});

test('a second setup context disables reporting instead of rebinding prior callbacks to another workspace', async () => {
  const { payloads } = recorder(); const p = await plugin();
  await p.hooks.beforeRun({ snapshot: snapshot() });
  p.value.setup({}, { cwd: '/other/workspace', onDispose() {} });
  await p.hooks.afterRun({ snapshot: snapshot(), result: { runId: 'run_one', status: 'completed' } });
  await p.hooks.beforeRun({ snapshot: snapshot('run_new_context') });
  expect(payloads).toHaveLength(1);
  expect(payloads[0].directory).toBe('/owned/project');
  await p.dispose();
});

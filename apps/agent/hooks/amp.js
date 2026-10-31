import childProcess from 'node:child_process';
import { once } from 'node:events';

// Observe native per-thread state; never intercept a tool or return a permission decision.
export default function lazysh(amp) {
  const watches = new Map();
  const children = new Map();
  let disposed = false;
  const current = watch => !disposed && watches.get(watch.id) === watch;

  async function write(watch, state) {
    let child;
    try {
      child = childProcess.spawn('lazysh-agent', ['ingest', '--agent', 'amp'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000, killSignal: 'SIGKILL' });
      const exited = once(child, 'close');
      children.set(child, exited);
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ schemaVersion: 1, threadId: watch.id, directory: watch.directory, state }));
      await exited;
    } catch {
      // Missing/unavailable companion must not affect Amp work or its permission flow.
    } finally {
      if (child) children.delete(child);
    }
  }

  async function drain(watch) {
    watch.writing = true;
    while (current(watch) && watch.pending !== undefined) {
      const state = watch.pending;
      watch.pending = undefined;
      await write(watch, state);
    }
    watch.writing = false;
  }

  function observe(_event, ctx) {
    if (disposed || watches.has(ctx.thread.id)) return;
    let directory;
    try {
      directory = amp.system.workspaceRoot ? amp.helpers.filePathFromURI(amp.system.workspaceRoot) : 'Amp (no workspace)';
    } catch { return; }
    const watch = { id: ctx.thread.id, directory, writing: false, pending: undefined, changed: false };
    const receive = state => {
      if (!current(watch) || !['idle', 'running', 'awaiting-approval', 'error'].includes(state)) return;
      watch.pending = state;
      if (!watch.writing) void drain(watch);
    };
    watches.set(watch.id, watch);
    try {
      watch.subscription = ctx.thread.state.subscribe(state => { watch.changed = true; receive(state); });
      void ctx.thread.state.get().then(state => { if (!watch.changed) receive(state); }).catch(() => {});
    } catch {
      watch.subscription?.unsubscribe();
      watches.delete(watch.id);
    }
  }

  const registrations = [amp.on('session.start', observe), amp.on('agent.start', observe)];
  amp.onDispose(async () => {
    disposed = true;
    for (const registration of registrations) registration.unsubscribe();
    for (const watch of watches.values()) watch.subscription?.unsubscribe();
    watches.clear();
    const exits = [...children.values()];
    for (const child of children.keys()) { try { child.kill('SIGKILL'); } catch {} }
    await Promise.allSettled(exits);
  });
}

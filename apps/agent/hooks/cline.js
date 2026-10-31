import childProcess from 'node:child_process';

// Native awaited run hooks only; child working directories are not established.
let owner;
const identity = snapshot => snapshot && (snapshot.parentAgentId == null || snapshot.parentAgentId === '') && ['agentId','conversationId','runId'].every(key => typeof snapshot[key] === 'string' && snapshot[key].length > 0 && snapshot[key].length <= 256);

async function publish(context, run, status) {
  if (context.pending >= 64) return;
  context.pending++;
  const completed = context.tail.then(async () => {
    if (context.disposed || context.runs.get(run.agentId) !== run) return;
    await new Promise(resolve => {
      try {
        context.child = childProcess.execFile('lazysh-agent', ['ingest','--agent','cline'], { timeout: 2000, killSignal: 'SIGKILL', maxBuffer: 1024, windowsHide: true }, () => { context.child = undefined; resolve(); });
        context.child.stdin.on('error', () => {});
        context.child.stdin.end(JSON.stringify({ schemaVersion: 1, agentId: run.agentId, conversationId: run.conversationId, runId: run.runId, parentAgentId: null, directory: context.directory, status }));
      } catch { resolve(); }
    });
  });
  context.tail = completed.catch(() => {});
  try { await completed; } finally { context.pending--; }
}

export default {
  name: 'lazysh-root-lifecycle',
  manifest: { capabilities: ['hooks'] },
  setup(_api, ctx) {
    // Supported workers own one fixed session context; never rebind an old observer.
    if (owner) {
      owner.disposed = true;
      owner.runs.clear();
      try { owner.child?.kill('SIGKILL'); } catch { /* Already reaped. */ }
      return;
    }
    const context = { directory: ctx.cwd, disposed: typeof ctx.cwd !== 'string' || !ctx.cwd || ctx.cwd.length > 4096, runs: new Map(), pending: 0, tail: Promise.resolve(), child: undefined };
    owner = context;
    ctx.onDispose?.(async () => {
      context.disposed = true;
      context.runs.clear();
      try { context.child?.kill('SIGKILL'); } catch { /* Already reaped. */ }
      await context.tail;
    });
  },
  hooks: {
    async beforeRun({ snapshot }) {
      const context = owner;
      if (!context || context.disposed || !identity(snapshot)) return;
      const previous = context.runs.get(snapshot.agentId);
      if (previous?.runId === snapshot.runId || (!previous && context.runs.size >= 64)) return;
      const run = { agentId: snapshot.agentId, conversationId: snapshot.conversationId, runId: snapshot.runId, finished: false };
      context.runs.set(run.agentId, run);
      await publish(context, run, 'start');
    },
    async afterRun({ snapshot, result }) {
      const context = owner;
      if (!context || context.disposed || !identity(snapshot)) return;
      const run = context.runs.get(snapshot.agentId);
      if (!run || run.finished || run.runId !== snapshot.runId || run.conversationId !== snapshot.conversationId || result?.runId !== run.runId || !['completed','aborted','failed'].includes(result.status)) return;
      run.finished = true;
      await publish(context, run, result.status);
    },
  },
};

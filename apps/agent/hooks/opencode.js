// One metadata-only publisher for OpenCode's v1 callbacks and v2 event stream.
const lifecycle = ['session.status', 'permission.asked', 'question.asked', 'session.deleted', 'session.error'];

function publisher(directory) {
  const pending = new Map();
  let disposed = false;
  let draining;
  let child;
  const kill = () => { try { child?.kill('SIGKILL'); } catch { /* Already exited. */ } };
  async function drain() {
    while (!disposed && pending.size) {
      const [id, item] = pending.entries().next().value;
      pending.delete(id);
      let timeout;
      try {
        child = Bun.spawn(['lazysh-agent', 'ingest', '--agent', 'opencode'], {
          stdin: new Blob([JSON.stringify(item.payload)]), stdout: 'ignore', stderr: 'ignore',
        });
        timeout = setTimeout(kill, 3000);
        await child.exited;
      } catch { /* An unavailable companion never interrupts the agent. */ }
      finally { clearTimeout(timeout); child = undefined; item.resolve(); }
    }
  }
  function start() {
    if (!draining) draining = drain().finally(() => {
      draining = undefined;
      if (!disposed && pending.size) start();
    });
  }
  return {
    event({ event }) {
      const sessionID = event.properties?.sessionID;
      if (disposed || !lifecycle.includes(event.type) || typeof sessionID !== 'string') return Promise.resolve();
      const payload = { type: event.type, directory, properties: { sessionID } };
      if (event.type === 'session.status') payload.properties.status = { type: event.properties.status?.type };
      const completed = new Promise(resolve => {
        // Keep only the latest pending state per session and bound distinct sessions.
        pending.get(sessionID)?.resolve();
        if (!pending.has(sessionID) && pending.size >= 64) {
          const [oldest, item] = pending.entries().next().value;
          pending.delete(oldest); item.resolve();
        }
        pending.set(sessionID, { payload, resolve });
      });
      start();
      return completed;
    },
    async dispose() {
      disposed = true;
      for (const item of pending.values()) item.resolve();
      pending.clear(); kill();
      await draining;
    },
  };
}

export const LazyshPlugin = async ({ directory }) => publisher(directory);

export default {
  id: 'lazysh',
  server: LazyshPlugin,
  async setup({ location, event, session }) {
    const output = publisher(location.directory);
    const controller = new AbortController();
    const owned = new Map();
    const touched = new Set();
    let bootstrapping = true;
    let overflow = false;
    const remember = (id, directory) => {
      owned.delete(id);
      if (directory !== location.directory) return;
      if (owned.size >= 256) owned.delete(owned.keys().next().value);
      owned.set(id, directory);
    };
    const types = ['session.created', 'session.moved', 'session.status', 'permission.asked', 'form.created', 'session.deleted', 'session.execution.failed'];
    const running = (async () => {
      try {
        for await (const incoming of event.subscribe({ types, signal: controller.signal })) {
          if (controller.signal.aborted) break;
          const properties = incoming.type === 'form.created' ? incoming.data?.form : incoming.data;
          // Global forms are not agent sessions; never create a synthetic agent row.
          const id = properties?.sessionID;
          if (typeof id !== 'string' || id === 'global') continue;
          if (bootstrapping && !overflow) {
            touched.add(id);
            if (touched.size > 256) { overflow = true; touched.clear(); }
          }
          if (incoming.type === 'session.created' || incoming.type === 'session.moved') {
            remember(id, properties.location?.directory);
            continue;
          }
          const directory = incoming.location?.directory ?? owned.get(id);
          if (incoming.type === 'session.deleted') owned.delete(id);
          else if (incoming.location?.directory !== undefined) remember(id, incoming.location.directory);
          if (directory !== location.directory) continue;
          const type = incoming.type === 'form.created' ? 'question.asked'
            : incoming.type === 'session.execution.failed' ? 'session.error' : incoming.type;
          void output.event({ event: { type, properties } });
        }
      } catch { /* Unload or an unavailable stream must not interrupt OpenCode. */ }
    })();
    // The native SDK does not cancel this call; our wait is bounded and late results ignored.
    let timeout;
    let abort;
    const initial = (async () => {
      try {
        const result = await Promise.race([
          Promise.resolve().then(() => session?.list({ directory: location.directory, limit: 128 })),
          new Promise(resolve => { timeout = setTimeout(resolve, 3000); }),
          new Promise(resolve => { abort = () => resolve(); controller.signal.addEventListener('abort', abort, { once: true }); }),
        ]);
        if (!controller.signal.aborted && !overflow) {
          for (const info of (result?.data ?? []).slice(0, 128)) {
            if (typeof info.id === 'string' && !touched.has(info.id)) remember(info.id, info.location?.directory);
          }
        }
      } catch { /* Inventory is optional; unattributed events remain ignored. */ }
      finally {
        clearTimeout(timeout); controller.signal.removeEventListener('abort', abort);
        bootstrapping = false; touched.clear();
      }
    })();
    return async () => {
      controller.abort();
      await output.dispose();
      await Promise.all([running, initial]);
      owned.clear();
    };
  },
};

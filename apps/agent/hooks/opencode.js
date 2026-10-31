// OpenCode's native plugin events; project only lifecycle metadata to the companion.
export const LazyshPlugin = async ({ directory }) => ({
  event: async ({ event }) => {
    if (!['session.status', 'permission.asked', 'question.asked', 'session.deleted', 'session.error'].includes(event.type)) return;
    const sessionID = event.properties?.sessionID;
    if (typeof sessionID !== 'string') return;
    const payload = { type: event.type, directory, properties: { sessionID } };
    if (event.type === 'session.status') payload.properties.status = { type: event.properties.status?.type };
    let process;
    let timeout;
    try {
      process = Bun.spawn(['lazysh-agent', 'ingest', '--agent', 'opencode'], {
        stdin: new Blob([JSON.stringify(payload)]), stdout: 'ignore', stderr: 'ignore',
      });
      timeout = setTimeout(() => {
        try { process.kill('SIGKILL'); } catch { /* The child may have exited concurrently. */ }
      }, 3000);
      await process.exited;
    } catch {
      // Missing/unavailable companion must not interrupt the agent or answer its prompts.
    } finally {
      clearTimeout(timeout);
    }
  },
});

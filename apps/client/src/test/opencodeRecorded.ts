/** What the host companion printed for one real OpenCode 2.2.7 session (a one-line prompt answered by its free model), recorded in an isolated profile:
 * `lazysh-agent discover --agent opencode` and `lazysh-agent transcript --agent opencode --view conversation`. Only the folder of the database is replaced. */
export const opencodeSession = 'ses_e2c499889ffe7InlpXFj9FB26n';
export const opencodeDatabase = '/home/owner/.local/share/opencode/opencode.db';
export const opencodeDiscovery = {agent: 'opencode', schemaVersion: 1, truncated: false, sessions: [
  {bytes: 11894784, modifiedAt: '2026-11-13T07:01:51.782+00:00', name: 'Single-word reply request', path: opencodeDatabase, sessionId: opencodeSession}]};
export const opencodePage = {agent: 'opencode', branchId: opencodeSession, hasMore: false, nextOffset: 0, schemaVersion: 1, truncated: false, view: 'active_branch', messages: [
  {blocks: [{text: 'reply with the single word ok', type: 'text'}], id: 'msg_1d3b6677a001nu09C7pO1kHFCV', role: 'user', timestamp: '2026-11-13T07:01:49.130+00:00'},
  {blocks: [{text: 'ok', type: 'text'}], id: 'msg_1d3b667e0001jg1ed2Ox7BxR8q', role: 'assistant', timestamp: '2026-11-13T07:01:49.158+00:00',
    usage: {cacheReadTokens: 1792, cacheWriteTokens: 0, inputTokens: 3568, outputTokens: 3}}]};

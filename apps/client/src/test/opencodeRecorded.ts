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
/** A second real OpenCode 2.2.7 session in which its free model ran one shell command (`cat notes.txt`), read the same way. */
export const opencodeToolSession = 'ses_e2b12bce3ffegHavmv3jQvfgV3';
export const opencodeToolPage = {agent: 'opencode', branchId: opencodeToolSession, hasMore: false, nextOffset: 0, schemaVersion: 1, truncated: false, view: 'active_branch',
  session: {cost: {usd: 0}, folder: 'work', mode: 'build', model: 'big-pickle', usage: {usedTokens: 14912}}, messages: [
  {blocks: [{text: 'Use the bash tool to run: cat notes.txt  Then reply with the file content only.', type: 'text'}], id: 'msg_1d4ed435b001d0aj7WrXVgV65i', role: 'user', timestamp: '2026-11-13T12:41:21.576+00:00'},
  {blocks: [
    {id: 'call_48a3aa1a0096451c826f53ca', name: 'shell', status: 'completed', text: '{"command":"cat notes.txt"}', type: 'tool_use'},
    {id: 'call_48a3aa1a0096451c826f53ca', name: 'shell', status: 'completed', text: 'hello\n', type: 'tool_result'}],
  id: 'msg_1d4ed43bf001yPzxtAGjqtxGcm', role: 'assistant', timestamp: '2026-11-13T12:41:21.605+00:00', usage: {cacheReadTokens: 1664, cacheWriteTokens: 0, inputTokens: 13192, outputTokens: 40}},
  {blocks: [{text: 'hello', type: 'text'}], id: 'msg_1d4ed6ba5001cUgUU8ey9jdMfW', role: 'assistant', timestamp: '2026-11-13T12:41:31.817+00:00', usage: {cacheReadTokens: 14848, cacheWriteTokens: 0, inputTokens: 61, outputTokens: 3}}]};

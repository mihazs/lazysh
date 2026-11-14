/** What a recorded tool call is, for the Agent view's cards: its kind, a one-line summary, whether it ran, failed or was
 * refused, and the result's output. Pure. One name table (Claude Code, Codex, OpenCode and Gemini CLI names) covers every agent whose conversation the companion projects as
 * `tool_use` and `tool_result` blocks; a tool this table does not know stays `other` and keeps its name and raw input. */
export type ToolKind = 'execute' | 'read' | 'search' | 'fetch' | 'edit' | 'other';
export type ToolStatus = 'running' | 'ok' | 'error' | 'denied';
export type ToolUse = {name?: string; text?: string; status?: 'pending' | 'in_progress' | 'completed' | 'failed'};
export type ToolResult = {text?: string; isError?: boolean};
export type ToolCall = {kind: ToolKind; name: string; summary: string; status: ToolStatus; input: Record<string, unknown>; exitCode?: number; output?: string};

const kinds: Record<string, ToolKind> = {
  bash: 'execute', command: 'execute', shell: 'execute', exec_command: 'execute', local_shell: 'execute', run_terminal_cmd: 'execute', run_shell_command: 'execute',
  read: 'read', read_file: 'read', view: 'read', notebookread: 'read', read_many_files: 'read',
  grep: 'search', glob: 'search', ls: 'search', search: 'search', find: 'search', grep_search: 'search', list_directory: 'search',
  webfetch: 'fetch', websearch: 'fetch', web_fetch: 'fetch', google_web_search: 'fetch',
  edit: 'edit', multiedit: 'edit', write: 'edit', notebookedit: 'edit', apply_patch: 'edit', str_replace_based_edit_tool: 'edit', replace: 'edit', write_file: 'edit',
};
export const toolKind = (name = ''): ToolKind => kinds[name.toLowerCase()] ?? 'other';

/** The tool's input: the recorded JSON object, or for a tool whose input is plain text (a Codex command) that text as `command`. */
export function toolInput(use: ToolUse): Record<string, unknown> {
  const raw = use.text ?? '';
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    return {command: String(value)};
  } catch {return {command: raw};}
}

const pick = (input: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) if (typeof input[key] === 'string' && (input[key] as string).trim()) return (input[key] as string).trim();
  return undefined;
};
const firstLine = (text: string) => text.split('\n').find(line => line.trim())?.trim() ?? '';

function summarize(kind: ToolKind, name: string, input: Record<string, unknown>): string {
  switch (kind) {
    case 'execute': return firstLine(pick(input, 'command', 'cmd') ?? '');
    case 'read': {
      const path = pick(input, 'file_path', 'path', 'filePath') ?? '';
      const from = Number(input.offset), count = Number(input.limit);
      // Claude's Read counts lines from `offset` for `limit` lines; an unset offset starts at line 1.
      return count > 0 ? `${path}:${(from > 0 ? from : 1)}-${(from > 0 ? from : 1) + count - 1}` : from > 0 ? `${path}:${from}` : path;
    }
    case 'search': {
      const where = pick(input, 'path');
      return [pick(input, 'pattern', 'query'), where && `in ${where}`].filter(Boolean).join(' ');
    }
    case 'fetch': return pick(input, 'url', 'query') ?? '';
    case 'edit': return pick(input, 'file_path', 'filePath', 'path', 'notebook_path') ?? '';
    default: {
      const first = Object.values(input).find(value => typeof value === 'string' && value.trim()) as string | undefined;
      return first ? firstLine(first).slice(0, 120) : '';
    }
  }
}

// Claude Code writes these when the person declines a tool call or a permission rule refuses it; neither is a failure of the tool.
const refusal = /^(The user doesn't want to proceed with this tool use|Permission to use .{1,80} has been denied|The user rejected|User rejected|Tool use was rejected)/i;
const exit = /^Exit code (-?\d+)\b/;

/** `use` alone is a call that has not returned; with its `result` it is done. A call can also carry its own status (Codex, OpenCode). */
export function describeTool(use: ToolUse, result?: ToolResult): ToolCall {
  const name = use.name ?? '', kind = toolKind(name), input = toolInput(use);
  const text = result?.text ?? '';
  let status: ToolStatus = result ? (result.isError ? 'error' : 'ok') : use.status === 'completed' ? 'ok' : use.status === 'failed' ? 'error' : 'running';
  if (status === 'error' && refusal.test(text.trim())) status = 'denied';
  const code = status === 'error' ? exit.exec(text)?.[1] : undefined;
  return {kind, name, summary: summarize(kind, name, input), status, input, exitCode: code === undefined ? undefined : Number(code),
    output: result ? (code === undefined ? text : text.replace(exit, '').replace(/^\n/, '')) : undefined};
}

/** The last `count` lines of `text` and how many lines came before them. */
export function tail(text: string, count: number): {lines: string; hidden: number} {
  const lines = text.replace(/\n$/, '').split('\n');
  return {lines: lines.slice(-count).join('\n'), hidden: Math.max(0, lines.length - count)};
}

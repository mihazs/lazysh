/** What the Claude Code status area shows under the prompt: background shells, monitors, sub-agents and workflows, derived from
 * the conversation page (tool calls, their results and the harness's task notifications). Pure; nothing here reads the terminal. */
import type {WorkItem} from './agentWork';
export type StatusKind = 'shell' | 'monitor' | 'agent' | 'workflow';
export type StatusState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
export type StatusItem = {id: string; kind: StatusKind; label: string; type?: string; state: StatusState; startedAt?: number; endedAt?: number; tokens?: number; background: boolean; taskId?: string; detail?: string;
  /** From the companion only: the command, the lines a monitor reported and the last line of output. */
  command?: string; events?: readonly string[]; last?: string;
  /** The sub-agent's own conversation file on the host, when the session directory holds one. */
  childPath?: string};
type Shape = {role: string; timestamp?: string; blocks: {type: string; text?: string; id?: string; name?: string; isError?: boolean}[]};

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();
const stamp = (value?: string) => {const time = Date.parse(value ?? ''); return Number.isFinite(time) ? time : undefined;};
const json = (text?: string): Record<string, unknown> => {try {const value = JSON.parse(text ?? ''); return value && typeof value === 'object' ? value : {};} catch {return {};}};
const text = (value: unknown, limit = 120) => typeof value === 'string' && value.trim() ? value.trim().split('\n')[0].slice(0, limit) : undefined;
const finals: Record<string, StatusState> = {completed: 'done', complete: 'done', done: 'done', failed: 'failed', error: 'failed', killed: 'stopped', stopped: 'stopped', cancelled: 'stopped'};

function started(name: string, input: Record<string, unknown>): Pick<StatusItem, 'kind' | 'label' | 'type' | 'background'> | undefined {
  switch (name.toLowerCase()) {
    case 'agent': case 'task': return {kind: 'agent', label: text(input.description) ?? text(input.prompt) ?? '', type: text(input.subagent_type, 40), background: input.run_in_background === true};
    case 'monitor': return {kind: 'monitor', label: text(input.description) ?? text(input.command) ?? '', background: true};
    case 'bash': return input.run_in_background === true ? {kind: 'shell', label: text(input.description) ?? text(input.command) ?? '', background: true} : undefined;
    // shortcut: a workflow has no progress records in the transcript, so it shows as one running row; per-step progress waits for a companion record.
    case 'workflow': return {kind: 'workflow', label: /name:\s*['"]([^'"]{1,80})['"]/.exec(String(input.script ?? ''))?.[1] ?? '', background: true};
  }
}

export function deriveStatus(messages: readonly Shape[]): StatusItem[] {
  const items = new Map<string, StatusItem>();
  const finish = (item: StatusItem | undefined, state: StatusState, at?: number, tokens?: number) => {
    if (!item || item.state !== 'running') return;
    item.state = state; item.endedAt = at; if (tokens !== undefined) item.tokens = tokens;
  };
  const byTask = (taskId?: string) => taskId ? [...items.values()].find(item => item.taskId === taskId) : undefined;
  for (const message of messages) {
    const at = stamp(message.timestamp);
    for (const block of message.blocks) {
      if (block.type === 'tool_use' && block.id) {
        const input = json(block.text), kind = started(block.name ?? '', input);
        if (kind) items.set(block.id, {id: block.id, state: 'running', startedAt: at, ...kind});
        else if (block.name === 'TaskStop') finish(byTask(text(input.task_id)), 'stopped', at);
      } else if (block.type === 'tool_result' && block.id) {
        const item = items.get(block.id);
        if (!item) continue;
        item.taskId ??= /(?:ID:|task)\s+([a-z0-9]+)/i.exec(block.text ?? '')?.[1];
        // A foreground agent is done with its result; a background one only launched.
        if (!item.background || block.isError) finish(item, block.isError ? 'failed' : 'done', at);
      } else if (block.type === 'text' && block.text?.includes('<task-notification>')) {
        const note = block.text, id = tag(note, 'tool-use-id'), taskId = tag(note, 'task-id');
        const tokens = Number(tag(note, 'subagent_tokens')), duration = Number(tag(note, 'duration_ms'));
        const item = (id && items.get(id)) || byTask(taskId);
        if (item) item.detail = tag(note, 'summary');
        finish(item, finals[(tag(note, 'status') ?? '').toLowerCase()] ?? 'done', item?.startedAt !== undefined && duration > 0 ? item.startedAt + duration : at, tokens > 0 ? tokens : undefined);
      }
    }
  }
  return [...items.values()];
}

/** A launch with no recorded end this old is shown as unknown rather than running (a monitor: its own timeout plus a minute). */
const staleAfter = 12 * 3600_000;
/** The companion's `work` list read from the whole conversation: the same rows as `deriveStatus`, which only sees the loaded window. */
export function fromWork(work: readonly WorkItem[], now = Date.now()): StatusItem[] {
  return work.map(item => {
    const startedAt = Date.parse(item.startedAt ?? '') || undefined, ended = Date.parse(item.endedAt ?? '') || undefined;
    const stale = item.state === 'running' && startedAt !== undefined && now - startedAt > (item.timeoutMs === undefined ? staleAfter : item.timeoutMs + 60_000);
    return {id: item.id, kind: item.kind, label: item.title, type: item.subtitle, state: stale ? 'unknown' : item.state, startedAt,
      endedAt: item.durationMs !== undefined && startedAt !== undefined ? startedAt + item.durationMs : ended, tokens: item.tokens,
      background: true, taskId: item.taskId, detail: item.summary, command: item.command, events: item.events, last: item.last, childPath: item.childPath};
  });
}

/** What is still open of a kind: running, or with no end recorded. */
export const runningOf = (items: readonly StatusItem[], kind: StatusKind) => items.filter(item => item.kind === kind && (item.state === 'running' || item.state === 'unknown')).length;

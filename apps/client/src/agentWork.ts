/** Sub-agents, background commands and monitors as the host companion read them from the conversation's records
 * (`work` on a transcript page). The record is the only evidence: a launch with no recorded end stays `running`
 * for as long as it could plausibly run, then shows as `unknown`, never as done. */
import {LocalUiError} from './i18n/localError';

export type WorkState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
export type WorkKind = 'agent' | 'shell' | 'monitor';
export type WorkItem = {
  id: string; kind: WorkKind; title: string; state: WorkState; events: string[];
  subtitle?: string; command?: string; taskId?: string; startedAt?: string; endedAt?: string; last?: string; summary?: string; timeoutMs?: number;
};

const states: readonly string[] = ['running', 'done', 'failed', 'stopped', 'unknown'];
const kinds: readonly string[] = ['agent', 'shell', 'monitor'];
const optional = ['subtitle', 'command', 'taskId', 'startedAt', 'endedAt', 'last', 'summary'] as const;
const invalid = () => new LocalUiError('chatInvalidWork');

export function parseWork(value: unknown): WorkItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  return value.map(row => {
    const item = row as Partial<WorkItem> | null;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.title !== 'string'
      || !kinds.includes(item.kind as string) || !states.includes(item.state as string)
      || !Array.isArray(item.events) || item.events.length > 50 || item.events.some(event => typeof event !== 'string')
      || optional.some(key => item[key] !== undefined && typeof item[key] !== 'string')
      || (item.timeoutMs !== undefined && !Number.isSafeInteger(item.timeoutMs))) throw invalid();
    return item as WorkItem;
  });
}

/** A launch with no recorded end this old is shown as unknown (a monitor: its own timeout plus a minute). */
const staleAfter = 12 * 3600_000;
export function settleWork(items: readonly WorkItem[], now = Date.now()): WorkItem[] {
  return items.map(item => {
    const started = Date.parse(item.startedAt ?? '');
    const limit = item.timeoutMs === undefined ? staleAfter : item.timeoutMs + 60_000;
    return item.state === 'running' && started && now - started > limit ? {...item, state: 'unknown'} : item;
  });
}

/** Sub-agents, background commands, monitors and workflows as the host companion read them from the conversation's
 * records (`work` on a transcript page). The record is the only evidence of an end; see `fromWork` for old launches. */
import {LocalUiError} from './i18n/localError';

export type WorkState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
export type WorkKind = 'agent' | 'shell' | 'monitor' | 'workflow';
export type WorkItem = {
  id: string; kind: WorkKind; title: string; state: WorkState; events: string[];
  subtitle?: string; command?: string; taskId?: string; childPath?: string; startedAt?: string; endedAt?: string; last?: string; summary?: string;
  timeoutMs?: number; tokens?: number; durationMs?: number;
};

const states: readonly string[] = ['running', 'done', 'failed', 'stopped', 'unknown'];
const kinds: readonly string[] = ['agent', 'shell', 'monitor', 'workflow'];
const optional = ['subtitle', 'command', 'taskId', 'childPath', 'startedAt', 'endedAt', 'last', 'summary'] as const;
const counts = ['timeoutMs', 'tokens', 'durationMs'] as const;

export function parseWork(value: unknown): WorkItem[] | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new LocalUiError('chatInvalidWork');
  if (!Array.isArray(value) || value.length > 100) throw invalid();
  return value.map(row => {
    const item = row as Partial<WorkItem> | null;
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.title !== 'string'
      || !kinds.includes(item.kind as string) || !states.includes(item.state as string)
      || !Array.isArray(item.events) || item.events.length > 50 || item.events.some(event => typeof event !== 'string')
      || optional.some(key => item[key] !== undefined && typeof item[key] !== 'string')
      || counts.some(key => item[key] !== undefined && !(Number.isSafeInteger(item[key]) && item[key]! >= 0))) throw invalid();
    return item as WorkItem;
  });
}

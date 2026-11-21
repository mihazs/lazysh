/** Sub-agents, background commands, monitors and workflows as the host companion read them from the conversation's
 * records (`work` on a transcript page). The record is the only evidence of an end; see `fromWork` for old launches. */
import {LocalUiError} from './i18n/localError';

export type WorkState = 'running' | 'done' | 'failed' | 'stopped' | 'unknown';
export type WorkKind = 'agent' | 'shell' | 'monitor' | 'workflow';
export type WorkflowAgent = {agentId: string; label: string; state: WorkState; phase?: string; tokens?: number; toolCalls?: number; durationMs?: number; last?: string; childPath?: string};
export type WorkflowTree = {name?: string; phases: {title: string; state: WorkState | 'pending'}[]; agents: WorkflowAgent[]; totals: {agents: number; tokens: number; toolCalls: number}};
export type WorkItem = {
  id: string; kind: WorkKind; title: string; state: WorkState; events: string[];
  subtitle?: string; command?: string; taskId?: string; runId?: string; workflow?: WorkflowTree; childPath?: string; startedAt?: string; endedAt?: string; last?: string; summary?: string;
  timeoutMs?: number; tokens?: number; durationMs?: number;
};

const states: readonly string[] = ['running', 'done', 'failed', 'stopped', 'unknown'];
const kinds: readonly string[] = ['agent', 'shell', 'monitor', 'workflow'];
const optional = ['subtitle', 'command', 'taskId', 'runId', 'childPath', 'startedAt', 'endedAt', 'last', 'summary'] as const;
const counts = ['timeoutMs', 'tokens', 'durationMs'] as const;

const isCount = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown) => typeof value === 'string' && value.length <= 4096;
function checkTree(value: unknown): WorkflowTree {
  const tree = value as Partial<WorkflowTree> | null;
  if (!tree || typeof tree !== 'object' || !Array.isArray(tree.phases) || tree.phases.length > 50 || !Array.isArray(tree.agents) || tree.agents.length > 200
    || !tree.totals || !isCount(tree.totals.agents) || !isCount(tree.totals.tokens) || !isCount(tree.totals.toolCalls)
    // A companion before this fix sends `name: null` for a run whose summary file is missing: no name, not an invalid page.
    || (tree.name != null && !text(tree.name))
    || tree.phases.some(phase => !phase || !text(phase.title) || ![...states, 'pending'].includes(phase.state))
    || tree.agents.some(agent => !agent || !text(agent.agentId) || !text(agent.label) || !states.includes(agent.state)
      || (['phase', 'last', 'childPath'] as const).some(key => agent[key] !== undefined && !text(agent[key]))
      || (['tokens', 'toolCalls', 'durationMs'] as const).some(key => agent[key] !== undefined && !isCount(agent[key])))) throw new LocalUiError('chatInvalidWork');
  return tree as WorkflowTree;
}

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
      || counts.some(key => item[key] !== undefined && !isCount(item[key]))) throw invalid();
    if (item.workflow !== undefined) checkTree(item.workflow);
    return item as WorkItem;
  });
}

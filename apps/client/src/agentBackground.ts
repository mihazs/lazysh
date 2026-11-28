/** What a session still runs after its turn ended, as the companion's snapshot reports it (`background` on a row): background
 * sub-agents, dynamic workflows, and shell commands and monitors together (a lower bound). The row then reads working. */
import {t} from './i18n/core';

export type Background = {agents?: number; workflows?: number; shells?: number};
const kinds = [['agents', 'agentBackgroundAgents'], ['workflows', 'agentBackgroundWorkflows'], ['shells', 'agentBackgroundShells']] as const;

export const validBackground = (value: unknown): value is Background => !!value && typeof value === 'object' && !Array.isArray(value)
  && kinds.every(([key]) => {const count = (value as Record<string, unknown>)[key]; return count === undefined || (Number.isSafeInteger(count) && (count as number) > 0);});

export const hasBackground = (row?: {background?: Background}) => !!row?.background && kinds.some(([key]) => (row.background![key] ?? 0) > 0);
/** "2 sub-agents · 1 shell or monitor": only the kinds that run. */
export const backgroundLine = (background?: Background) => kinds.filter(([key]) => (background?.[key] ?? 0) > 0).map(([key, name]) => t(name, {count: background?.[key] ?? 0})).join(' · ');

/** The open background work of a reported session that outranks the pane status Herdr gives it: an idle, done or unknown pane
 * (or none) is wrong while the report says something still runs; a working or blocked pane already says more. */
export const outranksPane = (row?: {state: string; background?: Background}, pane?: string) =>
  hasBackground(row) && row?.state === 'working' && (!pane || pane === 'idle' || pane === 'done' || pane === 'unknown') ? row.background : undefined;

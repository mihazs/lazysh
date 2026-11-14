import type {AgentSession} from './AgentPanel';
import {formatRelativeTime} from './relativeTime';
import {t, type UiKey} from './i18n/core';

/** What a reported agent waits for; `unknown` is a hook that says it needs the user but not why. */
export type WaitingKind = NonNullable<AgentSession['waiting']>;
export const waitingKeys = {approval: 'agentWaitingApproval', question: 'agentWaitingQuestion', plan: 'agentWaitingPlan', menu: 'agentWaitingMenu', unknown: 'agentWaitingUnknown'} as const satisfies Record<WaitingKind, UiKey>;
type Waiter = Pick<AgentSession, 'agent' | 'state' | 'summary' | 'updatedAt' | 'waiting' | 'waitingSince'>;
// Only these agents' permission hooks put the tool's name in the summary.
const permissionHooks = new Set(['Claude Code', 'Codex']);
const questionTools = new Set(['AskUserQuestion', 'request_user_input']);
// A failure raises the same report state, but nothing waits for an answer.
const failures = new Set(['Turn failed', 'Session error']);

/** The blocker of a needs-attention report: the companion's record, else (an older companion) read from the summary.
 * A permission hook reports the tool's name as the summary, so the question and plan tools are told apart from an approval. */
export function waitingKind(row: Waiter): WaitingKind | undefined {
  if (row.state !== 'needs_attention' || failures.has(row.summary)) return undefined;
  if (row.waiting) return row.waiting;
  if (questionTools.has(row.summary) || row.summary === 'Answer requested') return 'question';
  if (row.summary === 'ExitPlanMode') return 'plan';
  return row.summary === 'Permission requested' || (permissionHooks.has(row.agent) && row.summary !== 'Agent needs attention') ? 'approval' : 'unknown';
}

const waitStart = (row: Waiter) => Date.parse(row.waitingSince ?? row.updatedAt);

/** Waiting sessions first, the longest-waiting first; the rest keep their order. */
export function waitingFirst<T extends Waiter>(rows: readonly T[]): T[] {
  return [...rows.filter(waitingKind).sort((a, b) => waitStart(a) - waitStart(b)), ...rows.filter(row => !waitingKind(row))];
}

/** "Waiting for your approval · 5 min. ago", or nothing when the report does not wait for the user. */
export function WaitingLabel({row, now}: {row: Waiter; now?: number}) {
  const kind = waitingKind(row);
  if (!kind) return null;
  const since = row.waitingSince ?? row.updatedAt;
  return <span className="agent-waiting" data-waiting={kind}>{t(waitingKeys[kind])} · <time dateTime={since}>{formatRelativeTime(since, now)}</time></span>;
}

import {FolderGit2, GitBranch} from 'lucide-react';
import {formatDate, formatNumber, t} from './i18n/core';
import {contextLeft, type AgentSessionInfo} from './agentSession';
import './AgentHeaderPills.css';

const modeNames = {
  default: 'agentModeDefault', plan: 'agentModePlan', acceptEdits: 'agentModeAcceptEdits', auto: 'agentModeAuto', bypassPermissions: 'agentModeBypass',
} as const;
/** The modes an agent starts in; not worth a pill. */
const defaultModes = ['default', 'build'];
export const modeName = (mode: string) => Object.hasOwn(modeNames, mode) ? t(modeNames[mode as keyof typeof modeNames]) : mode;
const compact = (tokens: number) => formatNumber(tokens, {notation: 'compact'});

/** Model, mode, context and git branch in the header row. Unknown pills are not drawn; the default mode is not worth a pill (OpenCode's `build` agent is its default). */
export function AgentHeaderPills({session}: {session?: AgentSessionInfo}) {
  if (!session) return null;
  const left = contextLeft(session);
  return <span className="agent-pills">
    {session.branch && <span className="agent-pill agent-pill-branch" title={t('agentSessionBranch')}><GitBranch size={11} aria-hidden="true"/> {session.branch}</span>}
    {session.worktree && <span className="agent-pill agent-pill-branch" title={t('agentSessionWorktree')}><FolderGit2 size={11} aria-hidden="true"/> {session.worktree}</span>}
    {session.model && <span className="agent-pill agent-pill-model" title={t('agentSessionModel')}>{session.model}</span>}
    {session.mode && !defaultModes.includes(session.mode) && <span className="agent-pill" data-mode={session.mode} title={t('agentSessionMode')}>{modeName(session.mode)}</span>}
    {session.usage && <span className="agent-pill" data-low={left === undefined ? undefined : left < 10 ? 'danger' : left < 20 ? 'warn' : undefined} title={t('agentSessionContext')}>
      {left === undefined ? t('agentContextUsed', {tokens: compact(session.usage.usedTokens)}) : t('agentContextLeft', {percent: left})}</span>}
  </span>;
}

/** The rest of the session facts, for the options sheet. */
export function AgentSessionDetails({session}: {session?: AgentSessionInfo}) {
  if (!session) return null;
  const left = contextLeft(session);
  const rows: [string, string | undefined][] = [
    [t('agentSessionFolder'), session.folder],
    [t('agentSessionBranch'), session.branch],
    [t('agentSessionWorktree'), session.worktree],
    [t('agentSessionModel'), [session.model, session.effort].filter(Boolean).join(' · ') || undefined],
    [t('agentSessionMode'), session.mode && modeName(session.mode)],
    [t('agentSessionApproval'), [session.approval, session.sandbox].filter(Boolean).join(' · ') || undefined],
    [t('agentSessionContext'), session.usage && (session.usage.limitTokens
      ? t('agentContextDetail', {used: formatNumber(session.usage.usedTokens), limit: formatNumber(session.usage.limitTokens), percent: left ?? 0})
      : t('agentContextUsed', {tokens: formatNumber(session.usage.usedTokens)}))],
    [t('agentSessionCost'), session.cost && formatNumber(session.cost.usd, {style: 'currency', currency: 'USD'})],
    ...(session.rateLimits ?? []).map((limit): [string, string] => [
      limit.windowMinutes ? t('agentSessionLimitWindow', {window: formatNumber(limit.windowMinutes / 60, {style: 'unit', unit: 'hour', unitDisplay: 'narrow', maximumFractionDigits: 1})}) : t('agentSessionLimit'),
      t('agentSessionLimitUsed', {percent: Math.round(limit.usedPercent)}) + (limit.resetsAt ? ` · ${t('agentSessionResets', {time: formatDate(limit.resetsAt * 1000, {dateStyle: 'short', timeStyle: 'short'})})}` : ''),
    ]),
  ];
  return <dl className="agent-session-details">{rows.filter((row): row is [string, string] => !!row[1]).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>;
}

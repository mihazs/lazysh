import {useRef} from 'react';
import {formatNumber, t} from './i18n/core';
import {formatCountdown, useNow} from './relativeTime';
import './AgentWorkingRow.css';

type Part = {blocks: {type: string; id?: string; name?: string}[]; usage?: Record<string, number | string>};
export type WorkState = 'working' | 'waiting' | 'idle' | 'stopped';
/** What the live sources (Herdr status, hook report) say; `label` names what a waiting agent waits for when that is known. */
export type LiveState = {state?: WorkState; label?: string};

/** What the running turn has done so far: output tokens and the tool still running, from its recorded messages. */
export function turnProgress(parts: Part[]): {tokens?: number; tool?: string} {
  // A streamed response is recorded as several records that repeat one usage report; count it once.
  let tokens: number | undefined, previous = '';
  for (const part of parts) {
    const output = part.usage?.outputTokens;
    if (typeof output !== 'number') continue;
    const key = JSON.stringify(part.usage);
    if (key !== previous) tokens = (tokens ?? 0) + output;
    previous = key;
  }
  const blocks = parts.flatMap(part => part.blocks);
  const done = new Set(blocks.filter(block => block.type === 'tool_result').map(block => block.id));
  const tool = blocks.filter(block => block.type === 'tool_use' && block.name && !done.has(block.id)).at(-1)?.name;
  return {tokens, tool};
}

/** One line above the composer while a turn runs. The ticking clock lives here so the message list never re-renders. */
export default function AgentWorkingRow({state, label, since, tokens, tool}: {state?: WorkState; label?: string; since?: string; tokens?: number; tool?: string}) {
  const active = state === 'working' || state === 'waiting';
  const now = useNow(1000, active);
  // Without a recorded start (the agent reports work the transcript has not caught up with) the clock starts when this row saw it begin.
  const seen = useRef<number | undefined>(undefined);
  seen.current = active ? seen.current ?? Date.now() : undefined;
  if (!active) return null;
  const recorded = Date.parse(since ?? ''), start = Number.isFinite(recorded) ? recorded : seen.current!;
  const parts = [
    state === 'working' ? t('agentWorking') : label ?? t('agentWaitingForYou'),
    formatCountdown(Math.max(0, now - start)),
    tokens ? t('agentTurnTokens', {tokens: formatNumber(tokens, {notation: 'compact'})}) : undefined,
    state === 'working' ? tool : undefined,
  ].filter(Boolean);
  return <p className="agent-working-row" role="status" data-state={state}><span className="agent-working-dot" aria-hidden="true"/><span>{parts.join(' · ')}</span></p>;
}

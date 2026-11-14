import {useId, useState, type CSSProperties} from 'react';
import {ListChecks} from 'lucide-react';
import {ChatCard, type Card} from './ChatInteraction';
import {t} from './i18n/core';
import './AgentTasks.css';

type Plan = Extract<Card, {kind: 'plan'}>;
type Shape = {blocks: {card?: Card}[]};

/** The newest plan or todo list of the conversation; each update replaces the one before it. */
export function latestPlan(messages: readonly Shape[]): Plan | undefined {
  for (const message of [...messages].reverse())
    for (const block of [...message.blocks].reverse()) if (block.card?.kind === 'plan') return block.card;
}

/** "4 of 6 · Writing tests": done count and the step the agent is on (first in progress, else first pending). */
export function planProgress(plan: Plan) {
  const done = plan.entries.filter(entry => entry.status === 'completed').length;
  const current = plan.entries.find(entry => entry.status === 'in_progress') ?? plan.entries.find(entry => entry.status === 'pending');
  return {done, total: plan.entries.length, current: current?.text};
}

/** One chip above the composer that expands to the full list; nothing when no plan was recorded. */
export default function AgentPlanChip({messages}: {messages: readonly Shape[]}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const plan = latestPlan(messages);
  if (!plan) return null;
  const {done, total, current} = planProgress(plan);
  return <div className="agent-plan-chip">
    <button type="button" aria-expanded={open} aria-controls={id} style={{'--plan-done': `${Math.round(done / total * 100)}%`} as CSSProperties} onClick={() => setOpen(value => !value)}>
      <ListChecks size={16} aria-hidden="true" />
      <span>{t('agentPlanProgress', {done, total})}</span>
      {current && <span className="agent-plan-current">{current}</span>}
    </button>
    <div id={id} hidden={!open}>{open && <ChatCard card={plan} />}</div>
  </div>;
}

import {formatNumber, t} from './i18n/core';
import {formatCountdown} from './relativeTime';
import type {StatusItem} from './agentBackgroundWork';
import type {WorkflowAgent} from './agentWork';

const stateText = {running: 'agentStatusRunning', done: 'agentStatusDone', failed: 'agentStatusFailed', stopped: 'agentStatusStopped', unknown: 'agentStatusUnknown', pending: 'agentWorkflowPending'} as const;

function AgentRow({agent, onOpen, title}: {agent: WorkflowAgent; onOpen?: (item: StatusItem) => void; title: string}) {
  const facts = [agent.toolCalls !== undefined && t('agentWorkflowToolCalls', {value: agent.toolCalls}), agent.tokens !== undefined && t('agentWorkflowTokens', {value: formatNumber(agent.tokens)}),
    agent.durationMs !== undefined && formatCountdown(agent.durationMs)].filter(Boolean).join(' · ');
  const label = agent.label || agent.agentId;
  return <li>
    <div className="agent-status-head">
      <span className="agent-status-state" data-state={agent.state}>{t(stateText[agent.state])}</span>
      <strong>{label}</strong>
      {facts && <small>{facts}</small>}
      {agent.last && <span className="agent-status-last">{agent.last}</span>}
    </div>
    {agent.childPath && onOpen && <button type="button" className="subtle-button agent-status-open" onClick={() => onOpen({id: agent.agentId, kind: 'agent', label: `${title} · ${label}`, state: agent.state, background: true, childPath: agent.childPath})}>{t('agentStatusOpen')}</button>}
  </li>;
}

/** A dynamic workflow as the agent's own screen draws it: phases as a stepper, each agent under its phase, and the totals. */
export default function AgentWorkflow({item, onOpen}: {item: StatusItem; onOpen?: (item: StatusItem) => void}) {
  const tree = item.workflow;
  if (!tree) return null;
  const title = tree.name ?? item.label;
  const phases = tree.phases.map(phase => ({...phase, agents: tree.agents.filter(agent => agent.phase === phase.title)}));
  const loose = tree.agents.filter(agent => !tree.phases.some(phase => phase.title === agent.phase));
  return <section className="agent-workflow" aria-label={t('agentWorkflowTitle', {name: title})}>
    <h5>{title} <span className="agent-status-state" data-state={item.state}>{t(stateText[item.state])}</span></h5>
    <p className="agent-workflow-totals">{t('agentWorkflowTotals', {agents: tree.totals.agents, tools: tree.totals.toolCalls, tokens: formatNumber(tree.totals.tokens)})}</p>
    <ol className="agent-workflow-phases">
      {phases.map(phase => <li key={phase.title} data-state={phase.state}>
        <div className="agent-status-head"><span className="agent-status-state" data-state={phase.state}>{t(stateText[phase.state])}</span><strong>{phase.title}</strong></div>
        {phase.agents.length > 0 && <ul>{phase.agents.map(agent => <AgentRow key={agent.agentId} agent={agent} onOpen={onOpen} title={title} />)}</ul>}
      </li>)}
    </ol>
    {loose.length > 0 && <ul>{loose.map(agent => <AgentRow key={agent.agentId} agent={agent} onOpen={onOpen} title={title} />)}</ul>}
  </section>;
}

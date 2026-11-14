// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import AgentWorkflow from './AgentWorkflow';
import {fromWork} from './agentBackgroundWork';
import {parseWork,type WorkItem} from './agentWork';

afterEach(cleanup);
const item = (state: WorkItem['state'], agents: NonNullable<WorkItem['workflow']>['agents'], phases: NonNullable<WorkItem['workflow']>['phases']): WorkItem => ({
  id: 'w1', kind: 'workflow', title: 'Review then fix', state, events: [],
  workflow: {name: 'review-fix', phases, agents, totals: {agents: agents.length, tokens: 12_345, toolCalls: 9}},
});
const raw = item('running', [
  {agentId: 'a1', label: 'review:#1', phase: 'Review', state: 'done', tokens: 500, toolCalls: 7, durationMs: 83_000, last: 'No findings', childPath: '/s/a1.jsonl'},
  {agentId: 'a2', label: 'review:#2', phase: 'Review', state: 'failed'},
  {agentId: 'a3', label: 'fix:#1', phase: 'Fix', state: 'running', last: 'cargo test'},
], [{title: 'Review', state: 'failed'}, {title: 'Fix', state: 'running'}, {title: 'Report', state: 'pending'}]);

const running = fromWork([raw])[0];

it('draws the phases as a stepper with each agent under its phase and the totals', () => {
  const open = vi.fn();
  render(<AgentWorkflow item={running} onOpen={open} />);
  const tree = screen.getByRole('region', {name: 'Workflow review-fix'});
  expect(within(tree).getByText('9 tool calls', {exact: false}).textContent).toContain('3 agents · 9 tool calls · 12,345 tokens');
  const phases = within(tree).getAllByRole('listitem').filter(row => row.parentElement?.className === 'agent-workflow-phases');
  expect(phases.map(row => row.querySelector('strong')!.textContent)).toEqual(['Review', 'Fix', 'Report']);
  expect(within(phases[0]).getAllByRole('listitem').map(row => row.querySelector('strong')!.textContent)).toEqual(['review:#1', 'review:#2']);
  expect(within(phases[2]).queryAllByRole('listitem')).toHaveLength(0);
  expect(within(phases[0]).getByText('7 tool calls · 500 tokens · 1:23')).toBeTruthy();
  expect(within(phases[1]).getAllByText('Running')).toHaveLength(2);
  expect(within(phases[2]).getByText('Waiting')).toBeTruthy();
  // Only the agent with a conversation file can be opened, and it opens by that file.
  const buttons = within(tree).getAllByRole('button', {name: 'Open conversation'});
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({childPath: '/s/a1.jsonl', label: 'review-fix · review:#1'}));
});

it('updates in place when the host sends the next state of the same workflow', () => {
  const {rerender} = render(<AgentWorkflow item={running} />);
  expect(screen.getAllByText('Running').length).toBeGreaterThan(0);
  rerender(<AgentWorkflow item={{...running, state: 'done', workflow: {...running.workflow!, phases: running.workflow!.phases.map(phase => ({...phase, state: 'done' as const})),
    agents: running.workflow!.agents.map(agent => ({...agent, state: 'done' as const}))}}} />);
  expect(screen.queryByText('Running')).toBeNull();
  // The workflow, its three phases and its three agents.
  expect(screen.getAllByText('Done')).toHaveLength(7);
});

it('refuses a workflow tree that is not what the companion sends', () => {
  expect(parseWork([raw])).toEqual([raw]);
  const bad = (change: object) => () => parseWork([{...raw, workflow: {...raw.workflow, ...change}}]);
  expect(bad({agents: [{agentId: 'a', label: 'x', state: 'paused'}]})).toThrow();
  expect(bad({totals: {agents: -1, tokens: 0, toolCalls: 0}})).toThrow();
  expect(bad({phases: [{title: 'x', state: 'weird'}]})).toThrow();
});

// A run that is still going has a journal but no summary file yet, and the companion before the fix sent that as `name: null`.
it('opens a workflow with no name, whether the companion omits it or sends null, and still refuses a name that is not text', () => {
  const unnamed = {...raw, workflow: {...raw.workflow, name: undefined}};
  expect(parseWork([unnamed])).toHaveLength(1);
  expect(parseWork([{...raw, workflow: {...raw.workflow, name: null}}])).toHaveLength(1);
  expect(() => parseWork([{...raw, workflow: {...raw.workflow, name: 7}}])).toThrow();
});

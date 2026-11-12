// @vitest-environment jsdom
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';
import AgentStatusPanel from './AgentStatusPanel';
import {deriveStatus} from './agentBackgroundWork';
import {parseWork, type WorkItem} from './agentWork';

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 11, 12, 0, seconds)).toISOString();
const use = (id: string, name: string, input: object, seconds: number) => ({role: 'assistant', timestamp: at(seconds), blocks: [{type: 'tool_use', id, name, text: JSON.stringify(input)}]});
const result = (id: string, text: string, seconds: number) => ({role: 'tool', timestamp: at(seconds), blocks: [{type: 'tool_result', id, text}]});
const note = (toolUse: string, task: string, status: string, seconds: number, extra = '') => ({role: 'user', timestamp: at(seconds), blocks: [{type: 'text',
  text: `<system-reminder><task-notification><task-id>${task}</task-id><tool-use-id>${toolUse}</tool-use-id><status>${status}</status><summary>Background command "${task}" ${status}</summary>${extra}</task-notification></system-reminder>`}]});
const usage = '<usage><subagent_tokens>131015</subagent_tokens><tool_uses>23</tool_uses><duration_ms>182903</duration_ms></usage>';

const session = [
  use('sh1', 'Bash', {command: 'gh run watch 1', description: 'Watch CI', run_in_background: true}, 0), result('sh1', 'Command running in background with ID: bsh1. Output is being written to: /tmp/x', 1),
  use('sh2', 'Bash', {command: 'sleep 9', run_in_background: true}, 2), result('sh2', 'Command running in background with ID: bsh2.', 3),
  use('fg', 'Bash', {command: 'ls'}, 4), result('fg', 'a b', 5),
  use('mon', 'Monitor', {description: 'Wait for tests', command: 'tail -f log'}, 6), result('mon', 'Monitor started (task bmon, expires in 30m)', 7),
  use('ag1', 'Agent', {description: 'Review the diff', subagent_type: 'general-purpose', run_in_background: true}, 8), result('ag1', 'Async agent launched', 9),
  use('ag2', 'Agent', {description: 'Foreground audit', subagent_type: 'Explore'}, 10),
  use('wf', 'Workflow', {script: "export const meta = {\n  name: 'ship-release',\n};"}, 11), result('wf', 'Workflow started', 12),
  note('sh1', 'bsh1', 'completed', 60),
  note('ag1', 'bag1', 'completed', 100, usage),
];

describe('deriveStatus', () => {
  it('tracks only background work, resolving each from its notification, result or TaskStop', () => {
    const items = deriveStatus([...session, use('stop', 'TaskStop', {task_id: 'bsh2'}, 70)]);
    expect(items.map(({id, kind, state}) => [id, kind, state])).toEqual([
      ['sh1', 'shell', 'done'], ['sh2', 'shell', 'stopped'], ['mon', 'monitor', 'running'], ['ag1', 'agent', 'done'], ['ag2', 'agent', 'running'], ['wf', 'workflow', 'running']]);
    const done = items.find(item => item.id === 'ag1')!;
    // The notification's duration and token count win over the notification's own timestamp.
    expect([done.tokens, done.endedAt! - done.startedAt!, done.type]).toEqual([131015, 182903, 'general-purpose']);
    expect(items.find(item => item.id === 'wf')!.label).toBe('ship-release');
  });
  it('ends a foreground agent with its result and marks a failed one', () => {
    const items = deriveStatus([use('a', 'Task', {description: 'x'}, 0), {role: 'tool', blocks: [{type: 'tool_result', id: 'a', isError: true, text: 'boom'}]}]);
    expect(items[0].state).toBe('failed');
  });
});

describe('AgentStatusPanel', () => {
  afterEach(() => {cleanup(); vi.useRealTimers();});
  it('shows counters, opens the output list and expands the tree with live elapsed time', () => {
    vi.useFakeTimers({now: Date.parse(at(130))});
    render(<AgentStatusPanel messages={session} />);
    const panel = screen.getByRole('region', {name: 'Background work'});
    expect(within(panel).getByText('4 running')).toBeTruthy();
    // sh1 finished; sh2 and the monitor still run.
    fireEvent.click(within(panel).getByRole('button', {name: '1 shell'}));
    const list = within(panel).getByRole('list', {name: '2 shells'});
    expect(within(list).getAllByRole('listitem').map(item => item.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Watch CI'), expect.stringContaining('Done')]));
    fireEvent.click(within(panel).getByRole('button', {name: '1 monitor'}));
    expect(within(panel).getByText('Wait for tests')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', {name: '4 running'}));
    // Running agents first, then the finished one with its recorded duration and tokens.
    expect(within(panel).getByText('Foreground audit').closest('li')!.textContent).toContain('Running · 2:00');
    expect(within(panel).getByText('Review the diff').closest('li')!.textContent).toContain('Done · 3:03 · 131K tokens');
  });
  it('collapses extra rows behind "N more" and renders nothing when no work runs', () => {
    const many = Array.from({length: 5}, (_, index) => use(`a${index}`, 'Agent', {description: `Agent ${index}`, run_in_background: true}, index));
    render(<AgentStatusPanel messages={many} />);
    fireEvent.click(screen.getByRole('button', {name: '5 running'}));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', {name: '2 more'}));
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    cleanup();
    const {container} = render(<AgentStatusPanel messages={[use('x', 'Bash', {command: 'ls'}, 0)]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('AgentStatusPanel from the companion work list', () => {
  afterEach(() => {cleanup(); vi.useRealTimers();});
  const clock = Date.parse(at(600));
  const agoIso = (ms: number) => new Date(clock - ms).toISOString();
  const work: WorkItem[] = [
    {id: 'sh', kind: 'shell', title: 'Wait for CI', command: 'gh run watch 1', state: 'running', startedAt: agoIso(300_000), events: [], last: 'checks pending'},
    {id: 'mo', kind: 'monitor', title: 'PR checks', command: 'gh pr checks 1', state: 'running', startedAt: agoIso(240_000), timeoutMs: 1_800_000, events: ['lint: pass', 'tests: pass'], last: 'tests: pass'},
    {id: 'ag', kind: 'agent', title: 'Review the diff', subtitle: 'general-purpose', state: 'done', startedAt: agoIso(500_000), endedAt: agoIso(400_000), events: [], tokens: 131015, durationMs: 182_903},
    {id: 'old', kind: 'shell', title: 'Forgotten server', state: 'running', startedAt: agoIso(13 * 3600_000), events: []},
  ];
  it('shows the command and recorded output of a shell or monitor, and an old launch as not confirmed instead of running', () => {
    vi.useFakeTimers({now: clock});
    render(<AgentStatusPanel messages={[]} work={work} />);
    const panel = screen.getByRole('region', {name: 'Background work'});
    expect(within(panel).getByRole('button', {name: '2 running'})).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', {name: '2 shells'}));
    const shells = within(panel).getByRole('list', {name: '2 shells'});
    const old = within(shells).getByText('Forgotten server').closest('li')!;
    expect(old.textContent).toContain('Not confirmed');
    fireEvent.click(within(shells).getByText('Wait for CI'));
    expect(within(shells).getByText('gh run watch 1')).toBeTruthy();
    expect(within(shells).getByLabelText('Recorded output').textContent).toBe('checks pending');
    fireEvent.click(within(panel).getByRole('button', {name: '1 monitor'}));
    fireEvent.click(within(panel).getByText('PR checks'));
    expect(within(panel).getByLabelText('Recorded output').textContent).toBe('lint: pass\ntests: pass');
  });
  it('takes a sub-agent run time and tokens from the notice and falls back to the loaded messages without a work list', () => {
    vi.useFakeTimers({now: clock});
    const {rerender} = render(<AgentStatusPanel messages={[]} work={work} />);
    fireEvent.click(screen.getByRole('button', {name: '2 running'}));
    expect(screen.getByText('Review the diff').closest('li')!.textContent).toContain('Done · 3:03 · 131K tokens');
    rerender(<AgentStatusPanel messages={session} />);
    expect(screen.getByRole('button', {name: '4 running'})).toBeTruthy();
  });
  it('shows no panel while nothing is running or unconfirmed, and says not confirmed when only that is left', () => {
    vi.useFakeTimers({now: clock});
    const {container, rerender} = render(<AgentStatusPanel messages={[]} work={[work[2]]} />);
    expect(container.firstChild).toBeNull();
    rerender(<AgentStatusPanel messages={[]} work={[work[3]]} />);
    expect(screen.getByRole('button', {name: '1 not confirmed'})).toBeTruthy();
  });
  it('refuses a work list that is not what the companion sends', () => {
    expect(parseWork(undefined)).toBeUndefined();
    expect(parseWork(work)).toEqual(work);
    expect(() => parseWork([{...work[0], state: 'paused'}])).toThrow();
    expect(() => parseWork([{...work[0], events: [1]}])).toThrow();
    expect(() => parseWork([{...work[0], tokens: -1}])).toThrow();
  });
});

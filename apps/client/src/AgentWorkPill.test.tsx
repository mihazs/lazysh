// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import AgentWorkPill from './AgentWorkPill';
import {parseWork,settleWork,type WorkItem} from './agentWork';

afterEach(cleanup);
const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const work: WorkItem[] = [
  {id: 'a1', kind: 'agent', title: 'Audit the tests', subtitle: 'general-purpose', state: 'running', startedAt: at(5), events: []},
  {id: 'm1', kind: 'monitor', title: 'CI checks', command: 'gh pr checks 1', state: 'running', startedAt: at(4), timeoutMs: 1_800_000, events: ['lint: pass'], last: 'lint: pass'},
  {id: 'b1', kind: 'shell', title: 'Wait for CI', state: 'done', startedAt: at(9), endedAt: at(7), events: [], summary: 'Background command completed (exit code 0)'},
];

it('summarises running work and lists sub-agents and monitors with their recorded output', () => {
  render(<AgentWorkPill work={work} />);
  const pill = screen.getByRole('button', {name: '2 running'});
  expect(screen.queryByRole('region', {name: 'Monitors'})).toBeNull();
  fireEvent.click(pill);
  const agents = screen.getByRole('region', {name: 'Sub-agents'});
  expect(within(agents).getByText('Audit the tests')).toBeTruthy();
  expect(within(agents).getByText('Running')).toBeTruthy();
  const monitors = screen.getByRole('region', {name: 'Monitors'});
  fireEvent.click(within(monitors).getByText('CI checks'));
  expect(within(monitors).getByLabelText('Recorded output').textContent).toBe('lint: pass');
  expect(within(monitors).getByText('gh pr checks 1')).toBeTruthy();
});

it('draws no pill when the host recorded no background work or does not report it', () => {
  const {rerender} = render(<AgentWorkPill work={[]} />);
  expect(screen.queryByRole('button')).toBeNull();
  rerender(<AgentWorkPill />);
  expect(screen.queryByRole('button')).toBeNull();
});

it('says finished or not confirmed instead of running when nothing is recorded as running', () => {
  const {rerender} = render(<AgentWorkPill work={[work[2]]} />);
  expect(screen.getByRole('button', {name: '1 finished'})).toBeTruthy();
  rerender(<AgentWorkPill work={[{...work[0], startedAt: at(13 * 60)}]} />);
  expect(screen.getByRole('button', {name: '1 not confirmed'})).toBeTruthy();
});

it('shows a launch with no recorded end as unknown once it is older than it could run, a monitor after its timeout', () => {
  const now = Date.parse('2026-11-11T10:00:00Z'), ago = (ms: number) => new Date(now - ms).toISOString();
  const rows = settleWork([
    {id: 's', kind: 'shell', title: 'tail', state: 'running', startedAt: ago(3600_000), events: []},
    {id: 'o', kind: 'shell', title: 'old', state: 'running', startedAt: ago(13 * 3600_000), events: []},
    {id: 'm', kind: 'monitor', title: 'mon', state: 'running', startedAt: ago(20 * 60_000), timeoutMs: 600_000, events: []},
    {id: 'd', kind: 'shell', title: 'done', state: 'done', startedAt: ago(20 * 3600_000), events: []},
  ], now);
  expect(rows.map(row => row.state)).toEqual(['running', 'unknown', 'unknown', 'done']);
});

it('refuses a work list that is not what the companion sends', () => {
  expect(parseWork(undefined)).toBeUndefined();
  expect(parseWork(work)).toEqual(work);
  expect(() => parseWork([{...work[0], state: 'paused'}])).toThrow();
  expect(() => parseWork([{...work[0], events: [1]}])).toThrow();
});

it('offers to open only the sub-agents the host tied to their own conversation', () => {
  const open = vi.fn();
  const rows: WorkItem[] = [{...work[0], childPath: '/s/subagents/agent-a1.jsonl'}, {...work[2], id: 'x', title: 'No child'}];
  render(<AgentWorkPill work={rows} onOpen={open} />);
  fireEvent.click(screen.getByRole('button', {name: /running|finished/}));
  const buttons = screen.getAllByRole('button', {name: 'Open conversation'});
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]);
  expect(open).toHaveBeenCalledWith(rows[0]);
  expect(parseWork(rows)).toEqual(rows);
  expect(() => parseWork([{...rows[0], childPath: 3}])).toThrow();
});

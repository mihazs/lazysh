// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import AgentStatusPanel from './AgentStatusPanel';
import AgentTaskStop from './AgentTaskStop';
import {fromWork} from './agentBackgroundWork';
import {publishComposerControl, publishTaskGuard, useTaskStopper} from './agentDialogAnswer';
import {stopMessage, stoppable} from './agentTaskStop';
import type {WorkItem} from './agentWork';
import type {TerminalControl} from './ChatTerminalInput';

const running: WorkItem = {id: 'sh', kind: 'shell', title: 'Wait for CI', state: 'running', taskId: 'b89pe81sq', startedAt: new Date().toISOString(), events: []};
const item = (change: Partial<WorkItem> = {}) => fromWork([{...running, ...change}])[0];
const control = (answer: TerminalControl['answer']): TerminalControl => ({ready: true, busy: false, failed: false, send: vi.fn(), stop: vi.fn(), retry: vi.fn(), answer, cycleMode: vi.fn()});

describe('which tasks can be stopped', () => {
  it('offers only a running task with a plain launch id, so a finished, unknown or odd one has nothing to send', () => {
    expect(stoppable(item())).toBe(true);
    for (const change of [{state: 'done'}, {state: 'stopped'}, {state: 'failed'}, {kind: 'workflow'}, {taskId: undefined}, {taskId: 'b1; rm -rf /'}, {taskId: 'a b'}, {taskId: ''}] as Partial<WorkItem>[]) expect(stoppable(item(change))).toBe(false);
    expect(stopMessage('b89pe81sq')).toBe('Stop background task b89pe81sq with the TaskStop tool, then reply only "stopped".');
  });
});

describe('AgentTaskStop', () => {
  beforeEach(() => vi.useFakeTimers({now: Date.UTC(2026, 10, 11, 12)}));
  afterEach(() => {cleanup(); vi.useRealTimers();});
  it('asks to confirm, sends the one fixed sentence once, and settles to not confirmed when no end is recorded', async () => {
    const send = vi.fn(async () => true);
    render(<AgentTaskStop item={item()} send={send} />);
    fireEvent.click(screen.getByRole('button', {name: 'Stop Wait for CI'}));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Keep running'}));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', {name: 'Stop Wait for CI'}));
    await act(async () => {fireEvent.click(screen.getByRole('button', {name: 'Ask the agent to stop it'}));});
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('Stop background task b89pe81sq with the TaskStop tool, then reply only "stopped".');
    expect(screen.getByRole('status').textContent).toMatch(/Waiting for the record/);
    expect(screen.queryByRole('button')).toBeNull();
    await act(async () => {vi.advanceTimersByTime(91_000);});
    expect(screen.getByRole('status').textContent).toMatch(/Not confirmed/);
  });
  it('says so when nothing was sent and allows one more try', async () => {
    const send = vi.fn(async () => false);
    render(<AgentTaskStop item={item()} send={send} />);
    fireEvent.click(screen.getByRole('button', {name: 'Stop Wait for CI'}));
    await act(async () => {fireEvent.click(screen.getByRole('button', {name: 'Ask the agent to stop it'}));});
    expect(screen.getByRole('alert').textContent).toMatch(/not sent/);
    send.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByRole('button', {name: 'Stop Wait for CI'}));
    fireEvent.click(screen.getByRole('button', {name: 'Ask the agent to stop it'}));
    await act(async () => {});
    expect(send).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('status')).toBeTruthy();
  });
  it('renders nothing for a task that is not running', () => {
    const {container} = render(<AgentTaskStop item={item({state: 'done'})} send={async () => true} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('the background-work panel with a way to stop', () => {
  afterEach(cleanup);
  it('puts Stop on running tasks that have an id and on no other row', () => {
    const work: WorkItem[] = [running, {...running, id: 'old', title: 'Finished job', state: 'done', taskId: 'bdone'}, {...running, id: 'noid', title: 'No id yet', taskId: undefined}];
    render(<AgentStatusPanel messages={[]} work={work} stop={async () => true} />);
    fireEvent.click(screen.getByRole('button', {name: '2 running'}));
    fireEvent.click(screen.getByRole('button', {name: '2 shells'}));
    expect(screen.getAllByRole('button', {name: /^Stop /}).map(button => button.getAttribute('aria-label'))).toEqual(['Stop Wait for CI']);
  });
  it('has no Stop without a stopper', () => {
    render(<AgentStatusPanel messages={[]} work={[running]} />);
    fireEvent.click(screen.getByRole('button', {name: '1 running'}));
    expect(screen.queryByRole('button', {name: /^Stop /})).toBeNull();
  });
});

describe('the stopper of the composer', () => {
  afterEach(() => {publishComposerControl('s', undefined); publishTaskGuard('s', undefined);});
  it('exists only while the composer is bound and the view vouches for the pane, and sends nothing once the pane changed', async () => {
    const answer = vi.fn(async () => true);
    const {result} = renderHook(() => useTaskStopper('s'));
    expect(result.current).toBeUndefined();
    act(() => publishComposerControl('s', control(answer)));
    expect(result.current).toBeUndefined();
    let same = true;
    act(() => publishTaskGuard('s', async () => same));
    expect(result.current).toBeTypeOf('function');
    expect(await result.current!('stop it')).toBe(true);
    expect(answer).toHaveBeenCalledWith({kind: 'send', text: 'stop it'});
    same = false;
    expect(await result.current!('stop it')).toBe(false);
    expect(answer).toHaveBeenCalledTimes(1);
    act(() => publishComposerControl('s', {...control(answer), ready: false}));
    expect(result.current).toBeUndefined();
  });
});

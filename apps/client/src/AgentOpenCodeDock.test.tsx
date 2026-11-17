// @vitest-environment jsdom
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AgentOpenCodeDock from './AgentOpenCodeDock';
import type {AgentSession} from './AgentPanel';
import {bindProtectedInvoke, captureAccess} from './access';
import {chatFollowAccess} from './test/chatFollowAccess';
import {tmuxChatReply} from './test/tmuxChat';
vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn()}));

const hash = 'a'.repeat(64);
const identity = (id: string) => ({id, expectedHash: hash, expiresAt: new Date(Date.now() + 120_000).toISOString(), supported: true});
const permission = (extra = {}) => ({kind: 'permission', ...identity('per_one'), action: 'bash', resources: ['rm -rf build'], save: ['rm *'], ...extra});
const form = (fields: unknown[], extra = {}) => ({kind: 'form', ...identity('frm_one'), title: 'Pick things', fields, ...extra});
const report = (extra: Partial<AgentSession> = {}): AgentSession => ({sessionId: 'ses_agent', agent: 'OpenCode', project: '/work', state: 'needs_attention', updatedAt: new Date().toISOString(), summary: 'Permission requested', paneId: '%3', eventCount: 2, ...extra});

/** The host: what `opencode-service list` prints, the pane this terminal shows and the hook reports. A reply is recorded. */
function host(state: {requests: unknown[]; running?: boolean; available?: boolean; pane?: string; reports?: unknown[]; reply?: unknown}) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'opencode_service_list') return {schemaVersion: 1, service: {available: state.available ?? true, shape: 'v2'}, running: state.running ?? false, requests: state.requests};
    if (command === 'tmux_chat') {
      const reply = await tmuxChatReply(command, args) as {destination?: object};
      return state.pane && reply.destination ? {...reply, destination: {...reply.destination, paneId: state.pane}} : reply;
    }
    if (command === 'agent_snapshot') return {schemaVersion: 1, sessions: state.reports ?? [report()]};
    if (command === 'opencode_service_reply' || command === 'opencode_service_abort') return state.reply ?? {schemaVersion: 1, accepted: true};
    throw new Error(`Unexpected ${command}`);
  });
}
const calls = (name: string) => vi.mocked(invoke).mock.calls.filter(([command]) => command === name).map(([, args]) => args);
const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
async function mount(row: AgentSession | undefined = report(), shown = true) {
  const lease = captureAccess();
  render(<AgentOpenCodeDock sessionId="ssh" shown={shown} row={row} access={lease} invoke={bindProtectedInvoke(lease)} />);
  // The listing renders at the end of the first step; the card takes a moment more before it answers a tap.
  await advance(0);
  await advance(500);
}
const dock = () => screen.getByRole('region', {name: 'OpenCode requests'});
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(invoke).mockReset();
  chatFollowAccess();
  Object.defineProperty(document, 'visibilityState', {configurable: true, value: 'visible'});
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('a permission request', () => {
  it('is answered through the service for exactly the listed request, after the pane and session are checked again', async () => {
    host({requests: [permission()]});
    await mount();
    expect(calls('opencode_service_list')).toEqual([{sessionId: 'ssh', agentSessionId: 'ses_agent'}]);
    expect(within(dock()).getByText('rm -rf build')).toBeTruthy();
    fireEvent.click(within(dock()).getByRole('button', {name: 'Allow once'}));
    await advance(50);
    expect(calls('opencode_service_reply')).toEqual([{sessionId: 'ssh', agentSessionId: 'ses_agent', paneId: '%3', id: 'per_one', expectedHash: hash, expiresAt: expect.any(String), decision: 'once'}]);
    // The host no longer lists it once answered: the card goes away.
    host({requests: []});
    await advance(4000);
    expect(screen.queryByRole('region', {name: 'OpenCode requests'})).toBeNull();
  });

  it('ignores a tap that lands as the card appears', async () => {
    host({requests: [permission()]});
    const lease = captureAccess();
    render(<AgentOpenCodeDock sessionId="ssh" shown row={report()} access={lease} invoke={bindProtectedInvoke(lease)} />);
    await advance(100);
    const button = within(dock()).getByRole('button', {name: 'Allow once'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    await advance(50);
    expect(calls('opencode_service_reply')).toEqual([]);
  });

  it('shows the exact rules before Always allow sends anything, and a rejection carries its reason', async () => {
    host({requests: [permission({save: ['rm *', 'ls *']})]});
    await mount();
    fireEvent.click(within(dock()).getByRole('button', {name: 'Always allow'}));
    expect(within(dock()).getByText('rm *')).toBeTruthy();
    expect(within(dock()).getByText('ls *')).toBeTruthy();
    expect(calls('opencode_service_reply')).toEqual([]);
    fireEvent.click(within(dock()).getByRole('button', {name: 'Cancel'}));
    fireEvent.click(within(dock()).getByRole('button', {name: 'Reject with a message'}));
    fireEvent.change(within(dock()).getByRole('textbox'), {target: {value: 'not in this repo'}});
    fireEvent.click(within(dock()).getByRole('button', {name: 'Reject and send message'}));
    await advance(50);
    expect(calls('opencode_service_reply')).toEqual([expect.objectContaining({decision: 'reject', message: 'not in this repo'})]);
  });

  it('offers no Always allow for a request without rules, and no buttons for one this app cannot show', async () => {
    host({requests: [permission({save: []}), permission({...identity('per_two'), supported: false})]});
    await mount();
    expect(within(dock()).queryByRole('button', {name: 'Always allow'})).toBeNull();
    expect(within(dock()).getAllByRole('button', {name: 'Allow once'})).toHaveLength(1);
    expect(within(dock()).getByText('This request cannot be answered here. Answer it in the terminal.')).toBeTruthy();
  });

  it.each([
    ['another pane shown by the terminal', {pane: '%9'}],
    ['another session reported for the pane', {reports: [report({sessionId: 'ses_other'})]}],
    ['two sessions reported for the pane', {reports: [report(), report({sessionId: 'ses_other'})]}],
  ])('sends nothing when %s', async (_name, change) => {
    host({requests: [permission()], ...change});
    await mount();
    fireEvent.click(within(dock()).getByRole('button', {name: 'Allow once'}));
    await advance(50);
    expect(calls('opencode_service_reply')).toEqual([]);
    expect(within(dock()).getByText('The terminal no longer shows this OpenCode session. Nothing was sent.')).toBeTruthy();
  });

  it('says why the host refused an answer', async () => {
    host({requests: [permission()], reply: {schemaVersion: 1, accepted: false, reason: 'gone'}});
    await mount();
    fireEvent.click(within(dock()).getByRole('button', {name: 'Reject'}));
    await advance(50);
    expect(within(dock()).getByText('This request was already answered, in the terminal or on another device. Nothing was sent.')).toBeTruthy();
  });
});

describe('a question form', () => {
  const fields = [
    {key: 'color', type: 'string', title: 'Color', required: true, options: [{value: 'red', label: 'Red'}, {value: 'blue', label: 'Blue'}]},
    {key: 'tags', type: 'multiselect', title: 'Tags', options: [{value: 'a', label: 'A'}, {value: 'b', label: 'B'}]},
    {key: 'ok', type: 'boolean', title: 'Proceed?'},
    {key: 'count', type: 'integer', title: 'Count'},
    {key: 'note', type: 'string', title: 'Note'},
  ];
  it('is sent once with the answers given, and only when the required fields are filled', async () => {
    host({requests: [form(fields)]});
    await mount();
    const send = within(dock()).getByRole('button', {name: 'Send answer'}) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(dock()).getByRole('radio', {name: 'Blue'}));
    fireEvent.click(within(dock()).getByRole('checkbox', {name: 'A'}));
    fireEvent.click(within(dock()).getByRole('checkbox', {name: 'B'}));
    fireEvent.click(within(dock()).getByRole('checkbox', {name: 'A'}));
    fireEvent.click(within(dock()).getByRole('radio', {name: 'Yes'}));
    fireEvent.change(within(dock()).getByLabelText('Count'), {target: {value: '3'}});
    fireEvent.change(within(dock()).getByLabelText('Note'), {target: {value: 'hi'}});
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await advance(50);
    const [reply] = calls('opencode_service_reply') as {answer: string; id: string}[];
    expect(reply.id).toBe('frm_one');
    expect(JSON.parse(reply.answer)).toEqual({color: 'blue', tags: ['b'], ok: true, count: 3, note: 'hi'});
    expect(calls('opencode_service_reply')).toHaveLength(1);
  });

  it('stays in the terminal when a field cannot be shown', async () => {
    host({requests: [form(fields, {supported: false})]});
    await mount();
    expect(within(dock()).queryByRole('button', {name: 'Send answer'})).toBeNull();
    expect(within(dock()).getByText('This request cannot be answered here. Answer it in the terminal.')).toBeTruthy();
  });
});

describe('stopping a turn', () => {
  it('asks twice and stops once through the service', async () => {
    host({requests: [], running: true});
    await mount();
    const stop = within(dock()).getByRole('button', {name: 'Request stop'});
    fireEvent.click(stop);
    expect(calls('opencode_service_abort')).toEqual([]);
    fireEvent.click(within(dock()).getByRole('button', {name: 'Tap again to stop the agent'}));
    await advance(50);
    expect(calls('opencode_service_abort')).toEqual([{sessionId: 'ssh', agentSessionId: 'ses_agent', paneId: '%3'}]);
  });
});

describe('when the service cannot be used', () => {
  it.each([
    ['another agent is in the pane', {row: report({agent: 'Codex'}), available: true}],
    ['the pane is unknown', {row: report({paneId: null}), available: true}],
    ['no service runs on the host', {row: report(), available: false}],
  ])('shows nothing when %s', async (_name, {row, available}) => {
    host({requests: [permission()], available});
    await mount(row);
    expect(screen.queryByRole('region', {name: 'OpenCode requests'})).toBeNull();
  });

  it('shows nothing for a listing it cannot read, so the prompt stays in the terminal', async () => {
    host({requests: [{...permission(), expectedHash: 'short'}]});
    await mount();
    expect(screen.queryByRole('region', {name: 'OpenCode requests'})).toBeNull();
  });

  it('asks the host nothing while hidden', async () => {
    host({requests: [permission()]});
    await mount(report(), false);
    expect(calls('opencode_service_list')).toEqual([]);
  });
});

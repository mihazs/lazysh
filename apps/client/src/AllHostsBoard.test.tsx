// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, fireEvent, render, screen, within} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {AgentPanel} from './AgentPanel';
import AllHostsBoard, {distinctHosts, type BoardHost} from './AllHostsBoard';
import {archiveReport, saveArchive} from './agentArchive';
import {applyAccessStatus} from './access';

vi.mock('@tauri-apps/api/core', async original => ({...await original<typeof import('@tauri-apps/api/core')>(), invoke: vi.fn(), Channel: class {onmessage?: unknown;}}));
vi.mock('./ApprovalPanel', () => ({default: () => null}));

const base = {agent: 'Claude Code', state: 'working', paneId: '%3', eventCount: 1};
const report = (sessionId: string, project: string, summary: string, extra: object = {}) => ({...base, sessionId, project, summary, updatedAt: '2026-10-24T19:30:00Z', ...extra});
const build: BoardHost = {sessionId: 'ssh-build', hostKey: 'host-build', hostLabel: 'Build box'};
const staging: BoardHost = {sessionId: 'ssh-staging', hostKey: 'host-staging', hostLabel: 'Staging'};
let generation = 0;
let pendingNative: Array<(result: unknown) => void> = [];
function deferredNative(finish?: Array<(result: unknown) => void>): Promise<unknown> {
  return new Promise(resolve => { pendingNative.push(resolve); finish?.push(resolve); });
}

/** Answers each connection's own snapshot; a connection set to `failing` fails the way an unreachable host does. */
function hostsAnswer(rows: Record<string, unknown[]>, failing = new Set<string>()) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'agent_snapshot') return {schemaVersion: 1, revision: 0, transcriptDiscoveryEnabled: true, recordedUsageEnabled: true, deviceToolsEnabled: true};
    const id = (args as {sessionId: string}).sessionId;
    if (failing.has(id)) throw {message: 'lazysh-agent: command not found'};
    return {schemaVersion: 1, sessions: rows[id] ?? []};
  });
}
const snapshotReads = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'agent_snapshot').map(([, args]) => (args as {sessionId: string}).sessionId);
async function slowBoard(count: number) {
  const hosts = Array.from({length: count}, (_, index) => ({sessionId: `ssh-${index}`, hostKey: `host-${index}`, hostLabel: `Host ${index}`}));
  const finish: Array<(result: unknown) => void> = [];
  vi.mocked(invoke).mockImplementation(() => deferredNative(finish));
  const view = render(<AllHostsBoard hosts={hosts} visible onOpen={() => {}}/>);
  await act(async () => {});
  return {hosts, finish, view};
}
const groups = (state: string) => [...screen.getByRole('region', {name: state}).querySelectorAll(':scope > .agent-host-group')].map(group => group.getAttribute('aria-label'));

beforeEach(() => { localStorage.clear(); applyAccessStatus({initialized: true, supported: true, reason: '', enabled: true, locked: false, generation: String(++generation), nonce: 'a'.repeat(64)}); });
afterEach(async () => {
  cleanup();
  await act(async () => { for (const resolve of pendingNative) resolve({schemaVersion: 1, sessions: []}); });
  pendingNative = [];
  vi.useRealTimers(); vi.clearAllMocks();
});

describe('board that merges connected hosts', () => {
  it('stays the per-connection board until another host is connected and All hosts is chosen', async () => {
    hostsAnswer({'ssh-build': [report('a1', '/srv/api', 'Build api')], 'ssh-staging': [report('s1', '/srv/web', 'Deploy web')]});
    const view = render(<AgentPanel sessionId="ssh-build" hostKey="host-build" hostLabel="Build box" hosts={[build]} showHerdr={false}/>);
    await screen.findByText('Build api');
    expect(screen.queryByRole('group', {name: 'Board scope'})).toBeNull();
    view.rerender(<AgentPanel sessionId="ssh-build" hostKey="host-build" hostLabel="Build box" hosts={[build, {...build, sessionId: 'ssh-build-2'}]} showHerdr={false}/>);
    expect(screen.queryByRole('group', {name: 'Board scope'})).toBeNull();
    view.rerender(<AgentPanel sessionId="ssh-build" hostKey="host-build" hostLabel="Build box" hosts={[build, staging]} showHerdr={false}/>);
    expect(screen.getByRole('button', {name: 'This host'}).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('Deploy web')).toBeNull();
    expect(snapshotReads()).not.toContain('ssh-staging');
  });

  it('groups by state, then host, then project and reads each host through its own connection', async () => {
    hostsAnswer({
      'ssh-build': [report('a1', '/srv/api', 'Build api'), report('a2', '/srv/api', 'Fix tests'), report('a3', '/srv/docs', 'Write guide'), report('a4', '/srv/api', 'Ship release', {state: 'done'})],
      'ssh-staging': [report('s1', '/srv/web', 'Deploy web'), report('s2', '/srv/web', 'Approve push', {state: 'needs_attention'})],
    });
    render(<AgentPanel sessionId="ssh-build" hostKey="host-build" hostLabel="Build box" hosts={[build, staging]} showHerdr={false}/>);
    await screen.findByText('Build api');
    fireEvent.click(screen.getByRole('button', {name: 'All hosts'}));
    await screen.findByText('Deploy web');
    expect(new Set(snapshotReads())).toEqual(new Set(['ssh-build', 'ssh-staging']));
    expect(groups('Working')).toEqual(['Build box', 'Staging']);
    const working = within(screen.getByRole('region', {name: 'Working'}));
    expect(within(working.getByRole('region', {name: 'Build box'})).getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual(['api on Build box', 'docs on Build box']);
    expect(within(working.getByRole('region', {name: 'api on Build box'})).getAllByText(/Build api|Fix tests/).length).toBe(2);
    expect(groups('Attention')).toEqual(['Staging']);
    expect(groups('Done')).toEqual(['Build box']);
    expect(screen.getByText('Showing 6 of 6 reported sessions')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Attention 1'}));
    expect(screen.queryByText('Build api')).toBeNull();
    expect(screen.getByText('Approve push')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox'), {target: {value: 'build'}});
    expect(screen.getByText('No matching reported agents')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', {name: 'Clear filters'}));
    fireEvent.change(screen.getByRole('searchbox'), {target: {value: 'staging'}});
    expect(screen.getByText('Showing 2 of 6 reported sessions')).toBeTruthy();
  });

  it('shows a failing host its own error row, keeps the others and recovers on a later read', async () => {
    vi.useFakeTimers();
    const failing = new Set(['ssh-staging']);
    hostsAnswer({'ssh-build': [report('a1', '/srv/api', 'Build api')], 'ssh-staging': [report('s1', '/srv/web', 'Deploy web')]}, failing);
    render(<AllHostsBoard hosts={[build, staging]} visible onOpen={() => {}}/>);
    await act(async () => {});
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Staging');
    expect(alert.textContent).toContain('lazysh-agent: command not found');
    expect(screen.getByText('Build api')).toBeTruthy();
    expect(screen.queryByText('No agent events yet.')).toBeNull();
    failing.clear();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Deploy web')).toBeTruthy();
    // A host that fails again drops its own rows instead of showing stale ones.
    failing.add('ssh-staging');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByText('Deploy web')).toBeNull();
    expect(screen.getByText('Build api')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Staging');
  });

  it('hides what each host board archived under that host\'s own key until a newer event', async () => {
    const row = report('s1', '/srv/web', 'Deploy web');
    hostsAnswer({'ssh-build': [report('a1', '/srv/api', 'Build api')], 'ssh-staging': [row, report('s2', '/srv/web', 'Other web')]});
    // The entry for Build box's session under Staging's key must not hide Build box's own row.
    saveArchive('host-staging', archiveReport(archiveReport([], row as never), {...row, sessionId: 'a1'} as never));
    const view = render(<AllHostsBoard hosts={[build, staging]} visible onOpen={() => {}}/>);
    await screen.findByText('Other web');
    expect(screen.queryByText('Deploy web')).toBeNull();
    expect(screen.getByText('Build api')).toBeTruthy();
    expect(screen.getByText('1 archived reports are hidden here. Restore them on each host\'s own board.')).toBeTruthy();
    expect(screen.queryByRole('button', {name: /Archive|Restore/})).toBeNull();
    view.unmount();
    hostsAnswer({'ssh-build': [report('a1', '/srv/api', 'Build api')], 'ssh-staging': [report('s1', '/srv/web', 'Deploy web again', {updatedAt: '2026-10-24T19:45:00Z'})]});
    render(<AllHostsBoard hosts={[build, staging]} visible onOpen={() => {}}/>);
    expect(await screen.findByText('Deploy web again')).toBeTruthy();
  });

  it('opens the connection of a row and returns the panel to its own host board', async () => {
    hostsAnswer({'ssh-build': [report('a1', '/srv/api', 'Build api')], 'ssh-staging': [report('s1', '/srv/web', 'Approve push', {state: 'needs_attention', paneId: '%9'})]});
    const opened: unknown[] = [];
    window.addEventListener('lazysh-inbox-open', event => opened.push((event as CustomEvent).detail), {once: true});
    render(<AgentPanel sessionId="ssh-build" hostKey="host-build" hostLabel="Build box" hosts={[build, staging]} showHerdr={false}/>);
    fireEvent.click(screen.getByRole('button', {name: 'All hosts'}));
    fireEvent.click(await screen.findByRole('button', {name: 'Open Claude Code report for /srv/web on Staging'}));
    expect(opened).toEqual([{sessionId: 'ssh-staging', paneId: '%9', waiting: true, section: 'activity'}]);
    expect(screen.getByRole('button', {name: 'This host'}).getAttribute('aria-pressed')).toBe('true');
  });

  it('reads at most 32 hosts, four at a time, and says how many are left out', async () => {
    const many = Array.from({length: 40}, (_, index) => ({sessionId: `ssh-${index}`, hostKey: `host-${index}`, hostLabel: `Host ${index}`}));
    let running = 0, peak = 0;
    vi.mocked(invoke).mockImplementation(async () => { peak = Math.max(peak, ++running); await new Promise(resolve => setTimeout(resolve, 1)); running--; return {schemaVersion: 1, sessions: []}; });
    render(<AllHostsBoard hosts={many} visible onOpen={() => {}}/>);
    await screen.findByText('Showing 32 of 40 connected hosts.');
    await screen.findByText('No agent events yet.');
    expect(snapshotReads()).toHaveLength(32);
    expect(new Set(snapshotReads()).has('ssh-32')).toBe(false);
    expect(peak).toBe(4);
  });

  it('keeps the four-read limit when a poll overlaps slow hosts', async () => {
    vi.useFakeTimers();
    const many = Array.from({length: 8}, (_, index) => ({sessionId: `ssh-${index}`, hostKey: `host-${index}`, hostLabel: `Host ${index}`}));
    vi.mocked(invoke).mockImplementation(() => deferredNative());
    render(<AllHostsBoard hosts={many} visible onOpen={() => {}}/>);
    await act(async () => {});
    expect(snapshotReads()).toHaveLength(4);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(snapshotReads()).toHaveLength(4);
  });

  it('does not start queued reads after the board is hidden', async () => {
    const {hosts: many, finish, view} = await slowBoard(8);
    expect(snapshotReads()).toHaveLength(4);
    view.rerender(<AllHostsBoard hosts={many} visible={false} onOpen={() => {}}/>);
    await act(async () => { finish[0]({schemaVersion: 1, sessions: []}); });
    expect(snapshotReads()).toHaveLength(4);
  });

  it('keeps refreshing other hosts while one read is stalled', async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation((_command, args) => (args as {sessionId: string}).sessionId === build.sessionId
      ? deferredNative() : Promise.resolve({schemaVersion: 1, sessions: []}));
    render(<AllHostsBoard hosts={[build, staging]} visible onOpen={() => {}}/>);
    await act(async () => {});
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(snapshotReads().filter(id => id === build.sessionId)).toHaveLength(1);
    expect(snapshotReads().filter(id => id === staging.sessionId)).toHaveLength(2);
  });

  it('skips a queued host that disconnects before its read starts', async () => {
    const {hosts: many, finish, view} = await slowBoard(5);
    view.rerender(<AllHostsBoard hosts={many.slice(0, 4)} visible onOpen={() => {}}/>);
    await act(async () => { finish[0]({schemaVersion: 1, sessions: []}); });
    expect(snapshotReads()).not.toContain('ssh-4');
  });

  it.each([false, true])('keeps native requests counted across remount (epoch changes: %s)', async changeEpoch => {
    const {hosts, finish, view} = await slowBoard(8);
    expect(snapshotReads()).toHaveLength(4);
    if (changeEpoch) applyAccessStatus({initialized: true, supported: true, reason: '', enabled: true, locked: false, generation: String(++generation), nonce: 'b'.repeat(64)});
    view.unmount();
    render(<AllHostsBoard hosts={hosts} visible onOpen={() => {}}/>);
    await act(async () => {});
    expect(snapshotReads()).toHaveLength(4);
    await act(async () => { finish[0]({schemaVersion: 1, sessions: []}); });
    expect(snapshotReads()).toHaveLength(5);
  });

  it('counts sessions of one saved host once and reads nothing while hidden', async () => {
    expect(distinctHosts([build, {...build, sessionId: 'ssh-build-2'}, staging]).map(host => host.sessionId)).toEqual(['ssh-build', 'ssh-staging']);
    hostsAnswer({});
    const view = render(<AllHostsBoard hosts={[build, staging]} visible={false} onOpen={() => {}}/>);
    await act(async () => {});
    expect(snapshotReads()).toEqual([]);
    view.rerender(<AllHostsBoard hosts={[build, staging]} visible onOpen={() => {}}/>);
    await act(async () => {});
    expect(snapshotReads()).toEqual(['ssh-build', 'ssh-staging']);
  });
});

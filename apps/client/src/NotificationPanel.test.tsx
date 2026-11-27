// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import NotificationPanel, { NotificationMonitor } from './NotificationPanel';
import PreferencesPanel from './PreferencesPanel';
import { openSettingsPages } from './test/preferencesPanel';
import { getInbox, updateInbox } from './notificationStore';
import { localHostKey } from './localHost';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true, Channel: class { onmessage: ((event: unknown) => void) | undefined; } }));
vi.mock('@tauri-apps/plugin-notification', () => ({ isPermissionGranted: vi.fn(), requestPermission: vi.fn(), registerActionTypes: vi.fn().mockResolvedValue(undefined), onAction: vi.fn().mockResolvedValue({ unregister: vi.fn() }) }));
vi.stubGlobal('crypto', webcrypto);
const sessions = [{ id: 'ssh1', hostId: 'host1', name: 'Dev host', connected: true }];
const event = { sessionId: 'agent1', agent: 'Claude', project: '/work', state: 'needs_attention', updatedAt: '2026-10-24T22:00:00Z', summary: 'private prompt', paneId: '%1', eventCount: 1 };
beforeEach(() => { localStorage.clear(); updateInbox({ version: 1, monitoring: false, notifications: false, rows: [], latest: {}, error: '' }); vi.mocked(isPermissionGranted).mockResolvedValue(false); vi.mocked(requestPermission).mockResolvedValue('granted'); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

it('does not poll or request permission until explicitly enabled', async () => {
  render(<><NotificationMonitor sessions={sessions} /><NotificationPanel sessions={sessions} /></>);
  expect(invoke).not.toHaveBeenCalled();
  expect(requestPermission).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Enable system notifications' }));
  expect(await screen.findByText('System notifications enabled for new attention events while connected.')).toBeTruthy();
  expect(requestPermission).toHaveBeenCalledOnce();
  expect(invoke).not.toHaveBeenCalled();
});

it('notifies once after a new attention event and pauses further collection', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockResolvedValue({ schemaVersion: 1, sessions: [event] });
  render(<><NotificationMonitor sessions={sessions} /><NotificationPanel sessions={sessions} /></>);
  fireEvent.click(screen.getByRole('button', { name: 'Enable system notifications' }));
  await screen.findByText('System notifications enabled for new attention events while connected.');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Monitor connected hosts' }));
  await screen.findByRole('article', { name: 'Claude' });
  expect(screen.getByRole('button', { name: /^Needs you\s*1$/ }).getAttribute('aria-expanded')).toBe('true');
  await act(async () => {});
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'notify_agent_attention')).toHaveLength(0);
  vi.mocked(invoke).mockImplementation(async command => command === 'agent_snapshot' ? { schemaVersion: 1, sessions: [{ ...event, eventCount: 2, updatedAt: '2026-10-24T22:01:00Z' }] } : undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
  await waitFor(() => expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'notify_agent_attention')).toHaveLength(1));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh inbox' }));
  await waitFor(() => expect(getInbox().rows[0].updatedAt).toBe('2026-10-24T22:01:00.000Z'));
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'notify_agent_attention')).toHaveLength(1);
  fireEvent.click(screen.getByRole('checkbox', { name: 'Monitor connected hosts' }));
  const calls = vi.mocked(invoke).mock.calls.length;
  act(() => window.dispatchEvent(new Event('lazysh-inbox-refresh')));
  expect(invoke).toHaveBeenCalledTimes(calls);
  expect(JSON.stringify(getInbox())).not.toContain('private prompt');
});

it('polls at most four hosts concurrently, asks each host for its Herdr servers within those four, and discards late results after unmount', async () => {
  const pending: ((value: unknown) => void)[] = [];
  let inFlight = 0, peak = 0;
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => { peak = Math.max(peak, ++inFlight); pending.push(value => { inFlight--; resolve(value); }); }));
  updateInbox({ monitoring: true });
  const many = Array.from({ length: 12 }, (_, index) => ({ ...sessions[0], id: `ssh${index}`, hostId: `host${index}` }));
  const mounted = render(<NotificationMonitor sessions={many} />);
  expect(invoke).toHaveBeenCalledTimes(4);
  await act(async () => { pending[0]({ schemaVersion: 1, sessions: [] }); });
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(5));
  expect(vi.mocked(invoke).mock.calls[4][1]).toEqual({ sessionId: 'ssh0', kind: 'herdr' });
  mounted.unmount();
  const before = getInbox().rows;
  await act(async () => { pending.slice(1).forEach(resolve => resolve({ schemaVersion: 1, sessions: [event] })); });
  expect(getInbox().rows).toBe(before);
  expect(peak).toBe(4);
});

it('groups inbox events by attention state, folds a group and ties opening to the live connection', async () => {
  vi.useFakeTimers({ now: new Date('2026-10-24T22:10:00Z'), toFake: ['setInterval', 'clearInterval', 'Date'] });
  try {
    const row = (id: string, state: 'needs_attention' | 'working' | 'done', agent: string, sessionId: string, minutes: number) => ({ id: id.repeat(64), eventId: ({ a: 'b', c: 'd', e: 'f' } as Record<string, string>)[id].repeat(64), sessionId, hostId: 'host1', hostName: 'Dev host', agent, project: `/work/${agent.toLowerCase()}`, agentSessionId: agent, state, updatedAt: new Date(Date.parse('2026-10-24T22:10:00Z') - minutes * 60000).toISOString(), paneId: '%1' });
    updateInbox({ monitoring: true, rows: [row('c', 'done', 'Finished', 'ssh1', 90), row('a', 'needs_attention', 'Blocked', 'ssh1', 4), row('e', 'working', 'Busy', 'gone', 1)] });
    render(<NotificationPanel sessions={sessions} />);
    const toggles = screen.getAllByRole('button', { expanded: true }).map(button => button.textContent);
    expect(toggles).toEqual(['Needs you1', 'Working1', 'Done1']);
    const blocked = screen.getByRole('article', { name: 'Blocked' });
    expect(blocked.textContent).toContain('blocked');
    expect(blocked.querySelector('time')?.textContent).toBe('4 min. ago');
    expect(blocked.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-24T22:06:00.000Z');
    expect(within(blocked).getByRole('button', { name: 'Open connected session' })).toHaveProperty('disabled', false);
    expect(within(screen.getByRole('article', { name: 'Busy' })).getByRole('button', { name: 'Open connected session' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Watching connected hosts for agent events.')).toBeTruthy();
    expect(screen.getByText('Monitoring and notifications').closest('details')?.open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /^Done\s*1$/ }));
    expect(screen.queryByRole('article', { name: 'Finished' })).toBeNull();
    expect(screen.getByRole('button', { name: /^Done\s*1$/ }).getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(within(blocked).getByRole('button', { name: 'Archive' }));
    expect(screen.queryByRole('article', { name: 'Blocked' })).toBeNull();
    expect(getInbox().rows.map(event => event.agent)).toEqual(['Finished', 'Busy']);
  } finally { vi.useRealTimers(); }
});

it('shows an explicit empty state with monitoring settings open when nothing has been collected', () => {
  render(<NotificationPanel sessions={sessions} />);
  expect(screen.getByText('No agent events yet')).toBeTruthy();
  expect(screen.getByText('Monitoring and notifications').closest('details')?.open).toBe(true);
  expect(screen.getByRole('button', { name: 'Clear inbox' })).toHaveProperty('disabled', true);
});


it('opens Android notification settings after permission is denied', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
  vi.mocked(requestPermission).mockResolvedValue('denied');
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(<NotificationPanel sessions={sessions} />);
  fireEvent.click(screen.getByRole('button', { name: 'Enable system notifications' }));
  await screen.findByText('Notification permission was not granted. The inbox remains available.');
  fireEvent.click(screen.getByRole('button', { name: 'Open Android notification settings' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_notification_settings', undefined, expect.anything()));
});

it('offers Android notification recovery in application settings', async () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android');
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(<PreferencesPanel />);
  fireEvent.click(openSettingsPages('Android notifications').getByRole('button', { name: 'Open Android notification settings' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_notification_settings', undefined, expect.anything()));
});

it('polls this device once for every local tab and names its attention events This device', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockResolvedValue({ schemaVersion: 1, sessions: [event] });
  updateInbox({ monitoring: true, notifications: true });
  const tabs = ['local:one', 'local:two'].map(id => ({ id, hostId: localHostKey(), name: 'Local terminal', connected: true, local: true }));
  render(<><NotificationMonitor sessions={tabs} /><NotificationPanel sessions={tabs} /></>);
  const row = await screen.findByRole('article', { name: 'Claude' });
  expect(within(row).getByText('This device')).toBeTruthy();
  expect(within(row).queryByText('Local terminal')).toBeNull();
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'agent_snapshot')).toHaveLength(1);
  expect(getInbox().rows.map(item => item.hostId)).toEqual(['local:default']);
});

/** A pane the open Herdr view follows became blocked, as the hub reports it. */
const herdrTransition = (extra: Record<string, unknown> = {}) => ({ sessionId: 'ssh1', server: 'main', paneId: 'w1:p2', workspaceId: 'w1', status: 'blocked', agent: 'codex', cwd: '/work', agentSession: { agent: 'codex', value: 'codex-1' }, at: Date.now(), sequence: 1, ...extra });
const announce = (detail: object) => act(async () => { window.dispatchEvent(new CustomEvent('lazysh-herdr-transition', { detail })); });
/** A monitor with notifications on and no host reports yet. */
const watchHerdr = async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async command => command === 'agent_snapshot' ? { schemaVersion: 1, sessions: [] } : undefined);
  updateInbox({ monitoring: true, notifications: true });
  const view = render(<NotificationMonitor sessions={sessions} />);
  await act(async () => {});
  return view;
};
const notified = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'notify_agent_attention');

it('turns a blocked Herdr pane into an inbox row and one system notification, without a poll', async () => {
  await watchHerdr();
  await announce(herdrTransition());
  await waitFor(() => expect(notified()).toHaveLength(1));
  expect(notified()[0][1]).toEqual({ sessionId: 'ssh1', agent: 'Codex', project: '/work', eventId: getInbox().rows[0].eventId });
  expect(getInbox().rows).toHaveLength(1);
  expect(getInbox().rows[0]).toMatchObject({ agent: 'Codex', state: 'needs_attention', paneId: 'herdr:main:w1:p2' });
  // The hook's report of the same turn arrives with the next poll: the same row, no second notification.
  vi.mocked(invoke).mockImplementation(async command => command === 'agent_snapshot' ? { schemaVersion: 1, sessions: [{ ...event, sessionId: 'codex-1', agent: 'Codex', project: '/work', paneId: '%3', eventCount: 3, updatedAt: new Date().toISOString() }] } : undefined);
  fireEvent(window, new Event('lazysh-inbox-refresh'));
  await waitFor(() => expect(getInbox().rows[0].paneId).toBe('%3'));
  expect(getInbox().rows).toHaveLength(1);
  expect(notified()).toHaveLength(1);
});

it('records a finished Herdr agent quietly and ignores events of a host that is not connected or while monitoring is off', async () => {
  await watchHerdr();
  await announce(herdrTransition({ status: 'done' }));
  await waitFor(() => expect(getInbox().rows.map(row => row.state)).toEqual(['done']));
  await announce(herdrTransition({ sessionId: 'elsewhere', paneId: 'w1:p3', sequence: 2 }));
  await announce(herdrTransition({ status: 'working', paneId: 'w1:p4', sequence: 3 }));
  act(() => updateInbox({ monitoring: false }));
  await announce(herdrTransition({ paneId: 'w1:p5', sequence: 4 }));
  expect(getInbox().rows).toHaveLength(1);
  expect(notified()).toHaveLength(0);
});

it('lists the pane without notifying while system notifications are paused, and reports a failed notification', async () => {
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async command => { if (command === 'notify_agent_attention') throw new Error('notification service down'); return { schemaVersion: 1, sessions: [] }; });
  updateInbox({ monitoring: true, notifications: false });
  render(<NotificationMonitor sessions={sessions} />);
  await act(async () => {});
  await announce(herdrTransition());
  await waitFor(() => expect(getInbox().rows).toHaveLength(1));
  expect(notified()).toHaveLength(0);
  updateInbox({ notifications: true });
  await announce(herdrTransition({ paneId: 'w1:p9', agentSession: null, sequence: 9 }));
  await waitFor(() => expect(getInbox().error).toContain('notification service down'));
});

it.each(['monitoring','connection'])('invalidates delayed events after %s is disabled and restored', async kind => {
  const view = await watchHerdr();
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  let finished!: () => void;
  const completed = new Promise<void>(resolve => { finished = resolve; });
  const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
    if (first) { first = false; await gate; }
    else { const result = await digest(...args); finished(); return result; }
    return digest(...args);
  });
  try {
    await announce(herdrTransition());
    if (kind === 'monitoring') {
      act(() => updateInbox({ monitoring: false }));
      act(() => updateInbox({ monitoring: true }));
    } else {
      view.rerender(<NotificationMonitor sessions={[]} />);
      view.rerender(<NotificationMonitor sessions={sessions} />);
    }
    await act(async () => { release(); await completed; });
    expect(getInbox().rows).toEqual([]);
    expect(notified()).toHaveLength(0);
  } finally { release(); spy.mockRestore(); }
});

type WatchChannel = { onmessage: (event: unknown) => void };
const calls = (command: string) => vi.mocked(invoke).mock.calls.filter(([name]) => name === command);
const codexTree = (session: string) => ({ workspaces: [], tabs: [], panes: [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p2', focused: false, agent_status: 'blocked' }],
  agents: [{ terminal_id: 't2', workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p2', name: null, agent: 'codex', agent_status: 'blocked', agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: session } }] });
/** A host that runs one Herdr server, `main`, with a Codex agent of `session` in `w1:p2`; `reports` is what its hooks report.
 * Each test names its own session: what Herdr reported of a turn is remembered across tests of this file. */
const herdrHost = (session: string) => {
  const channels: WatchChannel[] = [];
  const send = (frame: object) => act(async () => { channels[0].onmessage({ type: 'frame', frame }); });
  const host = { reports: [] as object[], channels, send, blocked: () => send({ type: 'status', paneId: 'w1:p2', workspaceId: 'w1', status: 'blocked', agent: 'codex', cwd: '/work' }),
    hook: (extra: object = {}) => ({ ...event, sessionId: session, agent: 'Codex', project: '/work', paneId: 'herdr:main:w1:p2', eventCount: 1, updatedAt: new Date().toISOString(), ...extra }) };
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === 'agent_snapshot') return { schemaVersion: 1, sessions: host.reports };
    if (command === 'multiplexer_sessions') return [{ name: 'main' }];
    if (command === 'herdr_tree') return codexTree(session);
    if (command === 'agent_watch_start') { channels.push((args as { events: WatchChannel }).events); return `watch-${channels.length}`; }
  });
  return host;
};

it('follows the Herdr server of each connected host while monitoring is on, with no Herdr view, and closes the stream with the host or the monitoring', async () => {
  const host = herdrHost('codex-a');
  updateInbox({ monitoring: true });
  const mounted = render(<NotificationMonitor sessions={sessions} />);
  await waitFor(() => expect(calls('agent_watch_start')).toHaveLength(1));
  expect(calls('agent_watch_start')[0][1]).toMatchObject({ sessionId: 'ssh1', target: { kind: 'herdrEvents', herdrSession: 'main' } });
  // Another poll lists the servers again and keeps the stream it has.
  fireEvent(window, new Event('lazysh-inbox-refresh'));
  await waitFor(() => expect(calls('multiplexer_sessions')).toHaveLength(2));
  expect(calls('agent_watch_start')).toHaveLength(1);
  mounted.rerender(<NotificationMonitor sessions={[{ ...sessions[0], connected: false }]} />);
  await waitFor(() => expect(calls('agent_watch_stop')).toHaveLength(1));
  mounted.rerender(<NotificationMonitor sessions={sessions} />);
  await waitFor(() => expect(calls('agent_watch_start')).toHaveLength(2));
  act(() => updateInbox({ monitoring: false }));
  await waitFor(() => expect(calls('agent_watch_stop')).toHaveLength(2));
  mounted.unmount();
  expect(host.channels).toHaveLength(2);
  expect(calls('agent_watch_stop')).toHaveLength(2);
});

it('leaves a host with several Herdr servers unfollowed unless its terminal is attached to one of them', async () => {
  herdrHost('codex-b');
  const listing = vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async (command, args) => command === 'multiplexer_sessions' ? [{ name: 'a' }, { name: 'b' }] : listing(command, args));
  updateInbox({ monitoring: true });
  render(<NotificationMonitor sessions={sessions} />);
  await waitFor(() => expect(calls('multiplexer_sessions')).toHaveLength(1));
  await act(async () => {});
  expect(calls('agent_watch_start')).toHaveLength(0);
  const attached = { ...sessions[0], attached: { kind: 'herdr', name: 'b' } };
  cleanup();
  render(<NotificationMonitor sessions={[attached]} />);
  await waitFor(() => expect(calls('agent_watch_start')).toHaveLength(1));
  expect(calls('agent_watch_start')[0][1]).toMatchObject({ target: { herdrSession: 'b' } });
});

it('turns a blocked agent of the monitor\'s stream into one inbox row and one notification, and the hook\'s report of the same turn is neither another row nor another alert', async () => {
  const host = herdrHost('codex-c');
  updateInbox({ monitoring: true, notifications: true });
  render(<NotificationMonitor sessions={sessions} />);
  await waitFor(() => expect(host.channels).toHaveLength(1));
  await host.send({ type: 'hello', protocol: 1, session: 'main' });
  await host.blocked();
  await waitFor(() => expect(calls('notify_agent_attention')).toHaveLength(1));
  // No Herdr view reads the tree, so one read tells which session is in the pane.
  expect(calls('herdr_tree')).toHaveLength(1);
  expect(getInbox().rows).toHaveLength(1);
  expect(getInbox().rows[0]).toMatchObject({ agent: 'Codex', state: 'needs_attention', agentSessionId: 'codex-c', paneId: 'herdr:main:w1:p2', project: '/work' });
  host.reports.push(host.hook({ state: 'needs_attention' }));
  fireEvent(window, new Event('lazysh-inbox-refresh'));
  await waitFor(() => expect(calls('agent_snapshot')).toHaveLength(2));
  await act(async () => {});
  expect(getInbox().rows).toHaveLength(1);
  expect(calls('notify_agent_attention')).toHaveLength(1);
  // The next blocked turn of that pane reads its session again, since a new agent may have started in the pane; a working pane needs no read.
  await host.send({ type: 'status', paneId: 'w1:p2', workspaceId: 'w1', status: 'working', agent: 'codex', cwd: '/work' });
  expect(calls('herdr_tree')).toHaveLength(1);
  await host.blocked();
  await waitFor(() => expect(calls('herdr_tree')).toHaveLength(2));
  await act(async () => {});
  expect(calls('notify_agent_attention')).toHaveLength(1);
});

it('keeps the hook\'s own row and alert when the hook reported the turn before the stream did, and still lists a finished agent', async () => {
  const host = herdrHost('codex-d');
  host.reports.push(host.hook({ state: 'working' }));
  updateInbox({ monitoring: true, notifications: true });
  render(<NotificationMonitor sessions={sessions} />);
  await waitFor(() => expect(host.channels).toHaveLength(1));
  await waitFor(() => expect(getInbox().rows).toHaveLength(1));
  host.reports[0] = host.hook({ state: 'needs_attention', eventCount: 2 });
  fireEvent(window, new Event('lazysh-inbox-refresh'));
  await waitFor(() => expect(calls('notify_agent_attention')).toHaveLength(1));
  await host.blocked();
  await act(async () => {});
  expect(getInbox().rows).toHaveLength(1);
  expect(getInbox().rows[0]).toMatchObject({ paneId: 'herdr:main:w1:p2', state: 'needs_attention' });
  expect(calls('notify_agent_attention')).toHaveLength(1);
  await host.send({ type: 'status', paneId: 'w1:p2', workspaceId: 'w1', status: 'done', agent: 'codex', cwd: '/work' });
  await waitFor(() => expect(getInbox().rows.map(row => row.state)).toEqual(['done']));
  expect(getInbox().rows[0].agentSessionId).toBe('codex-d');
  expect(calls('notify_agent_attention')).toHaveLength(1);
});

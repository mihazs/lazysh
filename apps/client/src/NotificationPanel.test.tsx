// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import NotificationPanel, { NotificationMonitor } from './NotificationPanel';
import PreferencesPanel from './PreferencesPanel';
import { getInbox, updateInbox } from './notificationStore';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: () => true }));
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

it('polls at most four hosts concurrently and discards late results after unmount', async () => {
  const pending: ((value: unknown) => void)[] = [];
  vi.mocked(invoke).mockImplementation(() => new Promise(resolve => pending.push(resolve)));
  updateInbox({ monitoring: true });
  const many = Array.from({ length: 12 }, (_, index) => ({ ...sessions[0], id: `ssh${index}`, hostId: `host${index}` }));
  const mounted = render(<NotificationMonitor sessions={many} />);
  expect(invoke).toHaveBeenCalledTimes(4);
  await act(async () => { pending[0]({ schemaVersion: 1, sessions: [] }); });
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(5));
  mounted.unmount();
  const before = getInbox().rows;
  await act(async () => { pending.slice(1).forEach(resolve => resolve({ schemaVersion: 1, sessions: [event] })); });
  expect(getInbox().rows).toBe(before);
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
  fireEvent.click(screen.getByRole('button', { name: 'Android notifications' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open Android notification settings' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('open_notification_settings', undefined, expect.anything()));
});

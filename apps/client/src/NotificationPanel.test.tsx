// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { isPermissionGranted, requestPermission } from '@tauri-apps/plugin-notification';
import NotificationPanel, { NotificationMonitor } from './NotificationPanel';
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
  await screen.findByText('Needs you · Claude');
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

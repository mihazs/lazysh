// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { collectInbox, focusInboxPane, getInbox, openInboxEvent, parseInbox, updateInbox } from './notificationStore';

vi.stubGlobal('crypto', webcrypto);
const session = { id: 'ssh1', hostId: 'host1', name: 'Dev host', connected: true };
const row = { sessionId: 'agent1', agent: 'Claude', project: '/work', state: 'needs_attention', updatedAt: '2026-10-24T22:00:00Z', summary: 'secret prompt must not be stored', paneId: '%1', eventCount: 1 };
const snapshot = (events = [row]) => ({ schemaVersion: 1, sessions: events });
beforeEach(() => { localStorage.clear(); updateInbox({ version: 1, monitoring: false, notifications: false, rows: [], latest: {}, error: '' }); });

it('creates a baseline without alerts and never retains prompt summaries', async () => {
  expect(await collectInbox(session, snapshot(), true)).toEqual([]);
  expect(getInbox().rows).toHaveLength(1);
  expect(JSON.stringify(getInbox())).not.toContain('secret prompt');
  expect(getInbox().monitoring).toBe(false);
  expect(getInbox().notifications).toBe(false);
});

it('deduplicates reconnects, archives and repeated snapshots while alerting once for a new attention event', async () => {
  await collectInbox(session, snapshot(), true);
  expect(await collectInbox({ ...session, id: 'ssh2' }, snapshot(), false)).toEqual([]);
  expect(getInbox().rows[0].sessionId).toBe('ssh2');
  updateInbox({ rows: [] });
  expect(await collectInbox(session, snapshot(), false)).toEqual([]);
  expect(getInbox().rows).toEqual([]);
  const changed = snapshot([{ ...row, eventCount: 2, updatedAt: '2026-10-24T22:01:00Z' }]);
  expect(await collectInbox(session, changed, false)).toHaveLength(1);
  expect(await collectInbox(session, changed, false)).toEqual([]);
});

it('routes only a known event to its exact connected SSH session', async () => {
  await collectInbox(session, snapshot(), true);
  const navigate = vi.fn();
  window.addEventListener('lazysh-inbox-open', navigate);
  const eventId = getInbox().rows[0].eventId;
  expect(openInboxEvent(eventId, [{ ...session, id: 'new-connection' }])).toBe(false);
  expect(openInboxEvent(eventId, [{ ...session, connected: false }])).toBe(false);
  expect(openInboxEvent('unknown', [session])).toBe(false);
  expect(openInboxEvent(eventId, [session], 'stale-session')).toBe(false);
  expect(openInboxEvent(eventId, [session])).toBe(true);
  expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'ssh1', paneId: '%1', waiting: false });
  // Only a needs-you event of Claude Code or Codex in a known pane leads to the Agent view's pending card.
  await collectInbox(session, snapshot([{ ...row, agent: 'Claude Code' }]), true);
  const followable = getInbox().rows.find(item => item.agent === 'Claude Code')!;
  expect(openInboxEvent(followable.eventId, [session])).toBe(true);
  expect((navigate.mock.calls[1][0] as CustomEvent).detail).toEqual({ sessionId: 'ssh1', paneId: '%1', waiting: true });
  await collectInbox(session, snapshot([{ ...row, agent: 'Claude Code', paneId: '', eventCount: 2, updatedAt: '2026-10-24T22:05:00Z' }]), true);
  expect(openInboxEvent(getInbox().rows.find(item => item.agent === 'Claude Code')!.eventId, [session])).toBe(true);
  expect((navigate.mock.calls[2][0] as CustomEvent).detail).toEqual({ sessionId: 'ssh1', paneId: null, waiting: false });
  window.removeEventListener('lazysh-inbox-open', navigate);
});

it('bounds stored rows and declines malformed or cancelled snapshots', async () => {
  for (let host = 0; host < 3; host++) await collectInbox({ ...session, hostId: `host${host}` }, snapshot(Array.from({ length: 50 }, (_, index) => ({ ...row, sessionId: `agent${index}` }))), true);
  expect(getInbox().rows).toHaveLength(100);
  expect(parseInbox({ version: 1, rows: Array(101).fill({}), latest: {} }).rows).toEqual([]);
  const prior = getInbox();
  expect(await collectInbox(session, snapshot([{ ...row, eventCount: 20 }]), false, () => false)).toEqual([]);
  expect(getInbox()).toBe(prior);
  await expect(collectInbox(session, { schemaVersion: 2, sessions: [] }, false)).rejects.toThrow();
});

it('does not rewrite persistent storage for unchanged snapshots', async () => {
  await collectInbox(session, snapshot(), true);
  const writes = vi.spyOn(Storage.prototype, 'setItem');
  expect(await collectInbox(session, snapshot(), false)).toEqual([]);
  expect(writes).not.toHaveBeenCalled();
  writes.mockRestore();
});

it('focuses the Zellij pane that raised an event only in the Zellij session its terminal is attached to', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const zellij = { id: 'ssh1', attached: { kind: 'zellij', name: 'my:odd name' } };
  await focusInboxPane(invoke, zellij, 'zellij:my:odd name:12');
  expect(invoke).toHaveBeenCalledExactlyOnceWith('zellij_action', { sessionId: 'ssh1', name: 'my:odd name', action: { type: 'focusPane', pane: 12 } });
  invoke.mockClear();
  // Another Zellij session, a terminal in another multiplexer, a tmux or malformed pane id and no pane select nothing.
  for (const [session, pane] of [[zellij, 'zellij:other:12'], [zellij, '%12'], [zellij, 'zellij:my:odd name:terminal_1'], [zellij, null], [{ ...zellij, attached: { kind: 'tmux', name: 'my:odd name' } }, 'zellij:my:odd name:12'], [{ ...zellij, attached: { kind: 'herdr', name: 'my:odd name' } }, 'zellij:my:odd name:12'], [{ id: 'ssh1' }, 'zellij:my:odd name:12']] as const) await focusInboxPane(invoke, session, pane);
  expect(invoke).not.toHaveBeenCalled();
  // A pane that no longer exists must not stop the session from opening.
  invoke.mockRejectedValueOnce(new Error('no such pane'));
  await expect(focusInboxPane(invoke, zellij, 'zellij:my:odd name:12')).resolves.toBeUndefined();
});

it('selects the pane that raised an event only in the tmux terminal it is attached to', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const on = (kind: string) => ({ id: 'ssh1', attached: { kind, name: 'work' } });
  const tmux = on('tmux');
  await focusInboxPane(invoke, tmux, '%12');
  expect(invoke).toHaveBeenLastCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'selectPane', target: '%12' } });
  await focusInboxPane(invoke, { ...tmux, attached: { ...tmux.attached, tmuxServer: 'agents' } }, '%3');
  expect(invoke).toHaveBeenLastCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'selectPane', target: '%3' }, tmuxServer: 'agents' });
  invoke.mockClear();
  // No pane, a pane id that is not tmux's (Zellij/Herdr), a hostile id and a terminal that is not in tmux select nothing.
  for (const [session, pane] of [[tmux, null], [tmux, ''], [tmux, 'zellij:main:4'], [tmux, '%1;kill-server'], [tmux, '%'], [on('herdr'), '%1'], [{ id: 'ssh1' }, '%1']] as const) await focusInboxPane(invoke, session, pane);
  expect(invoke).not.toHaveBeenCalled();
  // A pane that no longer exists must not stop the session from opening.
  invoke.mockRejectedValueOnce(new Error("can't find pane: %12"));
  await expect(focusInboxPane(invoke, tmux, '%12')).resolves.toBeUndefined();
});

it('focuses a tmux or rmux pane only on the server the event names, and refuses another attached server', async () => {
  const invoke = vi.fn().mockResolvedValue(undefined);
  const on = (kind: string, tmuxServer?: string) => ({ id: 'ssh1', attached: { kind, name: 'work', ...(tmuxServer === undefined ? {} : { tmuxServer }) } });
  await focusInboxPane(invoke, on('tmux', 'agents'), '%3', 'tmux:agents');
  expect(invoke).toHaveBeenLastCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'selectPane', target: '%3' }, tmuxServer: 'agents' });
  await focusInboxPane(invoke, on('tmux'), '%3', 'tmux:default');
  expect(invoke).toHaveBeenLastCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'selectPane', target: '%3' } });
  await focusInboxPane(invoke, on('rmux', 'agents'), '%3', 'rmux:agents');
  expect(invoke).toHaveBeenLastCalledWith('tmux_action', { sessionId: 'ssh1', action: { type: 'selectPane', target: '%3' }, tmuxServer: 'agents', kind: 'rmux' });
  invoke.mockClear();
  // Another server's %3, the same label under the other multiplexer and a default-server pane on a named server select nothing.
  for (const [session, server] of [[on('tmux', 'agents'), 'tmux:work'], [on('tmux'), 'tmux:work'], [on('tmux', 'agents'), 'rmux:agents'], [on('rmux'), 'tmux:default']] as const) await focusInboxPane(invoke, session, '%3', server);
  expect(invoke).not.toHaveBeenCalled();
});

it('focuses a Herdr pane only on the attached server and only while the pane exists', async () => {
  const tree = { panes: [{ pane_id: 'w3V:p1' }] };
  const invoke = vi.fn(async (command: string) => command === 'herdr_tree' ? tree : undefined);
  const herdr = { id: 'ssh1', attached: { kind: 'herdr', name: 'work' } };
  await focusInboxPane(invoke, herdr, 'herdr:work:w3V:p1');
  expect(invoke).toHaveBeenLastCalledWith('herdr_action', { sessionId: 'ssh1', name: 'work', action: { type: 'focusPane', target: 'w3V:p1' } });
  invoke.mockClear();
  await focusInboxPane(invoke, herdr, 'herdr:work:w3V:p2');
  expect(invoke).not.toHaveBeenCalledWith('herdr_action', expect.anything());
  invoke.mockClear();
  for (const [session, pane] of [[herdr, 'herdr:default:w3V:p1'], [{ ...herdr, attached: { kind: 'tmux', name: 'work' } }, 'herdr:work:w3V:p1'], [{ id: 'ssh1' }, 'herdr:work:w3V:p1']] as const) await focusInboxPane(invoke, session, pane);
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockRejectedValueOnce(new Error('herdr stopped'));
  await expect(focusInboxPane(invoke, herdr, 'herdr:work:w3V:p1')).resolves.toBeUndefined();
});

it('carries the server a report names from the inbox row to the tap', async () => {
  await collectInbox(session, snapshot([{ ...row, paneServer: 'tmux:agents' } as typeof row]), true);
  expect(parseInbox(JSON.parse(JSON.stringify(getInbox()))).rows[0].paneServer).toBe('tmux:agents');
  const navigate = vi.fn();
  window.addEventListener('lazysh-inbox-open', navigate);
  expect(openInboxEvent(getInbox().rows[0].eventId, [session])).toBe(true);
  expect((navigate.mock.calls[0][0] as CustomEvent).detail).toMatchObject({ paneId: '%1', paneServer: 'tmux:agents' });
  window.removeEventListener('lazysh-inbox-open', navigate);
});

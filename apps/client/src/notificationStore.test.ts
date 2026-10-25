// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { collectInbox, getInbox, openInboxEvent, parseInbox, updateInbox } from './notificationStore';

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
  expect((navigate.mock.calls[0][0] as CustomEvent).detail).toEqual({ sessionId: 'ssh1' });
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

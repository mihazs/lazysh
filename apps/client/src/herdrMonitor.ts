import type {AccessLease} from './access';
import {subscribeHerdrEvents} from './herdrEvents';
import type {InboxSession} from './notificationStore';
import {servers} from './useHerdrNavigation';
import type {WatchInvoke} from './watchChannel';

/** The one Herdr server the inbox follows on a host: the attached terminal's when it runs, else the only running one.
 * Like the Herdr views, it never substitutes another server for an attached one that is not running. */
export function monitoredHerdrServer(names: string[], attached?: string): string {
  return attached ? (names.includes(attached) ? attached : '') : names.length === 1 ? names[0] : '';
}

/** The event streams the inbox monitor keeps open, at most one per connection. Each is the hub's shared stream of that
 * connection and server, so a Herdr view of the same server and the monitor read one channel and it closes with the last of them. */
export function herdrMonitorStreams(lease: AccessLease, invoke: WatchInvoke) {
  const open = new Map<string, {server: string; stop: () => void}>();
  const none = () => {};
  const follow = (sessionId: string, server: string) => {
    if (open.get(sessionId)?.server === server) return;
    open.get(sessionId)?.stop(); open.delete(sessionId);
    if (server) open.set(sessionId, {server, stop: subscribeHerdrEvents({sessionId, server, lease, invoke}, none, none)});
  };
  return {
    follow,
    /** Closes the streams of every connection that is not in `sessionIds`. */
    keep(sessionIds: ReadonlySet<string>) { for (const id of [...open.keys()]) if (!sessionIds.has(id)) follow(id, ''); },
    close() { for (const id of [...open.keys()]) follow(id, ''); },
  };
}

/** Follows the Herdr server a connected host runs, or stops following one that no longer runs. A failed listing says nothing
 * about a stream that is open, so it changes nothing; the stream's own reopening covers a host that went away. */
export async function followHerdrServer(streams: ReturnType<typeof herdrMonitorStreams>, invoke: WatchInvoke, session: InboxSession, valid: () => boolean) {
  try {
    const names = servers(await invoke('multiplexer_sessions', {sessionId: session.id, kind: 'herdr'}));
    if (valid()) streams.follow(session.id, monitoredHerdrServer(names, session.attached?.kind === 'herdr' ? session.attached.name : undefined));
  } catch { /* A host without Herdr, or one that cannot be read now, is asked again with the next poll. */ }
}

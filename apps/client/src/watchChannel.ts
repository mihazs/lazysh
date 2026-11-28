import {Channel} from '@tauri-apps/api/core';
import {guardAccessCallback, type AccessLease} from './access';
import {companionUpdatedEvent} from './companionUpdate';
import type {WatchEvent} from './transcriptWatch';

/** What the host companion's watch channel streams: a conversation, or one Herdr server's agent-status changes. */
export type WatchTarget =
  | {kind: 'path'; agent: string; path: string; inlineImages?: boolean; allowLargeHistory?: boolean}
  | {kind: 'reference'; agent: string; reference: string; inlineImages?: boolean; allowLargeHistory?: boolean}
  | {kind: 'herdr'; agent: string; agentSessionId: string; herdrSession: string; paneId: string; terminalId: string; allowLargeHistory?: boolean}
  | {kind: 'herdrEvents'; herdrSession: string};
/** `off` and `connecting` show nothing; `live` is the quiet normal state; `delayed` polls because no stream
 * has opened; `stale` lost a stream that was live; `unsupported` needs a newer host companion. */
export type WatchState = 'off' | 'connecting' | 'live' | 'delayed' | 'stale' | 'unsupported';
export type WatchInvoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** What a frame means for the stream: `live` proves it works, `lose` reopens it, nothing ignores the frame.
 * A thrown error reopens it too. */
export type FrameHandler = (frame: unknown) => 'live' | 'lose' | void;

const RETRY = [1000, 2000, 5000, 10000, 30000];
/** A host that cannot stream is asked again rarely: the companion may have been updated meanwhile. */
const UNSUPPORTED_RETRY = 60000;

/** Opens one watch channel and keeps it open: every failure reports `delayed`, `stale` or `unsupported` and
 * reopens it with a growing delay, so the caller's polling stays in charge until frames flow again.
 * `connection` is called for each opened channel and returns that channel's frame handler. Returns the closer. */
export function openWatch({sessionId, target, lease, invoke, connection, onState}: {
  sessionId: string; target: WatchTarget; lease: AccessLease; invoke: WatchInvoke;
  connection: () => FrameHandler; onState: (state: WatchState) => void;
}): () => void {
  let cancelled = false, token: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, failures = 0, wasLive = false, unsupported = false;
  let events: Channel<WatchEvent> | undefined, state: WatchState = 'off';
  const set = (next: WatchState) => { state = next; onState(next); };
  const stop = () => {
    const id = token; token = undefined;
    if (events) events.onmessage = () => {};
    events = undefined;
    if (id) void invoke('agent_watch_stop', {sessionId, watchId: id}).catch(() => {});
  };
  const lose = (next: Exclude<WatchState, 'off' | 'connecting' | 'live'>) => {
    stop();
    unsupported = next === 'unsupported';
    set(wasLive && next === 'delayed' ? 'stale' : next);
    if (!cancelled) timer = setTimeout(connect, next === 'unsupported' ? UNSUPPORTED_RETRY : RETRY[Math.min(failures++, RETRY.length - 1)]);
  };
  function connect() {
    if (cancelled || !lease.current()) return;
    const handle = connection();
    set(state === 'stale' ? 'stale' : 'connecting');
    let channel: Channel<WatchEvent>;
    // Without the native bridge (the web build) there is no channel: poll.
    try { channel = new Channel<WatchEvent>(); } catch { return lose('delayed'); }
    events = channel;
    channel.onmessage = guardAccessCallback((event: WatchEvent) => {
      if (cancelled || events !== channel) return;
      try {
        if (event.type === 'unavailable') return lose('unsupported');
        if (event.type === 'closed') return lose('delayed');
        const verdict = handle(event.frame);
        if (verdict === 'lose') return lose('delayed');
        if (verdict !== 'live') return;
        failures = 0; wasLive = true;
        set('live');
      } catch { lose('delayed'); }
    });
    invoke<string>('agent_watch_start', {sessionId, target, events: channel}).then(id => {
      if (cancelled || events !== channel) void invoke('agent_watch_stop', {sessionId, watchId: id}).catch(() => {});
      else token = id;
    }, () => { if (!cancelled && events === channel) lose('delayed'); });
  }
  // A host that could not stream is asked again at once when its companion has just been updated.
  const updated = (event: Event) => {
    if (!unsupported || cancelled || (event as CustomEvent<{sessionId?: string}>).detail?.sessionId !== sessionId) return;
    clearTimeout(timer); unsupported = false; failures = 0; connect();
  };
  // The host-tools command connection came back for this session: reopen at once instead of waiting out the backoff.
  const recovered = (event: Event) => {
    if ((event as CustomEvent<unknown>).detail !== sessionId || cancelled || !lease.current() || document.hidden) return;
    clearTimeout(timer); stop(); failures = 0; connect();
  };
  window.addEventListener(companionUpdatedEvent, updated);
  window.addEventListener('lazysh-host-tools-restored', recovered);
  connect();
  return () => { cancelled = true; clearTimeout(timer); window.removeEventListener(companionUpdatedEvent, updated); window.removeEventListener('lazysh-host-tools-restored', recovered); stop(); };
}

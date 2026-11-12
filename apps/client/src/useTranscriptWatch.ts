import {useEffect, useRef, useState} from 'react';
import {Channel} from '@tauri-apps/api/core';
import {guardAccessCallback, type AccessLease} from './access';
import {createWatchApplier, parseWatchFrame, type PageParser, type WatchEvent, type WatchOp} from './transcriptWatch';

export type WatchTarget =
  | {kind: 'path'; agent: string; path: string; inlineImages?: boolean}
  | {kind: 'herdr'; agent: string; agentSessionId: string; herdrSession: string; paneId: string; terminalId: string};
/** `off` and `connecting` show nothing; `live` is the quiet normal state; `delayed` polls because no stream has
 * opened; `stale` lost a stream that was live; `unsupported` needs a newer host companion. */
export type WatchState = 'off' | 'connecting' | 'live' | 'delayed' | 'stale' | 'unsupported';
type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

const RETRY = [1000, 2000, 5000, 10000, 30000];
/** A host that cannot stream is asked again rarely: the companion may have been updated meanwhile. */
const UNSUPPORTED_RETRY = 60000;

/** One watch channel while `enabled`: each frame becomes an operation for the caller to apply in place, and every
 * failure leaves the caller's polling in charge until the channel reopens. The channel closes when `enabled` turns
 * false or the view unmounts. */
export function useTranscriptWatch<M extends {id: string}>({enabled, sessionId, target, lease, invoke, parsePage, onOp}: {
  enabled: boolean; sessionId: string; target: WatchTarget; lease: AccessLease; invoke: Invoke; parsePage: PageParser<M>; onOp: (op: WatchOp<M>) => void;
}) {
  const [state, setState] = useState<WatchState>('off');
  const latest = useRef({parsePage, onOp}); latest.current = {parsePage, onOp};
  const key = JSON.stringify([sessionId, target]);
  useEffect(() => {
    if (!enabled) { setState('off'); return; }
    let cancelled = false, token: string | undefined, timer: ReturnType<typeof setTimeout> | undefined, failures = 0, wasLive = false;
    let events: Channel<WatchEvent> | undefined;
    const stop = () => {
      const id = token; token = undefined;
      if (events) events.onmessage = () => {};
      events = undefined;
      if (id) void invoke('agent_watch_stop', {sessionId, watchId: id}).catch(() => {});
    };
    const lose = (next: Exclude<WatchState, 'off' | 'connecting' | 'live'>) => {
      stop();
      setState(wasLive && next === 'delayed' ? 'stale' : next);
      if (!cancelled) timer = setTimeout(connect, next === 'unsupported' ? UNSUPPORTED_RETRY : RETRY[Math.min(failures++, RETRY.length - 1)]);
    };
    function connect() {
      if (cancelled || !lease.current()) return;
      const applier = createWatchApplier<M>();
      setState(previous => previous === 'stale' ? 'stale' : 'connecting');
      let channel: Channel<WatchEvent>;
      // Without the native bridge (the web build) there is no channel: poll.
      try { channel = new Channel<WatchEvent>(); } catch { return lose('delayed'); }
      events = channel;
      channel.onmessage = guardAccessCallback((event: WatchEvent) => {
        if (cancelled || events !== channel) return;
        try {
          if (event.type === 'unavailable') return lose('unsupported');
          if (event.type === 'closed') return lose('delayed');
          const frame = parseWatchFrame<M>(event.frame, target.agent, latest.current.parsePage);
          if (frame.type === 'end') return lose('delayed');
          const op = applier(frame);
          if (op === 'resync') return lose('delayed');
          if (!op) return;
          failures = 0; wasLive = true;
          latest.current.onOp(op);
          setState('live');
        } catch { lose('delayed'); }
      });
      invoke<string>('agent_watch_start', {sessionId, target, events: channel}).then(id => {
        if (cancelled || events !== channel) void invoke('agent_watch_stop', {sessionId, watchId: id}).catch(() => {});
        else token = id;
      }, () => { if (!cancelled && events === channel) lose('delayed'); });
    }
    connect();
    return () => { cancelled = true; clearTimeout(timer); stop(); };
    // `key` stands for sessionId and target.
  }, [enabled, key, lease, invoke]);
  return {state, live: state === 'live'};
}

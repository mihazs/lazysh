import {useEffect, useRef, useState} from 'react';
import type {AccessLease} from './access';
import {createWatchApplier, parseWatchFrame, type PageParser, type WatchOp} from './transcriptWatch';
import {openWatch, type WatchInvoke, type WatchState, type WatchTarget as AnyWatchTarget} from './watchChannel';

export type WatchTarget = Exclude<AnyWatchTarget, {kind: 'herdrEvents'}>;
export type {WatchState};

/** One watch channel while `enabled`: each frame becomes an operation for the caller to apply in place, and every
 * failure leaves the caller's polling in charge until the channel reopens. The channel closes when `enabled` turns
 * false or the view unmounts. */
export function useTranscriptWatch<M extends {id: string}>({enabled, sessionId, target, lease, invoke, parsePage, onOp}: {
  enabled: boolean; sessionId: string; target: WatchTarget; lease: AccessLease; invoke: WatchInvoke; parsePage: PageParser<M>; onOp: (op: WatchOp<M>) => void;
}) {
  const [state, setState] = useState<WatchState>('off');
  const latest = useRef({parsePage, onOp}); latest.current = {parsePage, onOp};
  const key = JSON.stringify([sessionId, target]);
  useEffect(() => {
    if (!enabled) { setState('off'); return; }
    return openWatch({sessionId, target, lease, invoke, onState: setState, connection: () => {
      const applier = createWatchApplier<M>();
      return frame => {
        const parsed = parseWatchFrame<M>(frame, target.agent, latest.current.parsePage);
        if (parsed.type === 'end') return 'lose';
        const op = applier(parsed);
        if (op === 'resync') return 'lose';
        if (!op) return;
        latest.current.onOp(op);
        return 'live';
      };
    }});
    // `key` stands for sessionId and target.
  }, [enabled, key, lease, invoke]);
  return {state, live: state === 'live'};
}

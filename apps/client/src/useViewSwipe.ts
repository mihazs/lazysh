import {useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject} from 'react';
import {edgeSettleMs, useEdgeGestures, useSwipeToClose} from './edgeGestures';
import './ViewSwipe.css';

/** The two pages a swipe moves between. Both stay mounted (#1151), so a swipe never reconnects. */
export type SwipePage = 'terminal' | 'agent';
/** Where the strip sits while a swipe leaves `from`: 0 is the terminal and 1 is the Agent view; the finger has moved `travelled` of the page width. */
const stripPosition = (from: SwipePage, travelled: number) => from === 'terminal' ? Math.min(1, Math.max(0, travelled)) : 1 - Math.min(1, Math.max(0, travelled));

/** A swipe from the right edge to the left leaves the terminal for the Agent view; a swipe to the right from anywhere
 * but the left edge zone returns from the Agent view. The session body holds both pages: this drives them as a strip
 * that follows the finger (--view-pos on the body) and, once the finger lifts, settles on the page the swipe chose.
 * Returns the page being swiped away from, or null, so the caller keeps both pages shown meanwhile.
 * The engine's guard already refuses typing, text editing and touches that begin in horizontally scrollable content. */
export function useViewSwipe({enabled, scope, page, body, onSwitch}: {enabled: boolean; scope: string; page: SwipePage; body: RefObject<HTMLElement | null>; onSwitch: (page: SwipePage) => void}) {
  const [from, setFrom] = useState<SwipePage | null>(null);
  const settling = useRef<{timer: number; switchTo?: SwipePage}>(undefined);
  const latest = useRef(onSwitch);latest.current = onSwitch;
  const live = useRef(false);
  const finish = useCallback((apply = true) => {
    const pending = settling.current;settling.current = undefined;live.current = false;
    if (pending) {clearTimeout(pending.timer);if (apply && pending.switchTo) latest.current(pending.switchTo);}
    setFrom(null);
  }, []);
  const place = (position: number, mode: 'drag' | 'settle') => {
    body.current?.style.setProperty('--view-pos', String(position));
    body.current?.style.setProperty('--view-settle', `${edgeSettleMs()}ms`);
    body.current?.setAttribute('data-view-swipe', mode);
  };
  // The first progress report starts the strip: the return swipe has no separate start callback.
  const move = (dx: number) => {
    if (!live.current) {finish();live.current = true;setFrom(page);}
    place(stripPosition(page, Math.abs(dx) / (body.current?.clientWidth || 1)), 'drag');
  };
  const release = (commit: boolean) => {
    if (!live.current) return;
    const other: SwipePage = page === 'terminal' ? 'agent' : 'terminal', to = commit ? other : page;
    place(to === 'agent' ? 1 : 0, 'settle');
    settling.current = {timer: window.setTimeout(() => finish(), edgeSettleMs()), switchTo: commit ? other : undefined};
  };
  // The strip goes back to ordinary layout in the same commit that shows the chosen page, so no frame shows both side by side.
  useLayoutEffect(() => {if (!from) body.current?.removeAttribute('data-view-swipe');}, [from, body]);
  // Closing a dialog or leaving the view while a swipe is mid-air puts the pages back at once.
  useEffect(() => {if (!enabled) finish();}, [enabled, finish]);
  // A swipe that began in another session must not switch this one.
  useEffect(() => () => finish(false), [scope, finish]);
  useEdgeGestures({enabled: enabled && page === 'terminal', edges: ['right'], target: body, handlers: {
    onProgress: (_edge, _progress, dx) => move(dx), onCommit: () => release(true), onCancel: () => release(false),
  }});
  useSwipeToClose({enabled: enabled && page === 'agent', direction: 'right', target: body,
    onProgress: (_progress, dx) => move(dx), onCommit: () => release(true), onCancel: () => release(false)});
  return from;
}

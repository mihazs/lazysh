import {invoke, isTauri} from '@tauri-apps/api/core';
import {useEffect, useRef, type RefObject} from 'react';
import {edgeGestureSettings, usePreferences, type EdgeGestureId} from './preferences';
import {TOUCH_SELECTION_DELAY} from './terminalTouchSelection';
import {clock, isTextInteractionActive, markTouchOwned} from './textInteraction';

export {isTextInteractionActive, reportTextInteraction, registerTextInteraction, useTextInteraction, type TextInteractionKind} from './textInteraction';
export type {EdgeGestureId};

export type Edge = 'left' | 'right' | 'bottom';
export type CloseDirection = 'left' | 'right' | 'down';
export const edgeGestureEdges: Record<EdgeGestureId, Edge> = {leftMenu: 'left', viewSwitch: 'right', bottomMenu: 'bottom'};
const gestureOfEdge: Record<Edge, EdgeGestureId> = {left: 'leftMenu', right: 'viewSwitch', bottom: 'bottomMenu'};

export type TouchStart = {target: EventTarget | null; x: number; y: number; edge?: Edge};
export type EdgeHandlers = {
  /** The swipe locked onto its edge; nothing else receives this touch from now on. */
  onStart?(edge: Edge): void;
  /** `progress` runs 0 to 1 along the swipe axis; dx and dy are pixels since the touch began. */
  onProgress(edge: Edge, progress: number, dx: number, dy: number): void;
  onCommit(edge: Edge): void;
  /** Released short or reversed, a second finger landed, or the guard tripped. */
  onCancel(edge: Edge): void;
};

/** Recogniser thresholds in CSS pixels and milliseconds. */
export const recognizer = {
  /** Movement that decides whether the touch is a swipe. */
  slop: 10,
  /** The swipe axis must dominate the cross axis by this factor to lock. */
  lock: 1.5,
  /** Progress at release that commits without a fling. */
  commit: .35,
  /** A release this fast (px/ms) toward the open direction commits once it travelled `flingDistance`; this fast backwards cancels. */
  flingVelocity: .5, flingDistance: 32, velocityWindow: 100,
  /** A finger that rests this long before moving is a long press, never a swipe. */
  hold: TOUCH_SELECTION_DELAY,
} as const;

/** `sign` is the direction of travel along `axis` that advances the swipe; progress is that travel over `travel`. */
export type Swipe = {axis: 'x' | 'y'; sign: 1 | -1; travel: number};

/** Pure swipe recogniser: feed it the touch samples, read the decision. */
export function createSwipe({axis, sign, travel}: Swipe, x0: number, y0: number, t0: number) {
  let state: 'pending' | 'rejected' | 'locked' = 'pending';
  let samples: {along: number; t: number}[] = [];
  const along = (x: number, y: number) => sign * (axis === 'x' ? x - x0 : y - y0);
  const progress = (value: number) => Math.min(1, Math.max(0, value / travel));
  return {
    get state() { return state; },
    /** Progress 0..1 once locked; the state says whether the touch is still undecided or can never be this swipe. */
    move(x: number, y: number, t: number) {
      if (state === 'rejected') return {state, progress: 0};
      const main = along(x, y), cross = axis === 'x' ? y - y0 : x - x0;
      if (state === 'pending') {
        if (Math.abs(main) < recognizer.slop && Math.abs(cross) < recognizer.slop) return {state, progress: 0};
        // The first real movement decides: a rested finger, the wrong direction or a dominant cross axis is another gesture.
        if (t - t0 > recognizer.hold || main < recognizer.slop || main < recognizer.lock * Math.abs(cross)) return {state: state = 'rejected', progress: 0};
        state = 'locked';
      }
      samples = [...samples.filter(sample => t - sample.t <= recognizer.velocityWindow), {along: main, t}];
      return {state, progress: progress(main)};
    },
    /** 'commit' or 'cancel' for a locked swipe released at (x, y). */
    end(x: number, y: number, t: number): 'commit' | 'cancel' {
      if (state !== 'locked') return 'cancel';
      const main = along(x, y), first = samples[0], span = first ? t - first.t : 0;
      const velocity = first && span > 0 ? (main - first.along) / span : 0;
      if (velocity <= -recognizer.flingVelocity) return 'cancel';
      return progress(main) >= recognizer.commit || (velocity >= recognizer.flingVelocity && main >= recognizer.flingDistance) ? 'commit' : 'cancel';
    },
  };
}

const prefersReducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** Duration for the caller's own settle animation; 0 under prefers-reduced-motion. */
export function edgeSettleMs(): number { return prefersReducedMotion() ? 0 : 220; }

/** A touch that starts in one of these belongs to the control, not to a swipe. */
const consumers = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [data-edge-gestures-ignore]';
const scrolls = (node: HTMLElement, axis: 'x' | 'y') => axis === 'x'
  ? node.scrollWidth > node.clientWidth + 1 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowX)
  : node.scrollTop > 0 && node.scrollHeight > node.clientHeight + 1 && /^(auto|scroll)$/.test(getComputedStyle(node).overflowY);
/** Text fields, sliders, opted-out subtrees and scrollers that can scroll against the swipe consume it. */
export function consumesSwipe(start: EventTarget | null, boundary: Element, swipe: Pick<Swipe, 'axis' | 'sign'>): boolean {
  for (let node = start instanceof Element ? start : null; node; node = node.parentElement) {
    if (node.matches(consumers)) return true;
    // A bottom sheet closes by a downward swipe unless its content can still scroll up.
    if (node instanceof HTMLElement && (swipe.axis === 'x' ? scrolls(node, 'x') : swipe.sign === 1 && scrolls(node, 'y'))) return true;
    if (node === boundary) return false;
  }
  return false;
}

type Candidate = {edge?: Edge; swipe: Swipe; onStart?: () => void; onProgress: (progress: number, dx: number, dy: number) => void; onCommit: () => void; onCancel: () => void};
type Hook = {
  /** Swipes a touch at (x, y) could begin; none when the touch is not this hook's. */
  candidates(x: number, y: number, target: EventTarget | null, rect: DOMRect): Candidate[];
  shouldStart?: (touch: TouchStart) => boolean;
};

/** At most one recogniser owns a touch. */
let owner: object | null = null;
/** Enabled edge zones, so a closing swipe never starts where an edge swipe owns the touch. */
const claimedZones = new Set<(x: number, y: number, travel: Swipe) => boolean>();

/** Attaches the capture-phase recogniser; returns the detach. It only claims a touch once it locks onto its swipe. */
function attach(element: HTMLElement, hook: Hook): () => void {
  const self = {};
  type Entry = {candidate: Candidate; swipe: ReturnType<typeof createSwipe>};
  type Tracking = {id: number; pointer?: number; target: Element | null; x: number; y: number; pending: Entry[]; locked?: Entry};
  let touch: Tracking | null = null, lastPointer: number | undefined, synthetic = false;
  const release = () => {if (owner === self) owner = null; touch = null;};
  const cancel = () => {const locked = touch?.locked; release(); locked?.candidate.onCancel();};
  const pointer = (event: PointerEvent) => {if (event.pointerType === 'touch') lastPointer = event.pointerId;};
  const start = (event: TouchEvent) => {
    if (synthetic) return;
    if (touch) cancel();
    // A second finger is a pinch or a two-finger gesture, never an edge swipe; another recogniser may already own this touch.
    if (event.touches.length !== 1 || (owner && owner !== self)) return;
    const point = event.touches[0], rect = element.getBoundingClientRect();
    const candidates = hook.candidates(point.clientX, point.clientY, event.target, rect);
    // The guard comes first: typing, a selection, a scroll or a pinch means this touch is never a gesture.
    if (!candidates.length || isTextInteractionActive()) return;
    const kept = candidates.filter(candidate => !consumesSwipe(event.target, element, candidate.swipe)
      && (hook.shouldStart?.({target: event.target, x: point.clientX, y: point.clientY, edge: candidate.edge}) ?? true));
    if (!kept.length) return;
    const now = clock();
    touch = {id: point.identifier, pointer: lastPointer, target: event.target instanceof Element ? event.target : null, x: point.clientX, y: point.clientY,
      pending: kept.map(candidate => ({candidate, swipe: createSwipe(candidate.swipe, point.clientX, point.clientY, now)}))};
  };
  /** The page, the terminal and any control under the finger drop a claimed touch, as when the browser takes a touch over to scroll. */
  const claim = (tracked: Tracking) => {
    owner = self; markTouchOwned();
    synthetic = true;
    try {
      if (tracked.pointer !== undefined && typeof PointerEvent === 'function') tracked.target?.dispatchEvent(new PointerEvent('pointercancel', {bubbles: true, pointerType: 'touch', isPrimary: true, pointerId: tracked.pointer}));
      tracked.target?.dispatchEvent(new Event('touchcancel', {bubbles: true}));
    } finally {synthetic = false;}
  };
  const move = (event: TouchEvent) => {
    if (!touch || synthetic) return;
    const point = [...event.touches].find(item => item.identifier === touch!.id);
    // A second finger, or typing that begins mid-swipe, ends the swipe; so does a touch the browser took over.
    if (!point || event.touches.length !== 1 || (touch.locked && (isTextInteractionActive() || !event.cancelable))) {cancel(); return;}
    const now = clock(), dx = point.clientX - touch.x, dy = point.clientY - touch.y;
    let progress = 0;
    if (!touch.locked) {
      for (const entry of touch.pending) {
        const step = entry.swipe.move(point.clientX, point.clientY, now);
        if (step.state === 'locked') {touch.locked = entry; progress = step.progress; break;}
      }
      touch.pending = touch.pending.filter(entry => entry.swipe.state !== 'rejected');
      if (!touch.locked) {if (!touch.pending.length) release(); return;}
      if (isTextInteractionActive() || !event.cancelable) {release(); return;}
      claim(touch);
      touch.locked.candidate.onStart?.();
    } else progress = touch.locked.swipe.move(point.clientX, point.clientY, now).progress;
    if (!prefersReducedMotion()) touch.locked.candidate.onProgress(progress, dx, dy);
    event.stopPropagation();
    event.preventDefault();
  };
  const end = (event: TouchEvent) => {
    const tracked = touch;
    if (!tracked || synthetic) return;
    const point = [...event.changedTouches].find(item => item.identifier === tracked.id);
    if (!tracked.locked) {release(); return;}
    // A claimed touch ends here: no click follows the release.
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
    const {candidate, swipe} = tracked.locked;
    // The guard is checked at release too: a swipe never completes while the user types or edits text.
    const verdict = !point || isTextInteractionActive() ? 'cancel' : swipe.end(point.clientX, point.clientY, clock());
    release();
    if (prefersReducedMotion() && point) candidate.onProgress(verdict === 'commit' ? 1 : 0, point.clientX - tracked.x, point.clientY - tracked.y);
    if (verdict === 'commit') candidate.onCommit(); else candidate.onCancel();
  };
  const interrupted = () => {if (!synthetic) cancel();};
  const moving = {capture: true, passive: false} as const;
  element.addEventListener('pointerdown', pointer, {capture: true, passive: true});
  element.addEventListener('touchstart', start, {capture: true, passive: true});
  element.addEventListener('touchmove', move, moving);
  element.addEventListener('touchend', end, moving);
  element.addEventListener('touchcancel', interrupted, {capture: true});
  window.addEventListener('blur', interrupted);
  document.addEventListener('visibilitychange', interrupted);
  return () => {
    element.removeEventListener('pointerdown', pointer, {capture: true});
    element.removeEventListener('touchstart', start, {capture: true});
    element.removeEventListener('touchmove', move, moving);
    element.removeEventListener('touchend', end, moving);
    element.removeEventListener('touchcancel', interrupted, {capture: true});
    window.removeEventListener('blur', interrupted);
    document.removeEventListener('visibilitychange', interrupted);
    cancel();
  };
}

/** The side zones every mounted engine wants; Android's Back gesture gives them up while claimed (a no-op elsewhere). */
const sideClaims = new Set<{left: boolean; right: boolean; zone: number}>();
function syncSystemExclusion() {
  if (!isTauri()) return;
  const claims = [...sideClaims];
  invoke('edge_gesture_exclusion', {left: claims.some(claim => claim.left), right: claims.some(claim => claim.right), zoneDp: Math.max(1, ...claims.map(claim => claim.zone))}).catch(() => {});
}
/** Claims the side bands of the window from the system gesture; returns the release. */
export function claimSystemEdges(claim: {left: boolean; right: boolean; zone: number}): () => void {
  sideClaims.add(claim);
  syncSystemExclusion();
  return () => {sideClaims.delete(claim); syncSystemExclusion();};
}

const defaultTravel = (edge: Edge, rect: DOMRect) => edge === 'bottom' ? Math.min(320, rect.height * .5) : Math.min(360, rect.width * .8);
const openSwipe: Record<Edge, Omit<Swipe, 'travel'>> = {left: {axis: 'x', sign: 1}, right: {axis: 'x', sign: -1}, bottom: {axis: 'y', sign: -1}};
const closeSwipe: Record<CloseDirection, Omit<Swipe, 'travel'>> = {left: {axis: 'x', sign: -1}, right: {axis: 'x', sign: 1}, down: {axis: 'y', sign: 1}};

/** Whether (x, y) lies in `edge`'s zone of `rect`, or `over` is a `data-edge-gestures-handle` element for it. */
function inZone(edge: Edge, x: number, y: number, rect: DOMRect, zone: number, over: EventTarget | null) {
  if (over instanceof Element && over.closest(`[data-edge-gestures-handle="${edge}"]`)) return true;
  return edge === 'left' ? x >= rect.left && x - rect.left <= zone : edge === 'right' ? x <= rect.right && rect.right - x <= zone : y <= rect.bottom && rect.bottom - y <= zone;
}

/** Swipes that start in an edge zone: left edge to the right, right edge to the left, bottom edge upward. */
export function useEdgeGestures({enabled, edges, target, handlers, zones, travel, shouldStart}: {
  enabled: boolean;
  edges: readonly Edge[];
  target: RefObject<HTMLElement | null>;
  handlers: EdgeHandlers;
  /** Zone width (side edges) or height (bottom) in dp; defaults to the Preferences zone width. */
  zones?: Partial<Record<Edge, number>>;
  /** Pixels of travel for progress 1. */
  travel?: Partial<Record<Edge, number>>;
  shouldStart?: (touch: TouchStart) => boolean;
}) {
  const preferences = usePreferences();
  const settings = edgeGestureSettings(preferences);
  const live = useRef({handlers, shouldStart});
  live.current = {handlers, shouldStart};
  // The Preferences switches and screen-reader mode apply here, so no caller repeats them.
  const active = enabled && !preferences.screenReader ? edges.filter(edge => settings[gestureOfEdge[edge]]) : [];
  const size = (edge: Edge) => zones?.[edge] ?? settings.zoneWidth;
  const key = active.map(edge => `${edge}:${size(edge)}:${travel?.[edge] ?? ''}`).join();
  useEffect(() => {
    const element = target.current;
    if (!element || !active.length) return;
    const inside = (x: number, y: number, close: Swipe) => {
      const rect = element.getBoundingClientRect();
      return active.some(edge => openSwipe[edge].axis === close.axis && openSwipe[edge].sign === close.sign && inZone(edge, x, y, rect, size(edge), null));
    };
    claimedZones.add(inside);
    const releaseSystem = claimSystemEdges({left: active.includes('left'), right: active.includes('right'), zone: Math.max(size('left'), size('right'))});
    const detach = attach(element, {
      shouldStart: touch => live.current.shouldStart?.(touch) ?? true,
      candidates: (x, y, over, rect) => active.filter(edge => inZone(edge, x, y, rect, size(edge), over)).map(edge => ({
        edge,
        swipe: {...openSwipe[edge], travel: travel?.[edge] ?? defaultTravel(edge, rect)},
        onStart: () => live.current.handlers.onStart?.(edge),
        onProgress: (progress, dx, dy) => live.current.handlers.onProgress(edge, progress, dx, dy),
        onCommit: () => live.current.handlers.onCommit(edge),
        onCancel: () => live.current.handlers.onCancel(edge),
      })),
    });
    return () => {detach(); claimedZones.delete(inside); releaseSystem();};
  }, [target, key]);
}

/** The opposite swipe on an open panel; starts anywhere in `target` except an edge zone that opens the other way. */
export function useSwipeToClose({enabled, direction, target, onProgress, onCommit, onCancel, travel, shouldStart}: {
  enabled: boolean;
  direction: CloseDirection;
  target: RefObject<HTMLElement | null>;
  onProgress: (progress: number, dx: number, dy: number) => void;
  onCommit: () => void;
  onCancel: () => void;
  /** Pixels of travel for progress 1; defaults to the target's width, or its height for 'down'. */
  travel?: number;
  shouldStart?: (touch: TouchStart) => boolean;
}) {
  const preferences = usePreferences();
  const live = useRef({onProgress, onCommit, onCancel, shouldStart});
  live.current = {onProgress, onCommit, onCancel, shouldStart};
  const active = enabled && !preferences.screenReader;
  useEffect(() => {
    const element = target.current;
    if (!element || !active) return;
    return attach(element, {
      shouldStart: touch => live.current.shouldStart?.(touch) ?? true,
      candidates: (x, y, _over, rect) => {
        const swipe = {...closeSwipe[direction], travel: travel ?? (direction === 'down' ? rect.height : rect.width)};
        if ([...claimedZones].some(inside => inside(x, y, swipe))) return [];
        return [{
          swipe,
          onProgress: (progress, dx, dy) => live.current.onProgress(progress, dx, dy),
          onCommit: () => live.current.onCommit(),
          onCancel: () => live.current.onCancel(),
        }];
      },
    });
  }, [target, active, direction, travel]);
}

/** Accessibility: 'buttons' when the gesture is switched off or screen-reader mode is on, so the caller renders its visible control. */
export function useEdgeGestureMode(id: EdgeGestureId): 'gesture' | 'buttons' {
  const preferences = usePreferences();
  return !preferences.screenReader && edgeGestureSettings(preferences)[id] ? 'gesture' : 'buttons';
}

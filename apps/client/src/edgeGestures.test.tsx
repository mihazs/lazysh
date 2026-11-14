// @vitest-environment jsdom
import {useRef} from 'react';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render} from '@testing-library/react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {loggingHandlers} from './edgeGestureLog';
import {createSwipe, recognizer, useEdgeGestureMode, useEdgeGestures, useSwipeToClose, type Edge, type Swipe} from './edgeGestures';
import {setGestureInsets, unknownInsets, type GestureInsets} from './gestureInsets';
import {defaults, savePreferences} from './preferences';
import {typingWindowMs} from './textInteraction';
import {bandOf, gestureStyles, overlays, startDistances, zoneWidths, type GestureStyle} from './test/gestureOverlays';
import {registerTextInteraction} from './textInteraction';

const right: Swipe = {axis: 'x', sign: 1, travel: 200};
const up: Swipe = {axis: 'y', sign: -1, travel: 200};

/** Feeds samples (x, y, ms) to a swipe that began at the first one. */
function run(swipe: Swipe, samples: [number, number, number][]) {
  const [[x0, y0, t0]] = samples, recognizerState = createSwipe(swipe, x0, y0, t0);
  const steps = samples.slice(1).map(([x, y, t]) => recognizerState.move(x, y, t));
  const [x, y, t] = samples[samples.length - 1];
  return {steps, verdict: recognizerState.end(x, y, t), state: recognizerState.state};
}

describe('swipe recogniser', () => {
  it('stays undecided inside the slop, then locks onto a dominant swipe axis', () => {
    const swipe = createSwipe(right, 0, 300, 0);
    expect(swipe.move(3, 302, 10).state).toBe('pending');
    expect(swipe.move(9, 305, 20)).toEqual({state: 'locked', progress: 9 / 200});
    expect(swipe.move(100, 310, 60).progress).toBe(.5);
    expect(swipe.move(400, 310, 90).progress).toBe(1);
  });
  it.each([
    ['a vertical drag', [0, 300, 0], [4, 330, 40]],
    ['a diagonal drag steeper than the lock ratio', [0, 300, 0], [30, 330, 40]],
    ['a swipe in the opposite direction', [0, 300, 0], [-30, 300, 40]],
  ] as const)('rejects %s for good', (_name, [x, y, t], [toX, toY, toT]) => {
    const swipe = createSwipe(right, x, y, t);
    expect(swipe.move(toX, toY, toT).state).toBe('rejected');
    expect(swipe.move(200, 300, 80).state).toBe('rejected');
    expect(swipe.end(200, 300, 90)).toBe('cancel');
  });
  it('treats a finger that rested before moving as a long press, not a swipe', () => {
    const swipe = createSwipe(right, 0, 300, 0);
    expect(swipe.move(30, 300, recognizer.hold + 1).state).toBe('rejected');
  });
  it('supports the bottom edge swiping upward', () => {
    const {steps, verdict} = run(up, [[200, 840, 0], [201, 800, 40], [200, 700, 100], [200, 640, 160]]);
    expect(steps.at(-1)?.progress).toBe(1);
    expect(verdict).toBe('commit');
  });
  it('commits a slow drag past the threshold and cancels one short of it', () => {
    expect(run(right, [[0, 300, 0], [30, 300, 200], [60, 300, 400], [80, 300, 600], [75, 300, 900]]).verdict).toBe('commit');
    expect(run(right, [[0, 300, 0], [30, 300, 200], [60, 300, 400], [65, 300, 600], [60, 300, 900]]).verdict).toBe('cancel');
  });
  it('commits a short fast fling but not a fast one that is too short', () => {
    expect(run(right, [[0, 300, 0], [20, 300, 20], [40, 300, 40]]).verdict).toBe('commit');
    expect(run(right, [[0, 300, 0], [12, 300, 8], [24, 300, 16]]).verdict).toBe('cancel');
  });
  it('cancels a swipe that was pulled back before the release', () => {
    expect(run(right, [[0, 300, 0], [90, 300, 100], [40, 300, 160], [10, 300, 200]]).verdict).toBe('cancel');
    expect(run(right, [[0, 300, 0], [140, 300, 100], [60, 300, 140]]).verdict).toBe('cancel');
  });
  it('lets a resting finger lose its fling velocity', () => {
    expect(run(right, [[0, 300, 0], [20, 300, 20], [40, 300, 40], [40, 300, 600]]).verdict).toBe('cancel');
  });
});

vi.mock('@tauri-apps/api/core', () => ({invoke: vi.fn(() => Promise.resolve()), isTauri: vi.fn(() => false)}));

type Log = string[];
/** A 390 x 800 viewport target that records every handler call. */
function Harness({log, edges = ['left', 'right', 'bottom'], enabled = true, close}: {log: Log; edges?: Edge[]; enabled?: boolean; close?: 'left' | 'right' | 'down'}) {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeGestures({enabled, edges, target: ref, travel: {left: 200, right: 200, bottom: 200}, handlers: loggingHandlers(log)});
  useSwipeToClose({enabled: !!close, direction: close ?? 'left', target: ref, travel: 200, onProgress: progress => log.push(`close:${progress.toFixed(2)}`), onCommit: () => log.push('closed'), onCancel: () => log.push('close-cancelled')});
  return <div ref={ref} data-testid="surface"><textarea aria-label="composer" /><div className="scroller" style={{overflowX: 'auto'}}><p>wide</p></div><button>plain</button></div>;
}

const finger = (identifier: number, x: number, y: number) => ({identifier, clientX: x, clientY: y, target: document.body, pageX: x, pageY: y, screenX: x, screenY: y, radiusX: 1, radiusY: 1, rotationAngle: 0, force: 1});
/** Dispatches one synthetic touch event; `touches` are the fingers still down. */
function touch(target: Element, type: 'touchstart' | 'touchmove' | 'touchend', fingers: [number, number][], changed = fingers, cancelable = true) {
  const event = new Event(type, {bubbles: true, cancelable});
  const list = (items: [number, number][]) => items.map(([x, y], index) => finger(index, x, y));
  Object.assign(event, {touches: type === 'touchend' ? list(fingers.slice(changed.length)) : list(fingers), changedTouches: list(changed)});
  act(() => {target.dispatchEvent(event);});
  return event;
}
/** One finger from `from` through `through` to the last point, `step` ms apart. */
function swipe(target: Element, from: [number, number], through: [number, number][], step = 16) {
  touch(target, 'touchstart', [from]);
  let last = from;
  for (const point of through) {vi.advanceTimersByTime(step); touch(target, 'touchmove', [point]); last = point;}
  vi.advanceTimersByTime(step);
  const end = touch(target, 'touchend', [last], [last]);
  // A finger drag that no recogniser claimed counts as a scroll for a moment; the next swipe comes later.
  vi.advanceTimersByTime(400);
  return end;
}

const surface = () => document.querySelector('[data-testid="surface"]') as HTMLElement;
function layout() {
  Object.defineProperty(window, 'innerWidth', {configurable: true, value: 390});
  Object.defineProperty(window, 'innerHeight', {configurable: true, value: 800});
  surface().getBoundingClientRect = () => ({left: 0, top: 0, right: 390, bottom: 800, width: 390, height: 800, x: 0, y: 0, toJSON() {}}) as DOMRect;
}
const render390 = (props: Parameters<typeof Harness>[0]) => {const view = render(<Harness {...props} />); layout(); return view;};

// The guard's windows live in module state, so one clock runs through the whole file and only moves forward.
beforeAll(() => {vi.useFakeTimers({toFake: ['performance', 'Date']});});
afterAll(() => {vi.useRealTimers();});
beforeEach(() => {
  document.body.dispatchEvent(new Event('compositionend', {bubbles: true}));
  vi.advanceTimersByTime(60_000);
  localStorage.clear(); savePreferences({...defaults}); setGestureInsets(unknownInsets);
});
afterEach(() => {cleanup();});

describe('edge gestures', () => {
  it.each([
    ['left', [3, 300], [[20, 302], [90, 304], [140, 304]]],
    ['right', [388, 300], [[370, 302], [300, 304], [250, 304]]],
    ['bottom', [200, 795], [[201, 770], [201, 720], [201, 650]]],
  ] as const)('commits a swipe that starts in the %s zone', (edge, from, through) => {
    const log: Log = [];
    render390({log});
    const end = swipe(surface(), [...from], through.map(point => [...point] as [number, number]));
    expect(log[0]).toBe(`start:${edge}`);
    expect(log.at(-1)).toBe(`commit:${edge}`);
    expect(log.filter(line => line.startsWith('progress'))).not.toHaveLength(0);
    // The claimed release produces no click.
    expect(end.defaultPrevented).toBe(true);
  });
  it('cancels a short swipe and reports the release as a cancel', () => {
    const log: Log = [];
    render390({log});
    swipe(surface(), [3, 300], [[25, 300], [40, 300], [40, 300]], 120);
    expect(log.at(-1)).toBe('cancel:left');
  });
  it('never starts from the interior, and an interior swipe does not become an edge swipe', () => {
    const log: Log = [];
    render390({log});
    swipe(surface(), [200, 300], [[260, 300], [330, 300], [388, 300]]);
    swipe(surface(), [60, 300], [[40, 300], [10, 300], [2, 300]]);
    expect(log).toEqual([]);
  });
  it('only claims once the touch locked: a tap and a vertical drag at the edge pass through', () => {
    const log: Log = [];
    render390({log});
    const up = swipe(surface(), [3, 300], [[4, 260], [5, 200]]);
    expect(log).toEqual([]);
    expect(up.defaultPrevented).toBe(false);
    expect(swipe(surface(), [3, 300], []).defaultPrevented).toBe(false);
  });
  it('is off when disabled, for an edge not listed, or switched off in Preferences', () => {
    const log: Log = [];
    const view = render390({log, enabled: false});
    swipe(surface(), [3, 300], [[30, 300], [150, 300]]);
    view.rerender(<Harness log={log} edges={['bottom']} />);
    swipe(surface(), [3, 300], [[30, 300], [150, 300]]);
    expect(log).toEqual([]);
    view.rerender(<Harness log={log} />);
    act(() => savePreferences({...defaults, edgeGestures: {leftMenu: false, bottomMenu: true, viewSwitch: true, zoneWidth: 24}}));
    swipe(surface(), [3, 300], [[30, 300], [150, 300]]);
    expect(log).toEqual([]);
    swipe(surface(), [388, 300], [[360, 300], [250, 300]]);
    expect(log.at(-1)).toBe('commit:right');
  });
  it('is off in screen-reader mode', () => {
    const log: Log = [];
    act(() => savePreferences({...defaults, screenReader: true}));
    render390({log});
    swipe(surface(), [3, 300], [[30, 300], [150, 300]]);
    expect(log).toEqual([]);
  });
  it('honours the zone width preference', () => {
    const log: Log = [];
    act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: 48}}));
    render390({log});
    swipe(surface(), [40, 300], [[70, 300], [150, 300]]);
    expect(log.at(-1)).toBe('commit:left');
  });
  it('skips intermediate progress under prefers-reduced-motion', () => {
    const log: Log = [];
    window.matchMedia = ((query: string) => ({matches: query.includes('reduce'), addEventListener() {}, removeEventListener() {}})) as never;
    render390({log});
    swipe(surface(), [3, 300], [[30, 300], [90, 300], [150, 300]]);
    expect(log.filter(line => line.startsWith('progress'))).toEqual(['progress:left:1.00']);
    expect(log.at(-1)).toBe('commit:left');
    window.matchMedia = undefined as never;
  });
  it('cancels a claimed swipe when a second finger lands', () => {
    const log: Log = [];
    render390({log});
    touch(surface(), 'touchstart', [[3, 300]]);
    touch(surface(), 'touchmove', [[30, 300]]);
    touch(surface(), 'touchmove', [[60, 300]]);
    touch(surface(), 'touchstart', [[60, 300], [200, 300]]);
    touch(surface(), 'touchend', [[60, 300], [200, 300]], [[200, 300]]);
    expect(log.at(-1)).toBe('cancel:left');
    expect(log).not.toContain('commit:left');
  });
  it('ignores touches that start on a text field, a horizontal scroller or an opted-out control', () => {
    const log: Log = [];
    render390({log});
    const field = document.querySelector('textarea')!, scroller = document.querySelector('.scroller') as HTMLElement;
    Object.defineProperties(scroller, {scrollWidth: {value: 900, configurable: true}, clientWidth: {value: 300}});
    for (const node of [field, scroller]) swipe(node, [3, 300], [[30, 300], [150, 300]]);
    document.querySelector('button')!.setAttribute('data-edge-gestures-ignore', '');
    swipe(document.querySelector('button')!, [3, 300], [[30, 300], [150, 300]]);
    expect(log).toEqual([]);
    // A scroller with nothing to scroll does not consume the swipe.
    Object.defineProperty(scroller, 'scrollWidth', {value: 300});
    swipe(scroller, [3, 300], [[30, 300], [150, 300]]);
    expect(log.at(-1)).toBe('commit:left');
  });
  it('lets a handle element start the bottom swipe wherever it sits', () => {
    const log: Log = [];
    render390({log, edges: ['bottom']});
    const handle = document.createElement('i');
    handle.setAttribute('data-edge-gestures-handle', 'bottom');
    surface().append(handle);
    swipe(handle, [195, 700], [[195, 680], [195, 600], [195, 520]]);
    expect(log.at(-1)).toBe('commit:bottom');
  });
  it('lets the app veto a touch', () => {
    const log: Log = [];
    function Vetoed() {
      const ref = useRef<HTMLDivElement>(null);
      useEdgeGestures({enabled: true, edges: ['left'], target: ref, shouldStart: touch => touch.edge !== 'left', handlers: {onProgress: () => log.push('progress'), onCommit: () => log.push('commit'), onCancel: () => log.push('cancel')}});
      return <div ref={ref} data-testid="surface" />;
    }
    render(<Vetoed />); layout();
    swipe(surface(), [3, 300], [[30, 300], [150, 300]]);
    expect(log).toEqual([]);
  });
});

/** One UI with the back gesture on: 32 dp Back zones, a 24 dp Home zone of which 20 dp is the system gesture bar. */
const oneUi: GestureInsets = {left: 32, right: 32, bottom: 20, mandatoryBottom: 24, navigation: 'gesture'};
const setMode = (mode: 'auto' | 'handles' | 'edges' | 'off') => act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: 24, mode}}));
const withInsets = (insets: GestureInsets) => act(() => setGestureInsets(insets));
const handleOn = (edge: Edge) => {
  const handle = document.createElement('i');
  handle.setAttribute('data-edge-gestures-handle', edge);
  surface().append(handle);
  return handle;
};

describe('Android system gesture exclusion', () => {
  const calls = () => vi.mocked(invoke).mock.calls.filter(([command]) => command === 'edge_gesture_exclusion').map(([, args]) => args as Record<string, unknown>);
  beforeEach(() => {vi.mocked(invoke).mockClear(); vi.mocked(isTauri).mockReturnValue(true); withInsets(oneUi);});
  afterEach(() => {vi.mocked(isTauri).mockReturnValue(false);});
  it('claims the enabled side bands only on the rows of the handles while edge swipes are on, and gives them back on unmount', () => {
    act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: false, zoneWidth: 32, mode: 'edges'}}));
    const view = render390({log: []});
    // 800 px viewport, 24 dp Home zone, 80 px clear of it: the 200 dp row ends at 696.
    expect(calls().at(-1)).toEqual({left: true, right: false, zoneDp: 32, rowTopDp: 496, rowBottomDp: 696});
    view.unmount();
    expect(calls().at(-1)).toMatchObject({left: false, right: false});
  });
  it('never asks for more than 200 dp, nor for a row that reaches the Home zone', () => {
    setMode('edges');
    for (const height of [400, 600, 800, 1200]) {
      Object.defineProperty(window, 'innerHeight', {configurable: true, value: height});
      cleanup(); vi.mocked(invoke).mockClear();
      render(<Harness log={[]} />);
      const {rowTopDp, rowBottomDp} = calls().at(-1) as {rowTopDp: number; rowBottomDp: number};
      expect(rowBottomDp - rowTopDp).toBeLessThanOrEqual(200);
      expect(rowBottomDp).toBeLessThanOrEqual(height - oneUi.mandatoryBottom);
    }
  });
  it('claims nothing with handles, with the gestures off, with three-button navigation or in a plain browser', () => {
    for (const mode of ['handles', 'off'] as const) {setMode(mode); render390({log: []}); cleanup();}
    setMode('auto'); render390({log: []}); cleanup();
    setMode('edges'); withInsets({...oneUi, left: 0, right: 0, mandatoryBottom: 0, bottom: 0, navigation: 'buttons'}); render390({log: []}); cleanup();
    expect(calls()).toEqual([]);
    vi.mocked(isTauri).mockReturnValue(false); withInsets(oneUi);
    render390({log: [], enabled: true});
    expect(calls()).toEqual([]);
  });
  it('claims again when the system reports other zones or the window is resized', () => {
    setMode('edges');
    render390({log: []});
    const before = calls().length;
    withInsets({...oneUi, mandatoryBottom: 48, bottom: 48});
    expect(calls().length).toBeGreaterThan(before);
    expect(calls().at(-1)).toMatchObject({left: true, right: true, rowBottomDp: 672});
    Object.defineProperty(window, 'innerHeight', {configurable: true, value: 600});
    act(() => {window.dispatchEvent(new Event('resize'));});
    expect(calls().at(-1)).toMatchObject({rowBottomDp: 472});
  });
});

describe('gesture modes on Android gesture navigation', () => {
  beforeEach(() => withInsets(oneUi));
  const rows = [500, 690] as const;
  it('uses handles by default: the screen edge is left to the system and a handle starts the swipe', () => {
    const log: Log = [];
    render390({log});
    swipe(surface(), [3, 600], [[30, 600], [150, 600]]);
    swipe(surface(), [388, 600], [[360, 600], [250, 600]]);
    swipe(surface(), [200, 794], [[201, 770], [201, 720], [201, 650]]);
    expect(log).toEqual([]);
    swipe(handleOn('left'), [40, 600], [[70, 600], [150, 600]]);
    expect(log.at(-1)).toBe('commit:left');
    swipe(handleOn('right'), [350, 600], [[320, 600], [250, 600]]);
    expect(log.at(-1)).toBe('commit:right');
    swipe(handleOn('bottom'), [200, 770], [[201, 740], [201, 690], [201, 620]]);
    expect(log.at(-1)).toBe('commit:bottom');
  });
  it('a handle only starts its own edge', () => {
    const log: Log = [];
    render390({log});
    swipe(handleOn('left'), [200, 600], [[170, 600], [100, 600]]);
    expect(log).toEqual([]);
  });
  describe('the band beside the handles, just past the zones the system keeps', () => {
    /** The last call of a swipe from `from` (30, 70 and 120 px toward `to`): the gesture it commits, or null when nothing starts. */
    const starts = (from: [number, number], to: 'right' | 'left' | 'up') => {
      const log: Log = [];
      render390({log});
      const [x, y] = from, step = (n: number): [number, number] => to === 'up' ? [x + 1, y - n] : [x + (to === 'right' ? n : -n), y];
      swipe(surface(), from, [step(30), step(70), step(120)]);
      cleanup();
      return log.at(-1) ?? null;
    };
    it('starts a swipe past the zone, and leaves the screen edge, the zone itself and everything beyond the band alone', () => {
      // 32 dp Back zones plus the 4 dp margin, and the 40 dp default width: the band is 36 to 76 dp from each side edge.
      for (const x of [0, 3, 20, 32, 35]) expect(starts([x, 600], 'right')).toBeNull();
      for (const x of [36, 40, 76]) expect(starts([x, 600], 'right')).toBe('commit:left');
      for (const x of [77, 80, 120, 200]) expect(starts([x, 600], 'right')).toBeNull();
      for (const x of [390, 387, 370, 355]) expect(starts([x, 600], 'left')).toBeNull();
      for (const x of [353, 350, 314]) expect(starts([x, 600], 'left')).toBe('commit:right');
      for (const x of [313, 300, 190]) expect(starts([x, 600], 'left')).toBeNull();
    });
    it('reaches up the sides to the toolbar, and keeps above the Home zone at the bottom', () => {
      // The side bands stop 80 dp above the 24 dp Home zone, where the toolbar starts.
      for (const y of [20, 100, 300, 600, 696]) expect(starts([40, y], 'right')).toBe('commit:left');
      for (const y of [697, 730, 790]) expect(starts([40, y], 'right')).toBeNull();
      // The Home zone is 24 dp, the band 4 dp past it and 40 dp deep.
      for (const y of [799, 790, 776]) expect(starts([200, y], 'up')).toBeNull();
      for (const y of [771, 760, 733]) expect(starts([200, y], 'up')).toBe('commit:bottom');
      for (const y of [731, 700, 500]) expect(starts([200, y], 'up')).toBeNull();
    });
    it.each([
      ['a narrow Back zone', 24, 28, 68],
      ['the wide Back zone', 32, 36, 76],
      ['an extra wide Back zone', 40, 44, 84],
      ['One UI at its highest back sensitivity', 56, 60, 100],
    ])('follows %s the system reports now', (_name, zone, first, last) => {
      withInsets({...oneUi, left: zone, right: zone});
      expect(starts([first - 1, 600], 'right')).toBeNull();
      expect(starts([first, 600], 'right')).toBe('commit:left');
      expect(starts([last, 600], 'right')).toBe('commit:left');
      expect(starts([last + 1, 600], 'right')).toBeNull();
      expect(starts([390 - first, 600], 'left')).toBe('commit:right');
      expect(starts([390 - first + 1, 600], 'left')).toBeNull();
    });
    it('reaches as far as the zone width preference says', () => {
      act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: 96, mode: 'handles'}}));
      expect(starts([132, 600], 'right')).toBe('commit:left');
      expect(starts([133, 600], 'right')).toBeNull();
      act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: 16, mode: 'handles'}}));
      expect(starts([52, 600], 'right')).toBe('commit:left');
      expect(starts([53, 600], 'right')).toBeNull();
    });
    it('starts at the edge itself where the system keeps no zone', () => {
      setMode('handles');
      for (const insets of [unknownInsets, {...unknownInsets, navigation: 'buttons'} as GestureInsets]) {
        withInsets(insets);
        expect(starts([2, 100], 'right')).toBe('commit:left');
        expect(starts([41, 100], 'right')).toBeNull();
        expect(starts([200, 797], 'up')).toBe('commit:bottom');
      }
    });
    it('stays a swipe for the recogniser: a vertical drag or a rested finger in the band is not claimed, and typing still stops it', () => {
      const log: Log = [];
      render390({log});
      expect(swipe(surface(), [50, 600], [[51, 560], [52, 500]]).defaultPrevented).toBe(false);
      expect(swipe(surface(), [50, 600], []).defaultPrevented).toBe(false);
      swipe(surface(), [50, 600], [[80, 600], [150, 600]], recognizer.hold + 50);
      expect(log).toEqual([]);
      act(() => {document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}));});
      swipe(surface(), [50, 600], [[80, 600], [150, 600]]);
      expect(log).toEqual([]);
    });
  });
  it('edge swipes start only inside the handle rows at the sides, and above the Home zone at the bottom', () => {
    setMode('edges');
    const log: Log = [];
    render390({log});
    swipe(surface(), [3, 100], [[30, 100], [150, 100]]);
    swipe(surface(), [388, 760], [[360, 760], [250, 760]]);
    expect(log).toEqual([]);
    swipe(surface(), [3, rows[0] + 20], [[30, rows[0] + 20], [150, rows[0] + 20]]);
    expect(log.at(-1)).toBe('commit:left');
    swipe(surface(), [388, rows[1] - 20], [[360, rows[1] - 20], [250, rows[1] - 20]]);
    expect(log.at(-1)).toBe('commit:right');
    // The lowest 24 px belong to the system; the bottom zone is the 24 px above them.
    log.length = 0;
    swipe(surface(), [200, 795], [[201, 770], [201, 720], [201, 650]]);
    expect(log).toEqual([]);
    swipe(surface(), [200, 765], [[201, 740], [201, 690], [201, 620]]);
    expect(log.at(-1)).toBe('commit:bottom');
  });
  it('keeps true edge swipes with three-button navigation or when the system reports nothing', () => {
    for (const insets of [unknownInsets, {...unknownInsets, navigation: 'buttons'} as GestureInsets]) {
      withInsets(insets);
      const log: Log = [];
      render390({log});
      swipe(surface(), [3, 100], [[30, 100], [150, 100]]);
      expect(log.at(-1)).toBe('commit:left');
      swipe(surface(), [200, 795], [[201, 770], [201, 720], [201, 650]]);
      expect(log.at(-1)).toBe('commit:bottom');
      cleanup();
    }
  });
  it('follows the zones the system reports now: a wider Home zone moves the bottom zone up', () => {
    setMode('edges');
    const log: Log = [];
    render390({log});
    swipe(surface(), [200, 765], [[201, 740], [201, 690], [201, 620]]);
    expect(log.at(-1)).toBe('commit:bottom');
    withInsets({...oneUi, mandatoryBottom: 64, bottom: 64});
    log.length = 0;
    swipe(surface(), [200, 765], [[201, 740], [201, 690], [201, 620]]);
    expect(log).toEqual([]);
    swipe(surface(), [200, 725], [[201, 700], [201, 650], [201, 580]]);
    expect(log.at(-1)).toBe('commit:bottom');
  });
  it('does nothing with the gestures off, and then asks the caller for its buttons', () => {
    setMode('off');
    const log: Log = [];
    function Probe() {return <output>{useEdgeGestureMode('bottomMenu')}</output>;}
    const view = render390({log});
    render(<Probe />);
    swipe(handleOn('left'), [40, 600], [[70, 600], [150, 600]]);
    swipe(surface(), [3, 600], [[30, 600], [150, 600]]);
    expect(log).toEqual([]);
    expect(document.querySelector('output')?.textContent).toBe('buttons');
    view.unmount();
  });
  it('still never starts while typing, whichever way the swipe began', () => {
    const log: Log = [];
    render390({log});
    act(() => {document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}));});
    swipe(handleOn('left'), [40, 600], [[70, 600], [150, 600]]);
    expect(log).toEqual([]);
  });
  it('lets a closing swipe start on a handle only when the handle does not open the other way', () => {
    const log: Log = [];
    render390({log, close: 'right'});
    // The left handle opens to the right, the same direction this panel closes: the open swipe owns it.
    swipe(handleOn('left'), [40, 600], [[70, 600], [150, 600]]);
    expect(log.filter(line => line.startsWith('close'))).toEqual([]);
    expect(log.at(-1)).toBe('commit:left');
  });
});

/**
 * The regression matrix of #1380 and #1435: every combination of navigation overlay, system Back zone, zone width and gesture style, with a
 * swipe started at 0 dp, just inside the system zone, at the band start, in the band, at the band end and just beyond it, on each edge.
 * The oracle is the documented geometry (docs/android-testing.md, "Gesture navigation and Samsung One UI"), not the engine's own helpers:
 * under gesture navigation the system owns [0, inset] and the app band is [inset + 4, inset + 4 + width] dp (handles), or [0, width] at the
 * sides and [home, home + width] at the bottom (edge swipes); with three buttons the system keeps nothing and the band is [0, width].
 */
describe('the edge gesture matrix across navigation overlays (#1380)', () => {
  /** Where the swipe starts and how it travels: sides at a row inside the handle rows (472 to 672 of 800 dp), the bottom at mid width. */
  const geometry = (edge: Edge, distance: number) => {
    const from: [number, number] = edge === 'left' ? [distance, 600] : edge === 'right' ? [390 - distance, 600] : [195, 800 - distance];
    const step = (n: number): [number, number] => edge === 'left' ? [from[0] + n, 600] : edge === 'right' ? [from[0] - n, 600] : [196, from[1] - n];
    return {from, through: [step(30), step(70), step(120)]};
  };
  const configure = (insets: GestureInsets, width: number, style: GestureStyle) => {
    act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: true, zoneWidth: width, mode: style}}));
    withInsets(insets);
  };

  it.each(overlays.flatMap(overlay => zoneWidths.flatMap(width => gestureStyles.map(style => [overlay.name, width, style, overlay.insets] as const))))(
    '%s, zone %i dp, %s: opens from the band and from nowhere else', (_name, width, style, insets) => {
      configure(insets, width, style);
      const log: Log = [];
      render390({log});
      for (const edge of ['left', 'right', 'bottom'] as const) {
        const [from, to] = bandOf(insets, edge, width, style);
        for (const distance of startDistances([from, to])) {
          log.length = 0;
          const {from: origin, through} = geometry(edge, distance);
          swipe(surface(), origin, through);
          const expected = distance >= from && distance <= to;
          expect(log.at(-1) ?? null, `${edge} swipe from ${distance} dp (band ${from} to ${to})`).toBe(expected ? `commit:${edge}` : null);
        }
      }
    });

  it.each(overlays.map(overlay => [overlay.name, overlay.insets] as const))('%s: typing and a selection still stop a swipe that starts in the band, which returns afterwards', (_name, insets) => {
    configure(insets, 40, 'handles');
    const log: Log = [];
    render390({log});
    const [from] = bandOf(insets, 'left', 40, 'handles'), {from: origin, through} = geometry('left', from);
    act(() => {document.body.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', bubbles: true}));});
    swipe(surface(), origin, through);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(typingWindowMs + 50);
    const release = registerTextInteraction('selection', () => true);
    swipe(surface(), origin, through);
    expect(log).toEqual([]);
    release();
    swipe(surface(), origin, through);
    expect(log.at(-1)).toBe('commit:left');
  });

  it('follows the overlay the user switches to while the app runs, in both directions', () => {
    configure(overlays[2].insets, 40, 'handles');
    const log: Log = [];
    render390({log});
    const startsAt = (distance: number) => {log.length = 0; const {from, through} = geometry('left', distance); swipe(surface(), from, through); return log.at(-1) === 'commit:left';};
    expect([startsAt(2), startsAt(40)]).toEqual([false, true]);
    withInsets(overlays[0].insets);
    expect([startsAt(2), startsAt(40), startsAt(41)]).toEqual([true, true, false]);
    withInsets(overlays[3].insets);
    expect([startsAt(2), startsAt(40), startsAt(44), startsAt(84)]).toEqual([false, false, true, true]);
  });

  /**
   * Chrome sends the first touchmove once the finger has left its 8 dp slop; that move is the last the page may cancel. If the page does not
   * claim it the browser scrolls and every later move is uncancelable (the 4 of 10 misses on three buttons; the recogniser's slop was 10 px).
   */
  it.each([8, 9, 12])('claims a left swipe whose first cancelable move has travelled only %i px', travelled => {
    configure(overlays[0].insets, 40, 'handles');
    const log: Log = [];
    render390({log});
    touch(surface(), 'touchstart', [[3, 600]]);
    vi.advanceTimersByTime(8);
    const first = touch(surface(), 'touchmove', [[3 + travelled, 600]]);
    const rest = first.defaultPrevented;
    for (const x of [60, 110, 160]) {vi.advanceTimersByTime(8); touch(surface(), 'touchmove', [[x, 600]], [[x, 600]], rest);}
    vi.advanceTimersByTime(8);
    touch(surface(), 'touchend', [[160, 600]], [[160, 600]], rest);
    expect(log.at(0)).toBe('start:left');
    expect(log.at(-1)).toBe('commit:left');
  });
});

describe('the typing and text-editing guard', () => {
  const swiped = (log: Log, before?: () => void, during?: () => void) => {
    before?.();
    touch(surface(), 'touchstart', [[3, 300]]);
    vi.advanceTimersByTime(16); touch(surface(), 'touchmove', [[30, 300]]);
    during?.();
    vi.advanceTimersByTime(16); touch(surface(), 'touchmove', [[90, 300]]);
    vi.advanceTimersByTime(16); touch(surface(), 'touchmove', [[150, 300]]);
    vi.advanceTimersByTime(16); touch(surface(), 'touchend', [[150, 300]], [[150, 300]]);
    vi.advanceTimersByTime(400);
    return log;
  };
  const dispatch = (type: string, init: EventInit & {isComposing?: boolean} = {}) => act(() => {document.body.dispatchEvent(Object.assign(new Event(type, {bubbles: true}), init));});
  const wait = (ms: number) => vi.advanceTimersByTime(ms);
  const fresh = () => wait(5000);

  it('does not start while the soft keyboard is composing, and starts again once it ends', () => {
    const log: Log = [];
    render390({log});
    dispatch('compositionstart');
    expect(swiped(log)).toEqual([]);
    dispatch('compositionend');
    wait(typingWindowMs + 50);
    expect(swiped(log).at(-1)).toBe('commit:left');
  });
  it('does not start within the typing window after a key, then does', () => {
    const log: Log = [];
    render390({log});
    dispatch('keydown', {isComposing: false});
    wait(typingWindowMs - 100);
    expect(swiped(log)).toEqual([]);
    wait(200);
    expect(swiped(log).at(-1)).toBe('commit:left');
  });
  it('does not start while focus is in a text field, but the terminal keyboard sink does not count', () => {
    const log: Log = [];
    render390({log});
    const field = document.querySelector('textarea')!;
    act(() => field.focus());
    expect(swiped(log)).toEqual([]);
    act(() => field.blur());
    const sink = document.createElement('textarea');
    sink.setAttribute('data-terminal-editor', '');
    document.body.append(sink);
    act(() => sink.focus());
    expect(swiped(log).at(-1)).toBe('commit:left');
    sink.remove();
  });
  it('does not start with a selection active (document range or a registered terminal selection)', () => {
    const log: Log = [];
    render390({log});
    let selected = true;
    const release = registerTextInteraction('selection', () => selected);
    expect(swiped(log)).toEqual([]);
    selected = false;
    expect(swiped(log).at(-1)).toBe('commit:left');
    release();
    log.length = 0;
    const text = document.createElement('p');
    text.textContent = 'selected words';
    document.body.append(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(swiped(log)).toEqual([]);
    window.getSelection()!.removeAllRanges();
    text.remove();
    expect(swiped(log).at(-1)).toBe('commit:left');
  });
  it('does not count a document range inside the drawn terminal as a text selection (the terminal reports its own)', () => {
    const log: Log = [];
    render390({log});
    const root = document.createElement('div');
    root.setAttribute('data-terminal-root', '');
    root.textContent = 'mirrored rows';
    document.body.append(root);
    const range = document.createRange();
    range.selectNodeContents(root);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(swiped(log).at(-1)).toBe('commit:left');
    window.getSelection()!.removeAllRanges();
    root.remove();
  });
  it('does not start during a long-press cursor drag or a selection handle drag reported by the app', () => {
    const log: Log = [];
    render390({log});
    for (const kind of ['cursorDrag', 'selectionHandle'] as const) {
      const release = registerTextInteraction(kind, () => true);
      expect(swiped(log)).toEqual([]);
      release();
    }
    expect(swiped(log).at(-1)).toBe('commit:left');
  });
  it('does not start during a pinch, and not for a moment after its last finger lifts', () => {
    const log: Log = [];
    render390({log});
    touch(surface(), 'touchstart', [[100, 300], [200, 300]]);
    touch(surface(), 'touchmove', [[80, 300], [220, 300]]);
    touch(surface(), 'touchend', [[80, 300], [220, 300]], [[80, 300], [220, 300]]);
    expect(swiped(log)).toEqual([]);
    wait(300);
    expect(swiped(log).at(-1)).toBe('commit:left');
  });
  it('does not start while a terminal scroll runs or its fling settles', () => {
    const log: Log = [];
    render390({log});
    // A finger scroll in the interior, then a scroll event from the fling it started.
    touch(surface(), 'touchstart', [[200, 300]]);
    touch(surface(), 'touchmove', [[200, 360]]);
    touch(surface(), 'touchend', [[200, 360]], [[200, 360]]);
    wait(30);
    act(() => {document.dispatchEvent(new Event('scroll'));});
    wait(100);
    expect(swiped(log)).toEqual([]);
    wait(1000);
    expect(swiped(log).at(-1)).toBe('commit:left');
  });
  it('does not mistake output that scrolls the terminal for the user scrolling', () => {
    const log: Log = [];
    render390({log});
    fresh();
    act(() => {document.dispatchEvent(new Event('scroll'));});
    expect(swiped(log).at(-1)).toBe('commit:left');
  });
  it('cancels a swipe that is under way when typing starts, and never completes it', () => {
    const log: Log = [];
    render390({log});
    fresh();
    swiped(log, undefined, () => dispatch('keydown'));
    expect(log).toContain('start:left');
    expect(log.at(-1)).toBe('cancel:left');
    expect(log).not.toContain('commit:left');
  });
  it('does not complete a swipe when the guard trips only at the release', () => {
    const log: Log = [];
    render390({log});
    fresh();
    touch(surface(), 'touchstart', [[3, 300]]);
    wait(16); touch(surface(), 'touchmove', [[40, 300]]);
    wait(16); touch(surface(), 'touchmove', [[150, 300]]);
    const release = registerTextInteraction('selection', () => true);
    wait(16); touch(surface(), 'touchend', [[150, 300]], [[150, 300]]);
    release();
    expect(log.at(-1)).toBe('cancel:left');
  });
});

describe('swipe to close', () => {
  it.each([
    ['left', [300, 400], [[260, 402], [150, 404], [90, 404]]],
    ['right', [100, 400], [[140, 402], [250, 404], [310, 404]]],
    ['down', [200, 100], [[201, 140], [201, 230], [201, 320]]],
  ] as const)('closes by a %s swipe from anywhere inside the panel', (direction, from, through) => {
    const log: Log = [];
    render390({log, edges: [], close: direction});
    swipe(surface(), [...from], through.map(point => [...point] as [number, number]));
    expect(log.at(-1)).toBe('closed');
    expect(log.filter(line => line.startsWith('close:'))).not.toHaveLength(0);
  });
  it('leaves the edge zone that opens the other way to the edge swipe', () => {
    const log: Log = [];
    render390({log, edges: ['left'], close: 'right'});
    swipe(surface(), [3, 300], [[40, 300], [150, 300]]);
    expect(log.some(line => line.startsWith('close'))).toBe(false);
    expect(log.at(-1)).toBe('commit:left');
    log.length = 0;
    swipe(surface(), [100, 300], [[140, 300], [250, 300], [310, 300]]);
    expect(log.at(-1)).toBe('closed');
  });
  it('is guarded like the edge swipes: no close while typing', () => {
    const log: Log = [];
    render390({log, edges: [], close: 'left'});
    act(() => document.querySelector('textarea')!.focus());
    swipe(surface(), [300, 400], [[260, 400], [150, 400], [90, 400]]);
    expect(log).toEqual([]);
  });
  it('does not close a bottom sheet by dragging down while its content can scroll up', () => {
    const log: Log = [];
    render390({log, edges: [], close: 'down'});
    const scroller = document.querySelector('.scroller') as HTMLElement;
    scroller.style.overflowY = 'auto';
    Object.defineProperties(scroller, {scrollHeight: {value: 900}, clientHeight: {value: 300}, scrollTop: {value: 120, configurable: true}});
    swipe(scroller, [200, 100], [[201, 140], [201, 230], [201, 320]]);
    expect(log).toEqual([]);
    Object.defineProperty(scroller, 'scrollTop', {value: 0});
    swipe(scroller, [200, 100], [[201, 140], [201, 230], [201, 320]]);
    expect(log.at(-1)).toBe('closed');
  });
});

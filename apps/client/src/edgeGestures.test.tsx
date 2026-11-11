// @vitest-environment jsdom
import {useRef} from 'react';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {act, cleanup, render} from '@testing-library/react';
import {invoke, isTauri} from '@tauri-apps/api/core';
import {loggingHandlers} from './edgeGestureLog';
import {createSwipe, recognizer, useEdgeGestures, useSwipeToClose, type Edge, type Swipe} from './edgeGestures';
import {defaults, savePreferences} from './preferences';
import {typingWindowMs} from './textInteraction';
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
    expect(swipe.move(5, 303, 10).state).toBe('pending');
    expect(swipe.move(14, 305, 20)).toEqual({state: 'locked', progress: 14 / 200});
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
function touch(target: Element, type: 'touchstart' | 'touchmove' | 'touchend', fingers: [number, number][], changed = fingers) {
  const event = new Event(type, {bubbles: true, cancelable: true});
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
  surface().getBoundingClientRect = () => ({left: 0, top: 0, right: 390, bottom: 800, width: 390, height: 800, x: 0, y: 0, toJSON() {}}) as DOMRect;
}
const render390 = (props: Parameters<typeof Harness>[0]) => {const view = render(<Harness {...props} />); layout(); return view;};

// The guard's windows live in module state, so one clock runs through the whole file and only moves forward.
beforeAll(() => {vi.useFakeTimers({toFake: ['performance', 'Date']});});
afterAll(() => {vi.useRealTimers();});
beforeEach(() => {
  document.body.dispatchEvent(new Event('compositionend', {bubbles: true}));
  vi.advanceTimersByTime(60_000);
  localStorage.clear(); savePreferences({...defaults});
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

describe('Android system gesture exclusion', () => {
  const claimed = () => vi.mocked(invoke).mock.calls.map(([, args]) => args);
  beforeEach(() => {vi.mocked(invoke).mockClear(); vi.mocked(isTauri).mockReturnValue(true);});
  afterEach(() => {vi.mocked(isTauri).mockReturnValue(false);});
  it('claims the enabled side bands at the zone width while mounted and gives them back on unmount', () => {
    act(() => savePreferences({...defaults, edgeGestures: {leftMenu: true, bottomMenu: true, viewSwitch: false, zoneWidth: 32}}));
    const view = render390({log: []});
    expect(claimed().at(-1)).toEqual({left: true, right: false, zoneDp: 32});
    view.unmount();
    expect(claimed().at(-1)).toMatchObject({left: false, right: false});
  });
  it('claims nothing when the gestures are off or in a plain browser', () => {
    render390({log: [], enabled: false});
    expect(claimed()).toEqual([]);
    cleanup(); vi.mocked(isTauri).mockReturnValue(false);
    render390({log: []});
    expect(claimed()).toEqual([]);
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
    sink.className = 'xterm-helper-textarea';
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

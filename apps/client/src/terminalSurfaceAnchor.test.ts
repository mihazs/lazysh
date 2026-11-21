// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({invoke}));

import {rgbOf, SETTLE_FRAMES, trackSurfaceAnchor} from './terminalSurfaceAnchor';

/** Frames the tracker asked for, run by hand so a test decides when the page "paints". */
function frames() {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    frame: (callback: () => void) => { queue.set(next, callback); return next++; },
    cancelFrame: (handle: number) => { queue.delete(handle); },
    pending: () => queue.size,
    /** Runs every frame asked for so far, then returns how many ran. */
    async step() {
      const run = [...queue.values()];
      queue.clear();
      run.forEach(callback => callback());
      await Promise.resolve();
      await Promise.resolve();
      return run.length;
    },
    async settle(limit = 100) { let ran = 0; while (queue.size && ran < limit) { await this.step(); ran += 1; } return ran; },
  };
}

function element(rect: {x: number; y: number; width: number; height: number}) {
  const div = document.createElement('div');
  document.body.append(div);
  const box = {...rect};
  div.getBoundingClientRect = () => ({...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON() {}}) as DOMRect;
  return {div, move: (next: Partial<typeof box>) => Object.assign(box, next)};
}

const commands = () => invoke.mock.calls.map(([name, args]) => [name, args.session, args.anchor] as const);
const names = () => commands().map(([name]) => name);
const PLACE = 'native_terminal_surface_place';
const REMOVE = 'native_terminal_surface_remove';

/** A tracked element on a page whose frames the test runs by hand. `nudge` moves the element and tells the page, as a scroll would. */
function scene(rect = {x: 0, y: 0, width: 100, height: 100}, onError = vi.fn()) {
  const f = frames();
  const {div, move} = element(rect);
  const tracker = trackSurfaceAnchor({session: 's1', element: div, background: () => 0x102030, onError, frame: f.frame, cancelFrame: f.cancelFrame});
  const nudge = async (patch: Partial<typeof rect>, settle = true) => { move(patch); window.dispatchEvent(new Event('scroll')); if (settle) await f.settle(); };
  return {f, tracker, nudge, onError};
}

describe('rgbOf', () => {
  it('reads the colours a pane can have and refuses what it cannot', () => {
    expect(rgbOf('#102030')).toBe(0x102030);
    expect(rgbOf('#abc')).toBe(0xaabbcc);
    expect(rgbOf('rgb(16, 32, 48)')).toBe(0x102030);
    expect(rgbOf('rgba(16 32 48 / 0.5)')).toBe(0x102030);
    expect(rgbOf('rgb(16, 32, 300)')).toBeUndefined();
    expect(rgbOf('red')).toBeUndefined();
    expect(rgbOf('linear-gradient(red, blue)')).toBeUndefined();
  });
});

describe('trackSurfaceAnchor', () => {
  beforeEach(() => { invoke.mockReset(); invoke.mockResolvedValue({placed: true, ready: true, generation: 1, width: 1, height: 1}); });
  afterEach(() => { document.body.replaceChildren(); });

  it('places the element once and then stops looking while the page is idle', async () => {
    const {f, tracker} = scene({x: 10, y: 20, width: 300, height: 200});
    const ran = await f.settle();
    expect(commands()).toEqual([[PLACE, 's1', {x: 10, y: 20, width: 300, height: 200, dpr: window.devicePixelRatio}]]);
    expect(invoke.mock.calls[0][1].background).toBe(0x102030);
    expect(ran).toBeLessThanOrEqual(SETTLE_FRAMES + 3);
    expect(f.pending()).toBe(0);
    await tracker.stop();
  });

  it('sends the rectangle again, once, when the element moves after a hint', async () => {
    const {f, tracker, nudge} = scene();
    await f.settle();
    await nudge({y: 40, height: 60});
    expect(commands().map(([, , anchor]) => anchor?.y)).toEqual([0, 40]);
    await tracker.stop();
  });

  it('keeps one command in flight and sends only the latest rectangle when several moves pile up', async () => {
    let release: () => void = () => {};
    invoke.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
    const {f, tracker, nudge} = scene();
    await f.step();
    await nudge({x: 5}, false);
    await f.step();
    await nudge({x: 9}, false);
    await f.step();
    expect(invoke).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await f.settle();
    expect(commands().map(([, , anchor]) => anchor?.x)).toEqual([0, 9]);
    await tracker.stop();
  });

  it('ends the surface when the element has no box and places it again when it has one', async () => {
    const {f, tracker, nudge} = scene();
    await f.settle();
    await nudge({width: 0});
    await nudge({width: 80});
    expect(names()).toEqual([PLACE, REMOVE, PLACE]);
    await tracker.stop();
  });

  it('stops tracking and reports a refusal from the shell', async () => {
    invoke.mockRejectedValueOnce('native_surface_disabled');
    const {f, nudge, onError} = scene();
    await f.settle();
    expect(onError).toHaveBeenCalledWith('native_surface_disabled');
    await nudge({x: 50});
    expect(names()).toEqual([PLACE, REMOVE]);
  });

  it('takes a surface it placed off the screen when a later placement fails', async () => {
    const {f, nudge, onError} = scene();
    await f.settle();
    invoke.mockRejectedValueOnce('boom');
    await nudge({x: 30});
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith('boom');
    expect(names()).toEqual([PLACE, PLACE, REMOVE]);
  });

  it('waits for the placement in flight before it removes the surface', async () => {
    let release: () => void = () => {};
    invoke.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({}); }));
    const {f, tracker} = scene();
    await f.step();
    const stopped = tracker.stop();
    await Promise.resolve();
    expect(names()).toEqual([PLACE]);
    release();
    await stopped;
    expect(names()).toEqual([PLACE, REMOVE]);
  });

  it('removes the surface on stop and ignores later hints', async () => {
    const {f, tracker, nudge} = scene();
    await f.settle();
    await tracker.stop();
    await nudge({x: 7});
    expect(names()).toEqual([PLACE, REMOVE]);
    await tracker.stop();
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

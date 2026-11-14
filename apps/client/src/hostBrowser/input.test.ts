import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameMetadata } from './cdp';
import { Gestures, keyMessage, noZoom, type InputMessage, type Zoom } from './input';

const frame: FrameMetadata = { deviceWidth: 390, deviceHeight: 700, offsetTop: 0, timestamp: 0 };

/** Gestures on a frame shown at `size`, with what they send and every zoom they show. */
function rig(size = { width: 390, height: 700 }, metadata: FrameMetadata = frame) {
  const sent: InputMessage[] = [];
  const zooms: Zoom[] = [];
  const gestures = new Gestures({ surface: () => ({ size, frame: metadata }), send: message => sent.push(message), zoomed: zoom => zooms.push(zoom) });
  return { gestures, sent, zooms };
}
const pointer = (kind: 'move' | 'press' | 'release', x: number, y: number, button: 'none' | 'left' | 'right' = 'none', clickCount = 0): InputMessage => ({ type: 'pointer', kind, x, y, button, clickCount });
const click = (x: number, y: number, button: 'left' | 'right', clickCount: number) => [pointer('move', x, y), pointer('press', x, y, button, clickCount), pointer('release', x, y, button, clickCount)];

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('tap', () => {
  it('is a mouse move, press and release at the page pixel under the finger', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 195, y: 350 });
    expect(sent).toEqual([]);
    gestures.up(1, 100);
    expect(sent).toEqual(click(195, 350, 'left', 1));
  });

  it('maps through the size the frame is shown at and the frame offset', () => {
    const { gestures, sent } = rig({ width: 780, height: 1400 }, { ...frame, offsetTop: 10 });
    gestures.down(1, { x: 390, y: 700 });
    gestures.up(1, 100);
    expect(sent).toEqual(click(195, 340, 'left', 1));
  });

  it('is a double click when the next tap is within 300 ms and 10 px, and a third tap starts over', () => {
    const { gestures, sent } = rig();
    const tap = (id: number, x: number, time: number) => { gestures.down(id, { x, y: 100 }); gestures.up(id, time); };
    tap(1, 100, 1000);
    tap(2, 105, 1250);
    tap(3, 105, 1400);
    expect(sent.filter(message => message.type === 'pointer' && message.kind === 'press').map(message => (message as { clickCount: number }).clickCount)).toEqual([1, 2, 1]);
  });

  it('is two single clicks when the second tap is late or far from the first', () => {
    const late = rig();
    for (const [id, time] of [[1, 1000], [2, 1301]]) { late.gestures.down(id, { x: 50, y: 50 }); late.gestures.up(id, time); }
    const far = rig();
    for (const [id, x, time] of [[1, 50, 1000], [2, 70, 1100]]) { far.gestures.down(id, { x, y: 50 }); far.gestures.up(id, time); }
    for (const { sent } of [late, far]) expect(sent.filter(message => message.type === 'pointer' && message.kind === 'press').map(message => (message as { clickCount: number }).clickCount)).toEqual([1, 1]);
  });

  it('sends nothing for a cancelled touch', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 10, y: 10 });
    gestures.up(1, 100, true);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });
});

describe('long press', () => {
  it('is a right click after 500 ms, and lifting the finger sends nothing more', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 120, y: 240 });
    vi.advanceTimersByTime(499);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual(click(120, 240, 'right', 1));
    gestures.up(1, 600);
    expect(sent).toHaveLength(3);
  });

  it('is cancelled by a move past the slop, which scrolls instead', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 120, y: 240 });
    vi.advanceTimersByTime(100);
    gestures.move(1, { x: 120, y: 200 });
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([{ type: 'wheel', x: 120, y: 240, deltaX: 0, deltaY: 40 }]);
  });

  it('survives a small wobble', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 120, y: 240 });
    gestures.move(1, { x: 125, y: 244 });
    vi.advanceTimersByTime(500);
    expect(sent).toEqual(click(125, 244, 'right', 1));
  });
});

describe('one-finger drag', () => {
  it('scrolls by the finger travel in page pixels, as one wheel event per frame interval at the first touch point', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 200, y: 500 });
    gestures.move(1, { x: 200, y: 490 });
    gestures.move(1, { x: 200, y: 470 });
    gestures.move(1, { x: 190, y: 450 });
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(16);
    expect(sent).toEqual([{ type: 'wheel', x: 200, y: 500, deltaX: 10, deltaY: 50 }]);
    gestures.move(1, { x: 190, y: 470 });
    vi.advanceTimersByTime(16);
    expect(sent.at(-1)).toEqual({ type: 'wheel', x: 200, y: 500, deltaX: 0, deltaY: -20 });
  });

  it('sends the rest of the travel when the finger lifts, and never clicks', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 200, y: 500 });
    gestures.move(1, { x: 200, y: 400 });
    gestures.up(1, 100);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([{ type: 'wheel', x: 200, y: 500, deltaX: 0, deltaY: 100 }]);
  });

  it('converts displayed pixels to page pixels', () => {
    const { gestures, sent } = rig({ width: 780, height: 1400 });
    gestures.down(1, { x: 400, y: 1000 });
    gestures.move(1, { x: 400, y: 800 });
    gestures.up(1, 100);
    expect(sent).toEqual([{ type: 'wheel', x: 200, y: 500, deltaX: 0, deltaY: 100 }]);
  });
});

describe('select', () => {
  it('turns a drag into a mouse drag from the touch point to where the finger lifts', () => {
    const { gestures, sent } = rig();
    gestures.selecting = true;
    gestures.down(1, { x: 100, y: 200 });
    gestures.move(1, { x: 150, y: 220 });
    gestures.up(1, 100);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([
      pointer('move', 100, 200), pointer('press', 100, 200, 'left', 1),
      pointer('move', 150, 220, 'left'), pointer('release', 150, 220, 'left', 1),
    ]);
  });
});

describe('pinch', () => {
  const spread = (gestures: Gestures) => {
    gestures.down(1, { x: 150, y: 350 });
    gestures.down(2, { x: 240, y: 350 });
    gestures.move(1, { x: 105, y: 350 });
    gestures.move(2, { x: 285, y: 350 });
  };

  it('zooms the displayed frame at once, keeps what was under the fingers there, and sends nothing', () => {
    const { gestures, sent, zooms } = rig();
    spread(gestures);
    expect(zooms.at(-1)).toEqual({ scale: 2, x: -195, y: -350 });
    gestures.up(1, 100);
    gestures.up(2, 100);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it('sends the page scale only when it is committed, and then shows the frame unzoomed', () => {
    const { gestures, sent, zooms } = rig();
    spread(gestures);
    gestures.up(1, 100);
    gestures.up(2, 100);
    gestures.commit();
    expect(sent).toEqual([{ type: 'pinch', scale: 2 }]);
    expect(zooms.at(-1)).toEqual(noZoom);
    gestures.commit();
    expect(sent).toHaveLength(1);
  });

  it('builds on the page scale the browser reports and stays within what the browser takes', () => {
    const { gestures, sent } = rig(undefined, { ...frame, pageScaleFactor: 2 });
    gestures.down(1, { x: 190, y: 350 });
    gestures.down(2, { x: 200, y: 350 });
    gestures.move(1, { x: 0, y: 350 });
    gestures.move(2, { x: 390, y: 350 });
    expect(gestures.zoom.scale).toBe(2.5);
    gestures.commit();
    expect(sent).toEqual([{ type: 'pinch', scale: 5 }]);
  });

  it('maps a tap while zoomed through the zoom, and a one-finger drag pans instead of scrolling', () => {
    const { gestures, sent, zooms } = rig();
    spread(gestures);
    gestures.up(1, 100);
    gestures.up(2, 100);
    gestures.down(3, { x: 5, y: 10 });
    gestures.up(3, 200);
    expect(sent).toEqual(click(100, 180, 'left', 1));
    sent.length = 0;
    gestures.down(4, { x: 200, y: 300 });
    gestures.move(4, { x: 170, y: 300 });
    gestures.up(4, 300);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(zooms.at(-1)).toEqual({ scale: 2, x: -225, y: -350 });
    gestures.down(5, { x: 0, y: 300 });
    gestures.move(5, { x: 800, y: 300 });
    expect(zooms.at(-1)?.x).toBe(0);
  });

  it('does not click or scroll when the fingers lift, and ignores the finger left behind and a third one', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 150, y: 350 });
    gestures.down(2, { x: 240, y: 350 });
    gestures.down(3, { x: 10, y: 10 });
    gestures.up(3, 50);
    gestures.up(1, 100);
    gestures.move(2, { x: 240, y: 100 });
    gestures.up(2, 200);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it('turns a drag already under way into a pinch without losing the travel so far', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 150, y: 500 });
    gestures.move(1, { x: 150, y: 450 });
    gestures.down(2, { x: 250, y: 500 });
    expect(sent).toEqual([{ type: 'wheel', x: 150, y: 500, deltaX: 0, deltaY: 50 }]);
  });
});

describe('reset', () => {
  it('drops the touches, the pending wheel and the long press', () => {
    const { gestures, sent } = rig();
    gestures.down(1, { x: 100, y: 100 });
    gestures.move(1, { x: 100, y: 50 });
    gestures.reset();
    gestures.down(2, { x: 100, y: 100 });
    gestures.reset();
    vi.advanceTimersByTime(1000);
    gestures.up(1, 100);
    gestures.up(2, 100);
    expect(sent).toEqual([]);
  });
});

describe('key messages', () => {
  const event = (key: string, flags: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altGraph: boolean }> = {}) =>
    keyMessage({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...flags, getModifierState: name => name === 'AltGraph' && !!flags.altGraph });

  it('sends the keys that are not text, with their modifiers', () => {
    for (const key of ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowLeft', 'Home', 'End', 'PageDown', 'Delete'])
      expect(event(key), key).toEqual({ type: 'key', key, modifiers: 0 });
    expect(event('Tab', { shiftKey: true })).toEqual({ type: 'key', key: 'Tab', modifiers: 8 });
    expect(event('ArrowRight', { ctrlKey: true, shiftKey: true })).toEqual({ type: 'key', key: 'ArrowRight', modifiers: 10 });
  });

  it('sends Control and Meta chords of a letter or digit, and leaves text to the keyboard field', () => {
    expect(event('a', { ctrlKey: true })).toEqual({ type: 'key', key: 'a', modifiers: 2 });
    expect(event('z', { metaKey: true, shiftKey: true })).toEqual({ type: 'key', key: 'z', modifiers: 12 });
    expect(event('1', { ctrlKey: true })).toEqual({ type: 'key', key: '1', modifiers: 2 });
    for (const text of ['a', 'é', 'A', '😀', ' ', 'Process', 'Unidentified', 'Shift', 'Dead']) expect(event(text), text).toBeUndefined();
    expect(event('é', { ctrlKey: true })).toBeUndefined();
    expect(event('a', { altKey: true })).toBeUndefined();
  });

  it('never sends the clipboard chords, because the clipboard stays off', () => {
    for (const key of ['c', 'x', 'v', 'C', 'X', 'V']) {
      expect(event(key, { ctrlKey: true }), `ctrl ${key}`).toBeUndefined();
      expect(event(key, { metaKey: true }), `meta ${key}`).toBeUndefined();
    }
    expect(event('Delete', { shiftKey: true })).toBeUndefined();
    expect(event('Delete')).toBeDefined();
  });

  it('treats AltGr, which a keyboard reports as Control and Alt, as text', () => {
    expect(event('@', { ctrlKey: true, altKey: true, altGraph: true })).toBeUndefined();
    expect(event('q', { ctrlKey: true, altKey: true, altGraph: true })).toBeUndefined();
  });
});

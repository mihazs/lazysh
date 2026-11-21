import { pagePoint, specialKey, type FrameMetadata } from './cdp';

/**
 * What the phone sends to the host browser while Control is on (docs/host-browser.md, "Input mapping"): a closed set of
 * messages, in page CSS pixels. The phone never sends a protocol command; `inputCommands` in cdp.ts and the relay map
 * these onto the browser's input methods.
 */
export type InputMessage =
  | { type: 'pointer'; kind: 'move' | 'press' | 'release'; x: number; y: number; button: 'none' | 'left' | 'right'; clickCount: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'pinch'; scale: number }
  | { type: 'key'; key: string; modifiers: number }
  | { type: 'text'; text: string };

export const LONG_PRESS_MS = 500;
export const DOUBLE_TAP_MS = 300;
/** A touch that stays this close to where it landed (displayed pixels) is a tap or a press, not a drag. */
export const SLOP_PX = 10;
/** Wheel events are sent at most this often, so a drag costs one message per frame, not one per pointer event. */
export const WHEEL_MS = 16;
/** The range of page scale the browser takes. */
export const PAGE_SCALE = { min: 1, max: 5 };

type Point = { x: number; y: number };
type Size = { width: number; height: number };
/** The frame as displayed (its size on screen) and what the browser said about it. */
export type Surface = { size: Size; frame: FrameMetadata };

/** A local zoom of the displayed frame: a point of the frame lands at `frame * scale + (x, y)` on screen. */
export type Zoom = { scale: number; x: number; y: number };
export const noZoom: Zoom = { scale: 1, x: 0, y: 0 };

const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/** Keeps a zoomed-in frame covering the view, and a zoomed-out one centred. */
function settle(zoom: Zoom, size: Size): Zoom {
  const place = (offset: number, extent: number) => (zoom.scale >= 1 ? clamp(offset, extent * (1 - zoom.scale), 0) : (extent * (1 - zoom.scale)) / 2);
  return { scale: zoom.scale, x: place(zoom.x, size.width), y: place(zoom.y, size.height) };
}
/** The point of the displayed frame under a point of the screen. */
const unzoom = (point: Point, zoom: Zoom): Point => ({ x: (point.x - zoom.x) / zoom.scale, y: (point.y - zoom.y) / zoom.scale });

type Mode = 'idle' | 'pending' | 'scroll' | 'pan' | 'select' | 'held' | 'pinch' | 'spent';

/**
 * Turns pointer events on the displayed frame into input messages and a local zoom. It sees every touch and decides
 * nothing about Control: whoever owns the switch gates `host.send`.
 *
 * - Tap: a mouse move, press and release (click count 2 within 300 ms and 10 px of the last tap).
 * - Hold for 500 ms without moving: a right click, because a held touch produced no context menu in Chromium.
 * - One-finger drag: wheel events coalesced to the frame rate. They carry the finger's travel in page pixels; where
 *   the page is comes from the frame's scroll offset, never from the sum of the deltas (smooth scrolling does not
 *   move 1:1).
 * - With `selecting`, a drag is a mouse drag instead.
 * - Two-finger pinch: zooms the displayed frame at once, locally. `commit` turns it into the page's scale.
 *   While zoomed in, a one-finger drag pans the zoomed frame.
 */
export class Gestures {
  /** Whether a drag selects (a mouse drag) instead of scrolling. */
  selecting = false;
  zoom: Zoom = noZoom;
  private touches = new Map<number, { start: Point; at: Point }>();
  private mode: Mode = 'idle';
  private hold?: ReturnType<typeof setTimeout>;
  private flush?: ReturnType<typeof setTimeout>;
  private wheel = { x: 0, y: 0, anchor: { x: 0, y: 0 } };
  private lastTap?: { at: Point; time: number };
  private pinch?: { distance: number; zoom: Zoom; content: Point };

  constructor(private host: { surface(): Surface; send(message: InputMessage): void; zoomed(zoom: Zoom): void }) {}

  private page(at: Point) {
    const { size, frame } = this.host.surface();
    const shown = unzoom(at, this.zoom);
    return pagePoint({ x: shown.x / size.width, y: shown.y / size.height }, frame);
  }

  private mouse(kind: 'move' | 'press' | 'release', point: Point, button: 'none' | 'left' | 'right' = 'none', clickCount = 0) {
    this.host.send({ type: 'pointer', kind, x: point.x, y: point.y, button, clickCount });
  }

  private click(at: Point, button: 'left' | 'right', clickCount: number) {
    const point = this.page(at);
    this.mouse('move', point);
    this.mouse('press', point, button, clickCount);
    this.mouse('release', point, button, clickCount);
  }

  private setZoom(zoom: Zoom) {
    this.zoom = settle(zoom, this.host.surface().size);
    this.host.zoomed(this.zoom);
  }

  down(id: number, at: Point) {
    // A third finger is ignored.
    if (this.touches.size >= 2) return;
    this.touches.set(id, { start: at, at });
    if (this.touches.size === 2) return this.startPinch();
    if (this.selecting) {
      this.mode = 'select';
      this.mouse('move', this.page(at));
      this.mouse('press', this.page(at), 'left', 1);
    } else {
      this.mode = 'pending';
      this.hold = setTimeout(() => this.longPress(id), LONG_PRESS_MS);
    }
  }

  move(id: number, at: Point) {
    const touch = this.touches.get(id);
    if (!touch) return;
    let from = touch.at;
    touch.at = at;
    if (this.mode === 'pending') {
      if (distance(touch.start, at) <= SLOP_PX) return;
      clearTimeout(this.hold);
      this.mode = this.zoom.scale > 1 ? 'pan' : 'scroll';
      from = touch.start;
      this.wheel.anchor = this.page(touch.start);
    }
    if (this.mode === 'scroll') {
      this.wheel.x += from.x - at.x;
      this.wheel.y += from.y - at.y;
      this.flush ??= setTimeout(() => this.flushWheel(), WHEEL_MS);
    } else if (this.mode === 'pan') {
      this.setZoom({ ...this.zoom, x: this.zoom.x + at.x - from.x, y: this.zoom.y + at.y - from.y });
    } else if (this.mode === 'select') {
      this.mouse('move', this.page(at), 'left');
    } else if (this.mode === 'pinch') {
      this.pinchTo();
    }
  }

  up(id: number, time: number, cancelled = false) {
    const touch = this.touches.get(id);
    if (!touch) return;
    this.touches.delete(id);
    const mode = this.mode;
    if (mode === 'pinch') {
      this.mode = this.touches.size ? 'spent' : 'idle';
      return;
    }
    if (this.touches.size) return;
    clearTimeout(this.hold);
    this.mode = 'idle';
    if (mode === 'pending' && !cancelled) this.tap(touch.at, time);
    else if (mode === 'scroll') this.flushWheel();
    else if (mode === 'select') this.mouse('release', this.page(touch.at), 'left', 1);
  }

  private tap(at: Point, time: number) {
    const again = this.lastTap && time - this.lastTap.time <= DOUBLE_TAP_MS && distance(this.lastTap.at, at) <= SLOP_PX;
    this.lastTap = again ? undefined : { at, time };
    this.click(at, 'left', again ? 2 : 1);
  }

  private longPress(id: number) {
    const touch = this.touches.get(id);
    if (!touch || this.mode !== 'pending') return;
    this.mode = 'held';
    this.click(touch.at, 'right', 1);
  }

  private flushWheel() {
    clearTimeout(this.flush);
    this.flush = undefined;
    const { x, y, anchor } = this.wheel;
    this.wheel = { x: 0, y: 0, anchor };
    if (!x && !y) return;
    const { size, frame } = this.host.surface();
    // Displayed pixels to page pixels.
    const factor = frame.deviceWidth / (size.width * this.zoom.scale);
    this.host.send({ type: 'wheel', x: anchor.x, y: anchor.y, deltaX: x * factor, deltaY: y * factor });
  }

  private startPinch() {
    clearTimeout(this.hold);
    // A finger already scrolling or selecting hands over to the pinch; a drag in progress ends where it is.
    if (this.mode === 'scroll') this.flushWheel();
    if (this.mode === 'select') {
      const [first] = [...this.touches.values()];
      this.mouse('release', this.page(first.at), 'left', 1);
    }
    this.mode = 'pinch';
    const [a, b] = [...this.touches.values()];
    this.pinch = { distance: Math.max(1, distance(a.at, b.at)), zoom: this.zoom, content: unzoom(midpoint(a.at, b.at), this.zoom) };
  }

  private pinchTo() {
    const [a, b] = [...this.touches.values()];
    const start = this.pinch!;
    const pageScale = this.host.surface().frame.pageScaleFactor ?? 1;
    const scale = clamp(start.zoom.scale * (distance(a.at, b.at) / start.distance), PAGE_SCALE.min / pageScale, PAGE_SCALE.max / pageScale);
    const centre = midpoint(a.at, b.at);
    // The part of the frame that was under the fingers stays under them, so a moving pinch also pans.
    this.setZoom({ scale, x: centre.x - start.content.x * scale, y: centre.y - start.content.y * scale });
  }

  /** Makes the local zoom the page's scale and shows the frame as it is again. */
  commit() {
    if (this.zoom.scale === 1) return;
    const pageScale = this.host.surface().frame.pageScaleFactor ?? 1;
    this.host.send({ type: 'pinch', scale: Math.round(clamp(pageScale * this.zoom.scale, PAGE_SCALE.min, PAGE_SCALE.max) * 100) / 100 });
    this.setZoom(noZoom);
  }

  /** Forgets every touch and pending timer, as when Control goes off or the view goes away. */
  reset() {
    clearTimeout(this.hold);
    clearTimeout(this.flush);
    this.flush = undefined;
    this.touches.clear();
    this.mode = 'idle';
    this.wheel = { x: 0, y: 0, anchor: this.wheel.anchor };
    this.lastTap = undefined;
  }
}

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
/** Editing shortcuts that move the clipboard. Clipboard stays off, so they are never sent. */
const clipboardChord = (key: string, ctrlOrMeta: boolean, shift: boolean) => (ctrlOrMeta && /^[cxv]$/i.test(key)) || (shift && key === 'Delete');

type KeyEventLike = { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; getModifierState(name: string): boolean };

/**
 * The key message for a key press, or nothing when the press is text: printable text and IME composition go through
 * the keyboard field as `text`, so accents, emoji and composed characters arrive as typed. Keys that are not text (Enter,
 * Backspace, Tab, arrows, Escape, Home, End, Page keys, Delete) and Control or Meta chords with a letter or digit are keys.
 */
export function keyMessage(event: KeyEventLike): InputMessage | undefined {
  const modifiers = (event.altKey ? MODIFIERS.alt : 0) | (event.ctrlKey ? MODIFIERS.ctrl : 0) | (event.metaKey ? MODIFIERS.meta : 0) | (event.shiftKey ? MODIFIERS.shift : 0);
  const chord = (event.ctrlKey || event.metaKey) && !event.getModifierState('AltGraph') && /^[a-z0-9]$/i.test(event.key);
  if (!specialKey(event.key) && !chord) return undefined;
  if (clipboardChord(event.key, event.ctrlKey || event.metaKey, event.shiftKey)) return undefined;
  return { type: 'key', key: event.key, modifiers };
}

/**
 * Pointer selection on the native adapter's anchor (#1334). The native surface has an empty input region on purpose, so the
 * page owns every gesture: a mouse drag selects, a double click takes the word, a triple click the line, shift-click extends,
 * and a still finger held for {@link TOUCH_SELECTION_DELAY} then lifted selects the word (a later hold extends it), as the
 * xterm.js pane does. The selection is the adapter's; copying reads `selectedText()` through the pane's clipboard path.
 */
import type {NativeTerminalAdapter} from './nativeTerminalAdapter';
import type {Disposable, TerminalCell} from './terminalAdapter';
import {nextTouchSelection, rangeBetween, TOUCH_SELECTION_DELAY, type TouchSelection} from './terminalTouchSelection';

/** Pixels a held finger may drift before it is a scroll, not a long press. */
const TOUCH_SLOP = 10;
/** Longest a finger may rest and still be a click. */
const TAP_MS = 500;
const earlier = (a: TerminalCell, b: TerminalCell) => a.y < b.y || (a.y === b.y && a.x < b.x);
const same = (a: TerminalCell, b: TerminalCell) => a.x === b.x && a.y === b.y;

export function attachPointerSelection(adapter: NativeTerminalAdapter, anchor: HTMLElement): Disposable {
  let drag: TerminalCell | undefined, hold: {x: number; y: number; ready: boolean; timer: ReturnType<typeof setTimeout>} | undefined;
  let touched: TouchSelection | null = null;
  const cancelHold = () => { if (hold) clearTimeout(hold.timer); hold = undefined; };
  // A program that tracks the mouse owns it.
  const free = () => adapter.modes().mouseTracking === 'none';

  // A program that tracks the mouse owns it: a mouse's button, drag and release, and a finger's tap, go to it as reports.
  const buttons = ['left', 'middle', 'right'] as const;
  let reported: {id: number; button: typeof buttons[number]; touch: boolean; x: number; y: number; moved: boolean; at: number} | undefined;
  const report = {
    down(event: PointerEvent) {
      const touch = event.pointerType === 'touch', button = buttons[event.button] ?? 'left';
      reported = {id: event.pointerId, button, touch, x: event.clientX, y: event.clientY, moved: false, at: Date.now()};
      if (!touch) adapter.reportMouse('press', button, event.clientX, event.clientY);
    },
    move(event: PointerEvent) {
      const now = reported;
      if (!now || now.id !== event.pointerId) return;
      if (Math.hypot(event.clientX - now.x, event.clientY - now.y) > TOUCH_SLOP) now.moved = true;
      const level = adapter.modes().mouseTracking;
      if (!now.touch && (level === 'drag' || level === 'any')) adapter.reportMouse('motion', now.button, event.clientX, event.clientY);
    },
    up(event: PointerEvent) {
      const now = reported;
      reported = undefined;
      if (!now || now.id !== event.pointerId) return;
      // A finger that stayed put and lifted quickly is a click; one that moved was a scroll, which the pane turns into wheel reports.
      if (now.touch && (now.moved || Date.now() - now.at > TAP_MS)) return;
      if (now.touch) adapter.reportMouse('press', now.button, now.x, now.y);
      adapter.reportMouse('release', now.button, event.clientX, event.clientY);
    },
  };

  const down = (event: PointerEvent) => {
    if (!free()) { report.down(event); return; }
    if (event.pointerType === 'mouse' || !event.pointerType) {
      if (event.button !== 0) return;
      const cell = adapter.cellAt(event.clientX, event.clientY);
      if (!cell) return;
      if (event.detail >= 3) { adapter.select(adapter.selectLineAt(cell.y)); drag = undefined; return; }
      if (event.detail === 2) { adapter.select(adapter.selectWordAt(cell)); drag = undefined; return; }
      const current = adapter.selectionRange();
      if (event.shiftKey && current) {
        // The end farther from the click stays fixed.
        drag = earlier(cell, current.start) ? current.end : earlier(current.end, cell) ? current.start : same(current.start, cell) ? current.end : current.start;
        adapter.select(rangeBetween(drag, cell));
      } else { adapter.clearSelection(); drag = cell; }
      try { anchor.setPointerCapture?.(event.pointerId); } catch { /* a synthetic pointer has nothing to capture */ }
      return;
    }
    cancelHold();
    const pending = {x: event.clientX, y: event.clientY, ready: false, timer: setTimeout(() => { pending.ready = true; }, TOUCH_SELECTION_DELAY)};
    hold = pending;
  };

  const move = (event: PointerEvent) => {
    if (reported) { report.move(event); return; }
    if (hold) {
      if (Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > TOUCH_SLOP) cancelHold();
      return;
    }
    if (!drag) return;
    const cell = adapter.cellAt(event.clientX, event.clientY);
    if (cell && !(same(cell, drag) && !adapter.hasSelection())) adapter.select(rangeBetween(drag, cell));
  };

  const up = (event: PointerEvent) => {
    if (reported) { report.up(event); return; }
    drag = undefined;
    if (!hold) return;
    const {ready, x, y} = hold, cell = ready && free() ? adapter.cellAt(x, y) : undefined;
    cancelHold();
    if (cell) {
      touched = nextTouchSelection(touched && adapter.hasSelection() ? touched : null, adapter.selectWordAt(cell));
      adapter.select(touched.range);
    } else if (touched && adapter.hasSelection()) { adapter.clearSelection(); touched = null; }
  };

  // The platform's long-press menu would compete with the selection.
  const menu = (event: Event) => { if (hold) event.preventDefault(); };
  const listeners: [string, (event: never) => void][] = [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up], ['contextmenu', menu]];
  for (const [type, listener] of listeners) anchor.addEventListener(type, listener as EventListener);
  return {dispose: () => { cancelHold(); for (const [type, listener] of listeners) anchor.removeEventListener(type, listener as EventListener); }};
}

/**
 * Opening links by tap on the native adapter's anchor (#1320). The page owns every gesture over a native surface, so a tap (or a
 * plain click) is read here: the cell under it is asked of the core, which says what link, if any, is drawn there (an OSC 8
 * hyperlink, a URL, a host path), and the pane's handlers take it from there with the consent flow xterm.js has.
 */
import type {NativeCoreLink} from './nativeCoreBridge';
import type {NativeTerminalAdapter} from './nativeTerminalAdapter';
import type {Disposable, TerminalAdapter, TerminalCell} from './terminalAdapter';
import type {PathLink} from './terminalLinks';
import {TOUCH_SELECTION_DELAY} from './terminalTouchSelection';

export type LinkHandlers = Parameters<TerminalAdapter['registerLinks']>[0];

/** Pixels a pointer may drift between going down and up and still be a tap. */
const TAP_SLOP = 10;

/** A path as the xterm.js backend hands it over: 1-based cells, as its link ranges are. */
const pathLink = (link: Extract<NativeCoreLink, {kind: 'path'}>): PathLink => {
  const {text, path, line, column, range: {start, end}} = link;
  return {text, path, line, column, range: {start: {x: start.x + 1, y: start.y + 1}, end: {x: end.x + 1, y: end.y + 1}}};
};

export function attachLinkTaps(adapter: NativeTerminalAdapter, anchor: HTMLElement, handlers: LinkHandlers): Disposable {
  let press: {id: number; x: number; y: number; at: number} | undefined;
  let touchCell: TerminalCell | undefined;
  let live = true;
  const down = (event: PointerEvent) => {
    touchCell = undefined;
    // The primary button or a finger, once and without a modifier (a double click selects a word, shift extends a selection), and never
    // over a program that tracks the mouse, which owns the pointer.
    const plain = (event.button === 0 || event.button === undefined) && event.detail <= 1 && !event.shiftKey && adapter.modes().mouseTracking === 'none';
    press = plain ? {id: event.pointerId, x: event.clientX, y: event.clientY, at: Date.now()} : undefined;
  };
  const up = (event: PointerEvent) => {
    const tap = press;
    press = undefined;
    // A hold is a selection, a drag is a scroll or a selection: neither opens a link.
    if (!tap || event.pointerId !== tap.id || Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > TAP_SLOP || Date.now() - tap.at >= TOUCH_SELECTION_DELAY) return;
    const cell = adapter.cellAt(event.clientX, event.clientY);
    if (event.pointerType === 'touch') touchCell = cell;
    else if (cell) void open(cell);
  };
  const click = (event: MouseEvent) => {
    const cell = touchCell;
    touchCell = undefined;
    // Let WebView target the touch's generated click before showing the consent buttons.
    if (cell && event.detail > 0) void open(cell);
  };
  const open = async (cell: TerminalCell) => {
    const link = await adapter.linkAt(cell).catch(() => undefined);
    if (!live || !link) return;
    if (link.kind === 'url') handlers.openUrl(link.uri);
    else if (handlers.hostPaths) {
      // Only a path the host confirms is a link, so prose that looks like one stays text.
      const found = pathLink(link);
      if (await handlers.hostPaths.exists(found).catch(() => false) && live) handlers.hostPaths.open(found);
    }
  };
  const cancel = () => { press = undefined; touchCell = undefined; };
  anchor.addEventListener('pointerdown', down as EventListener);
  anchor.addEventListener('pointerup', up as EventListener);
  anchor.addEventListener('pointercancel', cancel);
  anchor.addEventListener('click', click);
  return {dispose() {
    live = false; cancel();
    anchor.removeEventListener('pointerdown', down as EventListener);
    anchor.removeEventListener('pointerup', up as EventListener);
    anchor.removeEventListener('pointercancel', cancel);
    anchor.removeEventListener('click', click);
  }};
}

import type {TerminalCell, TerminalRange} from './terminalAdapter';

export type {TerminalCell, TerminalRange};

/** A still finger held this long, then lifted, selects the word beneath it. */
export const TOUCH_SELECTION_DELAY = 450;

const before = (a: TerminalCell, b: TerminalCell) => a.y < b.y || (a.y === b.y && a.x < b.x);
const within = (range: TerminalRange, cell: TerminalCell) => !before(cell, range.start) && !before(range.end, cell);

export type TouchSelection = {anchor: TerminalRange; range: TerminalRange};
/** A long-press inside the current selection starts over at that word; elsewhere it extends from the first word. */
export function nextTouchSelection(current: TouchSelection | null, word: TerminalRange): TouchSelection {
  if (!current || within(current.range, word.start)) return {anchor: word, range: word};
  const {anchor} = current;
  return {anchor, range: {start: before(word.start, anchor.start) ? word.start : anchor.start, end: before(anchor.end, word.end) ? word.end : anchor.end}};
}

/** xterm reports a selection end as the column after its last cell. */
export function inclusiveEnd(end: TerminalCell, cols: number): TerminalCell {
  return end.x > 0 ? {x: end.x - 1, y: end.y} : {x: cols - 1, y: Math.max(0, end.y - 1)};
}

/** The inclusive range between a fixed cell and a dragged one, in buffer order. */
export function rangeBetween(fixed: TerminalCell, moved: TerminalCell): TerminalRange {
  return before(moved, fixed) ? {start: moved, end: fixed} : {start: fixed, end: moved};
}

/** Pixels past the screen's top (negative) or bottom (positive) edge; 0 inside. */
export function edgeOverflow(y: number, top: number, bottom: number) {
  return y < top ? y - top : y > bottom ? y - bottom : 0;
}

/** Rows per second while a handle is held past an edge: faster the further past it. */
export function edgeScrollRate(overflow: number, rowHeight: number) {
  if (!overflow || !(rowHeight > 0)) return 0;
  return Math.sign(overflow) * Math.min(60, 4 + 16 * Math.abs(overflow) / rowHeight);
}

/**
 * Whole rows to scroll for one animation frame, carrying the fractional rest so
 * slow rates still advance smoothly. Elapsed time is capped so a stalled frame
 * cannot jump through history.
 */
export function edgeScrollStep(rate: number, elapsedMs: number, carry: number): {rows: number; carry: number} {
  if (!rate) return {rows: 0, carry: 0};
  const travel = carry + rate * Math.min(100, Math.max(0, elapsedMs)) / 1000;
  const rows = Math.trunc(travel);
  return {rows, carry: travel - rows};
}

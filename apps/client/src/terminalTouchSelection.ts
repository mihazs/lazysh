import type {Terminal} from '@xterm/xterm';

/** A buffer cell: `x` is a column, `y` an absolute buffer line. */
export type TerminalCell = {x: number; y: number};
export type TerminalRange = {start: TerminalCell; end: TerminalCell};

/** A still finger held this long, then lifted, selects the word beneath it. */
export const TOUCH_SELECTION_DELAY = 450;

export function terminalCellAt(terminal: Terminal, clientX: number, clientY: number): TerminalCell | undefined {
  const rect = terminal.element?.querySelector('.xterm-screen')?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || terminal.cols <= 0 || terminal.rows <= 0) return;
  const column = Math.floor((clientX - rect.left) / (rect.width / terminal.cols));
  const row = Math.floor((clientY - rect.top) / (rect.height / terminal.rows));
  if (!Number.isFinite(column) || !Number.isFinite(row)) return;
  return {x: Math.min(terminal.cols - 1, Math.max(0, column)), y: terminal.buffer.active.viewportY + Math.min(terminal.rows - 1, Math.max(0, row))};
}

function wordCell(terminal: Terminal, cell: TerminalCell): boolean {
  const value = terminal.buffer.active.getLine(cell.y)?.getCell(cell.x);
  // A wide character's trailing cell has no characters but belongs to its word.
  return !!value && (value.getWidth() === 0 || /\S/.test(value.getChars()));
}

/** The run of non-blank cells under the finger, or that single cell. Cells are never rewritten. */
export function terminalWordAt(terminal: Terminal, cell: TerminalCell): TerminalRange {
  if (!wordCell(terminal, cell)) return {start: cell, end: cell};
  let start = cell.x, end = cell.x;
  while (start > 0 && wordCell(terminal, {x: start - 1, y: cell.y})) start--;
  while (end < terminal.cols - 1 && wordCell(terminal, {x: end + 1, y: cell.y})) end++;
  return {start: {x: start, y: cell.y}, end: {x: end, y: cell.y}};
}

const before = (a: TerminalCell, b: TerminalCell) => a.y < b.y || (a.y === b.y && a.x < b.x);
const within = (range: TerminalRange, cell: TerminalCell) => !before(cell, range.start) && !before(range.end, cell);

export type TouchSelection = {anchor: TerminalRange; range: TerminalRange};
/** A long-press inside the current selection starts over at that word; elsewhere it extends from the first word. */
export function nextTouchSelection(current: TouchSelection | null, word: TerminalRange): TouchSelection {
  if (!current || within(current.range, word.start)) return {anchor: word, range: word};
  const {anchor} = current;
  return {anchor, range: {start: before(word.start, anchor.start) ? word.start : anchor.start, end: before(anchor.end, word.end) ? word.end : anchor.end}};
}

/** Selects the cells of a range, inclusive; xterm copies them as raw buffer text. */
export function selectTerminalRange(terminal: Terminal, {start, end}: TerminalRange) {
  terminal.select(start.x, start.y, (end.y - start.y) * terminal.cols + end.x - start.x + 1);
}

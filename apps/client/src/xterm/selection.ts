import type {Terminal} from '@xterm/xterm';
import type {TerminalCell, TerminalRange} from '../terminalAdapter';
import {findUrls} from '../terminalLinks';

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

function urlAt(terminal: Terminal, {x, y}: TerminalCell) {
  return findUrls(terminal.buffer.active, terminal.cols, y + 1).find(({range: {start, end}}) =>
    (y + 1 > start.y || x + 1 >= start.x) && (y + 1 < end.y || x + 1 <= end.x));
}

/** The selected text; a selection that is exactly one URL copies the URL, not the rows, borders and indentation around it. */
export function selectedTerminalText(terminal: Terminal): string {
  const position = terminal.hasSelection() ? terminal.getSelectionPosition() : undefined;
  if (position) {
    const last = position.end.x > 0 ? {x: position.end.x - 1, y: position.end.y} : {x: terminal.cols - 1, y: position.end.y - 1};
    const url = urlAt(terminal, position.start);
    if (url && url.range.start.x === position.start.x + 1 && url.range.start.y === position.start.y + 1
      && url.range.end.x === last.x + 1 && url.range.end.y === last.y + 1) return url.text;
  }
  return terminal.getSelection();
}

/** The run of non-blank cells under the finger, or that single cell. Cells are never rewritten. */
export function terminalWordAt(terminal: Terminal, cell: TerminalCell): TerminalRange {
  if (!wordCell(terminal, cell)) return {start: cell, end: cell};
  const url = urlAt(terminal, cell);
  if (url) return {start: {x: url.range.start.x - 1, y: url.range.start.y - 1}, end: {x: url.range.end.x - 1, y: url.range.end.y - 1}};
  let start = cell.x, end = cell.x;
  while (start > 0 && wordCell(terminal, {x: start - 1, y: cell.y})) start--;
  while (end < terminal.cols - 1 && wordCell(terminal, {x: end + 1, y: cell.y})) end++;
  return {start: {x: start, y: cell.y}, end: {x: end, y: cell.y}};
}

/** Selects the cells of a range, inclusive; xterm copies them as raw buffer text. */
export function selectTerminalRange(terminal: Terminal, {start, end}: TerminalRange) {
  terminal.select(start.x, start.y, (end.y - start.y) * terminal.cols + end.x - start.x + 1);
}

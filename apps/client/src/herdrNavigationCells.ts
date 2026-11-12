import type {Terminal} from '@xterm/xterm';

/** Herdr's phone layout switch button is this many columns wide, from the right edge. */
const buttonWidth = 10;

/**
 * Herdr draws its own navigation inside the terminal on a narrow screen: a "switch" button over the top two
 * rows at the right and, once opened, a full-screen switcher whose first row reads " switch" and ends in
 * "close". A tap on either moves between workspaces, tabs and panes; it is not a request to type, so it
 * must not raise the soft keyboard. `row` counts from the top of the visible screen.
 */
export function herdrNavigationCell(terminal: Terminal, column: number, row: number): boolean {
  const buffer = terminal.buffer.active;
  // Herdr paints its background with spaces, so a row ends in blanks rather than in its last word.
  const text = (y: number, start?: number, end?: number) => buffer.getLine(buffer.viewportY + y)?.translateToString(true, start, end).trimEnd() ?? '';
  if (/^ switch\b.*\bclose$/.test(text(0))) return true;
  return row <= 1 && column >= terminal.cols - buttonWidth && /\bswitch$/.test(text(1, terminal.cols - buttonWidth, terminal.cols));
}

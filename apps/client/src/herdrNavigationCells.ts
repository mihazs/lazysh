import type {Terminal} from '@xterm/xterm';

/** Herdr's phone layout switch button is this many columns wide, from the right edge. */
const buttonWidth = 10;

/**
 * Herdr draws its own navigation inside the terminal on a narrow screen: a "switch" button over the top two
 * rows at the right and, once opened, a full-screen switcher whose first row reads " switch" and ends in
 * "close". `top` is the buffer line of the screen's first row.
 */
function herdrChrome(terminal: Terminal, top: number): 'button' | 'switcher' | undefined {
  const buffer = terminal.buffer.active;
  // Herdr paints its background with spaces, so a row ends in blanks rather than in its last word.
  const text = (y: number, start?: number, end?: number) => buffer.getLine(top + y)?.translateToString(true, start, end)?.trimEnd() ?? '';
  if (/^ switch\b.*\bclose$/.test(text(0))) return 'switcher';
  if (/\bswitch$/.test(text(1, terminal.cols - buttonWidth, terminal.cols))) return 'button';
}

/**
 * Whether a tap at `column` and `row` (counted from the top of the visible screen) lands on that navigation.
 * It moves between workspaces, tabs and panes; it is not a request to type, so it must not raise the soft keyboard.
 */
export function herdrNavigationCell(terminal: Terminal, column: number, row: number): boolean {
  const chrome = herdrChrome(terminal, terminal.buffer.active.viewportY);
  return chrome === 'switcher' || (chrome === 'button' && row <= 1 && column >= terminal.cols - buttonWidth);
}

/** Whether Herdr's phone navigation is on the live screen, wherever the reader has scrolled to. */
export const herdrOnScreen = (terminal: Terminal) => herdrChrome(terminal, terminal.buffer.active.baseY) !== undefined;

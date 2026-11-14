import type {TerminalAdapter} from './terminalAdapter';

/** What Herdr detection reads: row text, the grid size and where the view sits. Never cells. */
export type HerdrScreen = Pick<TerminalAdapter, 'readRows' | 'size' | 'viewport'>;

/** Herdr's phone layout switch button is this many columns wide, from the right edge. */
const buttonWidth = 10;

/**
 * Herdr draws its own navigation inside the terminal on a narrow screen: a "switch" button over the top two
 * rows at the right and, once opened, a full-screen switcher whose first row reads " switch" and ends in
 * "close". `top` is the buffer line of the screen's first row.
 */
function herdrChrome(screen: HerdrScreen, top: number): 'button' | 'switcher' | undefined {
  // A backend that cannot inspect rows cannot show Herdr's navigation as such.
  if (!screen.readRows) return;
  const columns = screen.size().columns;
  // Herdr paints its background with spaces, so a row ends in blanks rather than in its last word.
  const text = (y: number, span?: {start: number; end: number}) => screen.readRows!(top + y, 1, span)[0] ?? '';
  if (/^ switch\b.*\bclose$/.test(text(0))) return 'switcher';
  if (/\bswitch$/.test(text(1, {start: columns - buttonWidth, end: columns}))) return 'button';
}

/**
 * Whether a tap at `column` and `row` (counted from the top of the visible screen) lands on that navigation.
 * It moves between workspaces, tabs and panes; it is not a request to type, so it must not raise the soft keyboard.
 */
export function herdrNavigationCell(screen: HerdrScreen, column: number, row: number): boolean {
  const chrome = herdrChrome(screen, screen.viewport().top);
  return chrome === 'switcher' || (chrome === 'button' && row <= 1 && column >= screen.size().columns - buttonWidth);
}

/** Whether Herdr's phone navigation is on the live screen, wherever the reader has scrolled to. */
export const herdrOnScreen = (screen: HerdrScreen) => {
  const {length, rows} = screen.viewport();
  // The live screen is the last `rows` rows of the buffer.
  return herdrChrome(screen, length - rows) !== undefined;
};

// East Asian wide and fullwidth characters and emoji presentation take two cells; this approximates the core's width table.
const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦\u{20000}-\u{3FFFD}\p{Emoji_Presentation}]/u;
const joins = /^[\p{M}‍️\u{1f3fb}-\u{1f3ff}]$/u;

/**
 * The cells of a row's text: one entry per column, '' for the second cell of a wide character, so a column
 * range slices the text the way the screen shows it. A row's text ends where its content does; later columns are blank.
 */
export function cellsOf(text: string): string[] {
  const cells: string[] = [];
  let leading = -1, joined = false;
  for (const char of text) {
    if (leading >= 0 && (joined || joins.test(char))) { cells[leading] += char; joined = char === '‍'; continue; }
    leading = cells.length; joined = false;
    cells.push(char);
    if (wide.test(char)) cells.push('');
  }
  return cells;
}

/** The text of columns `[start, end)` of a row, trimmed on the right. */
export function sliceColumns(text: string, start: number, end?: number): string {
  return cellsOf(text).slice(start, end).join('').trimEnd();
}

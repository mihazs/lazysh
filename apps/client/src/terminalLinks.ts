/** The slice of xterm's buffer the detector reads, so tests can supply synthetic screens. */
type Cell = {getChars(): string; getWidth(): number};
type Line = {readonly isWrapped: boolean; getCell(x: number): Cell | undefined};
export type Rows = {readonly length: number; getLine(y: number): Line | undefined};

/** One rendered character: a wide character is one glyph and its second cell is skipped. */
export type Glyph = {text: string; x: number; width: number; y: number};
/** Content bounds of a row as glyph indices, and where its usable width ends (a box border or the last column). */
type Span = {first: number; end: number; edge: number; border: boolean};
/** Soft-wrapped rows joined into one line of glyphs. `offset[i]` is the index of glyph `i` in `text`. */
export type Logical = {glyphs: Glyph[]; text: string; offset: number[]; head: Span; tail: Span};
export type UrlLink = {text: string; range: {start: {x: number; y: number}; end: {x: number; y: number}}};

const BORDER = '│┃║';
/** Rows examined around the requested one; a hard-wrapped URL rarely spans more than a handful. */
const WINDOW = 16;
const SOFT_LIMIT = 128;
// No lookbehind: the bundle targets Safari 15, which cannot parse one.
const URL_RE = /https?:\/\/[^\s<>"'`│┃║]+/gi;
const URL_TAIL = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const BULLET = /^(?:[-*+>]|\d{1,2}[.)])$/;
const OPENERS: Record<string, string> = {')': '(', ']': '[', '}': '{', '>': '<'};
const blank = (glyph: Glyph) => glyph.text.trim() === '';
const count = (text: string, char: string) => text.split(char).length - 1;

function readRow(rows: Rows, y: number, cols: number): Glyph[] {
  const line = rows.getLine(y), glyphs: Glyph[] = [];
  for (let x = 0; line && x < cols; x++) {
    const cell = line.getCell(x);
    if (cell && cell.getWidth() > 0) glyphs.push({text: cell.getChars() || ' ', x, width: cell.getWidth(), y});
  }
  return glyphs;
}
/** Content of one row, ignoring padding and a box border at either side; indices are shifted by `base`. */
function span(glyphs: Glyph[], cols: number, base: number): Span {
  let end = glyphs.length - 1, edge = cols, border = false;
  while (end >= 0 && blank(glyphs[end])) end--;
  if (end > 0 && BORDER.includes(glyphs[end].text)) {
    edge = glyphs[end].x; border = true; end--;
    while (end >= 0 && blank(glyphs[end])) end--;
  }
  let first = 0;
  while (first < glyphs.length && blank(glyphs[first])) first++;
  if (first < end && BORDER.includes(glyphs[first].text)) {
    first++;
    while (first < glyphs.length && blank(glyphs[first])) first++;
  }
  return {first: first + base, end: end + base, edge, border};
}
/** Rows joined by xterm's soft-wrap flag form one logical line; a row the program broke itself starts a new one. */
function logicalLines(rows: Rows, cols: number, from: number, to: number): Logical[] {
  const lines: Logical[] = [];
  for (let y = from; y <= to; y++) {
    const glyphs = readRow(rows, y, cols), previous = lines.at(-1);
    if (previous && rows.getLine(y)?.isWrapped) {
      previous.tail = span(glyphs, cols, previous.glyphs.length);
      previous.glyphs.push(...glyphs);
    } else {
      const head = span(glyphs, cols, 0);
      lines.push({glyphs, text: '', offset: [], head, tail: head});
    }
  }
  for (const line of lines) {
    for (const glyph of line.glyphs) { line.offset.push(line.text.length); line.text += glyph.text; }
  }
  return lines;
}
/**
 * Where the URL goes on in the line below, as an exclusive glyph index of its first token, when that line holds the
 * rest of it. A row filled to the border of a box, or to the last column, was broken by the screen, not by the
 * program, and a program's own narrower wrap (a TUI's margin) is accepted for a long URL on a wide row. Anything
 * that could be prose, a bullet or another URL stays a separate line: a missed join costs a copy, a wrong one an
 * address that opens something else.
 */
function continuation(url: string, urlColumn: number, cols: number, above: Logical, below: Logical): number | undefined {
  const {first, end} = below.head, row = above.tail;
  if (end < first) return;
  let stop = first;
  while (stop < below.glyphs.length && !blank(below.glyphs[stop]) && !BORDER.includes(below.glyphs[stop].text)) stop++;
  const token = below.text.slice(below.offset[first], below.offset[stop] ?? below.text.length);
  if (!URL_TAIL.test(token) || BULLET.test(token) || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return;
  const endColumn = above.glyphs[row.end].x + above.glyphs[row.end].width, gap = row.edge - endColumn;
  const urlish = /[/?&=%#_~+@]/.test(token) || (token.length >= 12 && /\d/.test(token) && /^[\w.-]+$/.test(token));
  const narrow = url.length >= 30 && endColumn >= cols * .7 && below.glyphs[first].x <= urlColumn && /[/?&=%#_~+@]/.test(token);
  return (row.border && gap <= 1) || (urlish && (gap <= 0 || narrow)) ? stop : undefined;
}
/** Drops what prose adds after a URL: closing punctuation, and a closing bracket the URL never opened. */
function trimmed(text: string): string {
  let end = text.length;
  while (end > 0) {
    const last = text[end - 1], opener = OPENERS[last], body = text.slice(0, end);
    if ('.,;:!?*…'.includes(last) || (opener && count(body, last) > count(body, opener))) end--;
    else break;
  }
  return text.slice(0, end);
}

/**
 * The text of glyphs `[from, to)` of `lines[index]`, continued onto the following lines while it runs to the end of
 * its row and the next line holds the rest of it (see `continuation`). Characters outside the BMP take two UTF-16
 * units, each pointing at its glyph.
 */
export function joinWrapped(lines: Logical[], index: number, cols: number, from: number, to: number) {
  const logical = lines[index], units: Glyph[] = [];
  let text = '';
  const push = (source: Logical, a: number, b: number) => {
    for (const glyph of source.glyphs.slice(a, b)) { text += glyph.text; units.push(...Array.from(glyph.text, () => glyph)); }
  };
  push(logical, from, to);
  const startColumn = logical.glyphs[from].x;
  let current = logical, cursor = index, open = to - 1 === logical.tail.end;
  while (open && lines[cursor + 1]) {
    const next = lines[cursor + 1], stop = continuation(text, startColumn, cols, current, next);
    if (stop === undefined) break;
    push(next, next.head.first, stop);
    open = stop - 1 === next.tail.end;
    current = next; cursor++;
  }
  return {text, units};
}

/** The logical lines around 1-based buffer line `line`: whole soft-wrapped lines, a few rows either side. */
export function logicalWindow(rows: Rows, cols: number, line: number): Logical[] {
  const y = line - 1;
  let from = Math.max(0, y - WINDOW), to = Math.min(rows.length - 1, y + WINDOW);
  for (let n = 0; from > 0 && rows.getLine(from)?.isWrapped && n < SOFT_LIMIT; n++) from--;
  for (let n = 0; to + 1 < rows.length && rows.getLine(to + 1)?.isWrapped && n < SOFT_LIMIT; n++) to++;
  return logicalLines(rows, cols, from, to);
}
/** The 1-based buffer range covering UTF-16 units `[from, to)` of a logical text, each unit mapped to its glyph. */
export function unitRange(units: Glyph[], from: number, to: number): UrlLink['range'] {
  const start = units[from], end = units[to - 1];
  return {start: {x: start.x + 1, y: start.y + 1}, end: {x: end.x + end.width, y: end.y + 1}};
}

/** Every `re` match touching 1-based buffer line `line`, joined across soft wraps; `accept` refines or rejects the joined text. */
function scan<R extends {text: string}>(rows: Rows, cols: number, line: number, re: RegExp, accept: (text: string, before: string | undefined) => R | undefined) {
  const found: (R & {range: UrlLink['range']})[] = [], lines = logicalWindow(rows, cols, line);
  lines.forEach((logical, index) => {
    for (const match of logical.text.matchAll(re)) {
      const last = logical.offset.findIndex(offset => offset >= match.index + match[0].length);
      const {text, units} = joinWrapped(lines, index, cols, logical.offset.indexOf(match.index), last < 0 ? logical.glyphs.length : last);
      const hit = accept(trimmed(text), logical.text[match.index - 1]);
      if (!hit) continue;
      const range = unitRange(units, 0, hit.text.length);
      if (range.start.y <= line && line <= range.end.y) found.push({...hit, range});
    }
  });
  return found;
}

/** Every http(s) URL that touches 1-based buffer line `line`, joined across soft wraps and conservative hard wraps. */
export function findUrls(rows: Rows, cols: number, line: number): UrlLink[] {
  return scan(rows, cols, line, URL_RE, (url, before) =>
    (before && /[A-Za-z0-9]/.test(before)) || !/^https?:\/\/[^/?#]/i.test(url) ? undefined : {text: url});
}

export type PathLink = UrlLink & {path: string; line?: number; column?: number};
// Absolute, `~/` and `./` `../` paths, or `dir/file.ext` shaped relative ones; `file:line:col` is split off afterwards.
const PATH_RE = /(?:~\/|\.{1,2}\/|\/)[^\s<>"'`│┃║]+|[\w.@+-]+(?:\/[\w.@+-]+)+\.\w+(?::\d+){0,2}/g;
const PATH_START = /^[\s"'`([{<=,;|]$/;
const LOCATION = /:(\d+)(?::(\d+))?$/;

/**
 * Every host file path that touches 1-based buffer line `line`. A path starts a token (never the tail of a URL or a
 * word), may carry `:line[:col]`, and is returned as printed: resolving `~` and relative paths is the caller's job.
 */
export function findPaths(rows: Rows, cols: number, line: number): PathLink[] {
  return scan(rows, cols, line, PATH_RE, (text, before) => {
    if (before && !PATH_START.test(before)) return;
    const where = LOCATION.exec(text), path = where ? text.slice(0, where.index) : text;
    if (!/[^/.~]/.test(path) || path.endsWith('/') || /(?:^|\/)\.{3,}(?:\/|$)/.test(path)) return;
    return {text, path, ...(where && {line: Number(where[1]), ...(where[2] && {column: Number(where[2])})})};
  });
}

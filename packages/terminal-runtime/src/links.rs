//! URL and host-path detection over the core's rows ([#1320]): a port of `terminalLinks.ts`, which
//! stays the oracle (`fixtures/links.json`, replayed through the TypeScript code by a client test).
//! It reads the rows around one row, joins soft-wrapped rows into logical lines, and joins a URL a
//! program broke itself (at a box border, at the full width of the screen, or under a list's
//! indentation) only when the next line plainly continues it: a missed join costs a copy, a wrong
//! one an address that opens something else. Rows are absolute and ranges are 0-based and
//! inclusive, like [`crate::CellRange`]; the TypeScript functions take 1-based lines and return
//! 1-based ranges.
//!
//! [#1320]: https://github.com/mihazs/lazysh/issues/1320

use crate::runtime::{Error, TerminalRuntime};
use crate::selection::{CellPos, CellRange};
use ghostty_vt::{CellWide, ScreenTextRow};
use regex::Regex;
use std::sync::LazyLock;

/// A hard-wrapped URL rarely spans more than a handful of rows.
const WINDOW: usize = 16;
/// Soft-wrapped rows followed to the end of a line.
const SOFT_LIMIT: usize = 128;
const BORDER: &str = "│┃║";
/// JavaScript's `\s`: what ends a URL or a path in `terminalLinks.ts`.
const SPACE: &str =
    r"\t\n\v\f\r \u{a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r#"[Hh][Tt][Tt][Pp][Ss]?://[^{SPACE}<>"'`│┃║]+"#)).unwrap()
});
static PATH: LazyLock<Regex> = LazyLock::new(|| {
    let word = r"[0-9A-Za-z_]";
    let name = r"[0-9A-Za-z_.@+-]";
    Regex::new(&format!(
        r#"(?:~/|\.{{1,2}}/|/)[^{SPACE}<>"'`│┃║]+|{name}+(?:/{name}+)+\.{word}+(?::[0-9]+){{0,2}}"#
    ))
    .unwrap()
});
static URL_HEAD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[Hh][Tt][Tt][Pp][Ss]?://[^/?#]").unwrap());
static URL_TAIL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+$").unwrap());
static BULLET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^(?:[-*+>]|[0-9]{1,2}[.)])$").unwrap());
static SCHEME: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z][A-Za-z0-9+.-]*://").unwrap());
static URLISH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[/?&=%#_~+@]").unwrap());
static WORDY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9A-Za-z_.-]+$").unwrap());
static LOCATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r":([0-9]+)(?::([0-9]+))?$").unwrap());
static DOTS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|/)\.{3,}(?:/|$)").unwrap());

/// One rendered character: a wide character is one glyph and its second cell is skipped.
#[derive(Debug, Clone)]
struct Glyph {
    text: String,
    x: usize,
    width: usize,
    y: usize,
}

/// Content bounds of a row as glyph indices, and where its usable width ends (a box border or the
/// last column).
#[derive(Debug, Clone, Copy)]
struct Span {
    first: i64,
    end: i64,
    edge: usize,
    border: bool,
}

/// Soft-wrapped rows joined into one line of glyphs; `offset[i]` is where glyph `i` starts in `text`.
struct Logical {
    glyphs: Vec<Glyph>,
    text: String,
    offset: Vec<usize>,
    head: Span,
    tail: Span,
}

/// A URL touching the requested row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlLink {
    pub text: String,
    pub range: CellRange,
}

/// A host file path touching the requested row, as printed (`~` and relative paths are the
/// caller's to resolve), with the `:line[:column]` it carried.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathLink {
    pub text: String,
    pub path: String,
    pub line: Option<u64>,
    pub column: Option<u64>,
    pub range: CellRange,
}

fn blank(glyph: &Glyph) -> bool {
    glyph.text.trim().is_empty()
}

fn read_row(row: &ScreenTextRow, cols: usize, y: usize) -> Vec<Glyph> {
    row.cells
        .iter()
        .take(cols)
        .enumerate()
        .filter(|(_, cell)| cell.wide != CellWide::SpacerTail)
        .map(|(x, cell)| {
            let text: String = cell
                .graphemes
                .iter()
                .filter_map(|&c| char::from_u32(c))
                .collect();
            Glyph {
                text: if text.is_empty() { " ".into() } else { text },
                x,
                width: if cell.wide == CellWide::Wide { 2 } else { 1 },
                y,
            }
        })
        .collect()
}

/// Content of one row, ignoring padding and a box border at either side; indices shift by `base`.
fn span(glyphs: &[Glyph], cols: usize, base: i64) -> Span {
    let mut end = glyphs.len() as i64 - 1;
    let (mut edge, mut border) = (cols, false);
    let is_border = |glyph: &Glyph| BORDER.contains(glyph.text.as_str());
    while end >= 0 && blank(&glyphs[end as usize]) {
        end -= 1;
    }
    if end > 0 && is_border(&glyphs[end as usize]) {
        edge = glyphs[end as usize].x;
        border = true;
        end -= 1;
        while end >= 0 && blank(&glyphs[end as usize]) {
            end -= 1;
        }
    }
    let mut first = 0i64;
    while (first as usize) < glyphs.len() && blank(&glyphs[first as usize]) {
        first += 1;
    }
    if first < end && is_border(&glyphs[first as usize]) {
        first += 1;
        while (first as usize) < glyphs.len() && blank(&glyphs[first as usize]) {
            first += 1;
        }
    }
    Span {
        first: first + base,
        end: end + base,
        edge,
        border,
    }
}

/// Rows joined by the soft-wrap flag form one logical line; a row the program broke itself starts
/// a new one. `rows[i]` is absolute row `from + i`.
fn logical_lines(rows: &[ScreenTextRow], cols: usize, from: usize) -> Vec<Logical> {
    let mut lines: Vec<Logical> = Vec::new();
    for (index, row) in rows.iter().enumerate() {
        let glyphs = read_row(row, cols, from + index);
        match lines.last_mut() {
            Some(previous) if row.wrap_continuation => {
                previous.tail = span(&glyphs, cols, previous.glyphs.len() as i64);
                previous.glyphs.extend(glyphs);
            }
            _ => {
                let head = span(&glyphs, cols, 0);
                lines.push(Logical {
                    glyphs,
                    text: String::new(),
                    offset: Vec::new(),
                    head,
                    tail: head,
                });
            }
        }
    }
    for line in &mut lines {
        for glyph in &line.glyphs {
            line.offset.push(line.text.len());
            line.text.push_str(&glyph.text);
        }
    }
    lines
}

/// Where the URL goes on in the line below, as an exclusive glyph index of its first token, when
/// that line holds the rest of it. A row filled to the border of a box, or to the last column, was
/// broken by the screen, not by the program, and a program's own narrower wrap (a TUI's margin) is
/// accepted for a long URL on a wide row. Anything that could be prose, a bullet or another URL
/// stays a separate line.
fn continuation(
    url: &str,
    url_column: usize,
    cols: usize,
    above: &Logical,
    below: &Logical,
) -> Option<usize> {
    let (first, end) = (below.head.first, below.head.end);
    let row = above.tail;
    if end < first {
        return None;
    }
    let first = first as usize;
    let mut stop = first;
    while stop < below.glyphs.len()
        && !blank(&below.glyphs[stop])
        && !BORDER.contains(below.glyphs[stop].text.as_str())
    {
        stop += 1;
    }
    let token = &below.text
        [below.offset[first]..below.offset.get(stop).copied().unwrap_or(below.text.len())];
    if !URL_TAIL.is_match(token) || BULLET.is_match(token) || SCHEME.is_match(token) {
        return None;
    }
    let last = &above.glyphs[row.end as usize];
    let end_column = last.x + last.width;
    let gap = row.edge as i64 - end_column as i64;
    let urlish = URLISH.is_match(token)
        || (token.chars().count() >= 12
            && token.chars().any(|c| c.is_ascii_digit())
            && WORDY.is_match(token));
    let narrow = url.encode_utf16().count() >= 30
        && end_column as f64 >= cols as f64 * 0.7
        && below.glyphs[first].x <= url_column
        && URLISH.is_match(token);
    ((row.border && gap <= 1) || (urlish && (gap <= 0 || narrow))).then_some(stop)
}

/// Drops what prose adds after a URL: closing punctuation, and a closing bracket the URL never opened.
fn trimmed(text: &str) -> &str {
    let mut end = text.len();
    while let Some(last) = text[..end].chars().next_back() {
        let body = &text[..end];
        let opener = match last {
            ')' => Some('('),
            ']' => Some('['),
            '}' => Some('{'),
            '>' => Some('<'),
            _ => None,
        };
        let unopened =
            opener.is_some_and(|open| body.matches(last).count() > body.matches(open).count());
        if ".,;:!?*…".contains(last) || unopened {
            end -= last.len_utf8();
        } else {
            break;
        }
    }
    &text[..end]
}

/// The text of glyphs `[from, to)` of `lines[index]`, continued onto the following lines while it
/// runs to the end of its row and the next line holds the rest of it. `glyphs` has one entry per
/// character of the text, each pointing at the glyph that character came from.
fn join_wrapped<'a>(
    lines: &'a [Logical],
    index: usize,
    cols: usize,
    from: usize,
    to: usize,
) -> (String, Vec<&'a Glyph>) {
    let logical = &lines[index];
    let (mut text, mut units) = (String::new(), Vec::new());
    let push =
        |text: &mut String, units: &mut Vec<&'a Glyph>, source: &'a Logical, a: usize, b: usize| {
            for glyph in &source.glyphs[a..b] {
                text.push_str(&glyph.text);
                units.extend(glyph.text.chars().map(|_| glyph));
            }
        };
    push(&mut text, &mut units, logical, from, to);
    let start_column = logical.glyphs[from].x;
    let (mut current, mut cursor) = (logical, index);
    let mut open = to as i64 - 1 == logical.tail.end;
    while open && lines.get(cursor + 1).is_some() {
        let next = &lines[cursor + 1];
        let Some(stop) = continuation(&text, start_column, cols, current, next) else {
            break;
        };
        push(&mut text, &mut units, next, next.head.first as usize, stop);
        open = stop as i64 - 1 == next.tail.end;
        current = next;
        cursor += 1;
    }
    (text, units)
}

fn range_of(units: &[&Glyph], chars: usize) -> CellRange {
    let (start, end) = (units[0], units[chars - 1]);
    CellRange {
        start: CellPos {
            x: start.x as u16,
            y: start.y,
        },
        end: CellPos {
            x: (end.x + end.width - 1) as u16,
            y: end.y,
        },
    }
}

impl TerminalRuntime {
    /// The target of the OSC 8 hyperlink an application drew on `cell`, if any. Only the rows on
    /// the screen can be asked: libghostty-vt resolves hyperlinks through the viewport.
    pub fn hyperlink_at(&self, cell: CellPos) -> Result<Option<String>, Error> {
        let view = self.viewport()?;
        if cell.y < view.top || cell.y >= view.top + view.rows || cell.x >= self.size().cols {
            return Ok(None);
        }
        Ok(self
            .vt()
            .viewport_hyperlink_uri(cell.x, (cell.y - view.top) as u32)?)
    }

    /// Every match of `re` touching `row`, joined across soft wraps; `accept` refines or rejects
    /// the joined text, given the character before the match.
    fn scan_links<R>(
        &self,
        row: usize,
        re: &Regex,
        mut accept: impl FnMut(&str, Option<char>) -> Option<R>,
    ) -> Result<Vec<(R, String, CellRange)>, Error> {
        let total = self.vt().total_rows()?;
        let cols = usize::from(self.size().cols);
        if row >= total {
            return Ok(Vec::new());
        }
        // The window of rows around `row`, then the soft-wrapped line either side of it, read a
        // row at a time because that is rare.
        let mut from = row.saturating_sub(WINDOW);
        let mut to = (row + WINDOW).min(total - 1);
        let mut rows = self.vt().screen_text_rows_range(from, to + 1)?;
        let mut n = 0;
        while from > 0 && rows[0].wrap_continuation && n < SOFT_LIMIT {
            from -= 1;
            n += 1;
            rows.splice(0..0, self.vt().screen_text_rows_range(from, from + 1)?);
        }
        n = 0;
        while to + 1 < total && n < SOFT_LIMIT {
            let next = self.vt().screen_text_rows_range(to + 1, to + 2)?;
            if !next[0].wrap_continuation {
                break;
            }
            to += 1;
            n += 1;
            rows.extend(next);
        }
        let lines = logical_lines(&rows, cols, from);
        let mut found = Vec::new();
        for (index, logical) in lines.iter().enumerate() {
            for m in re.find_iter(&logical.text) {
                let Some(first) = logical.offset.iter().position(|&o| o == m.start()) else {
                    continue;
                };
                let last = logical
                    .offset
                    .iter()
                    .position(|&o| o >= m.end())
                    .unwrap_or(logical.glyphs.len());
                let (text, units) = join_wrapped(&lines, index, cols, first, last);
                let before = logical.text[..m.start()].chars().next_back();
                let Some(hit) = accept(trimmed(&text), before) else {
                    continue;
                };
                let kept = trimmed(&text);
                let range = range_of(&units, kept.chars().count());
                if range.start.y <= row && row <= range.end.y {
                    found.push((hit, kept.to_string(), range));
                }
            }
        }
        Ok(found)
    }

    /// Every http(s) URL that touches absolute row `row`, joined across soft wraps and conservative
    /// hard wraps.
    pub fn find_urls(&self, row: usize) -> Result<Vec<UrlLink>, Error> {
        Ok(self
            .scan_links(row, &URL, |url, before| {
                let glued = before.is_some_and(|c| c.is_ascii_alphanumeric());
                (!glued && URL_HEAD.is_match(url)).then_some(())
            })?
            .into_iter()
            .map(|((), text, range)| UrlLink { text, range })
            .collect())
    }

    /// Every host file path that touches absolute row `row`. A path starts a token (never the tail
    /// of a URL or a word), may carry `:line[:col]`, and is returned as printed.
    pub fn find_paths(&self, row: usize) -> Result<Vec<PathLink>, Error> {
        Ok(self
            .scan_links(row, &PATH, |text, before| {
                if before.is_some_and(|c| !path_start(c)) {
                    return None;
                }
                let location = LOCATION.captures(text);
                let path = location
                    .as_ref()
                    .map_or(text, |l| &text[..l.get(0).unwrap().start()]);
                let plain = !path.chars().any(|c| !"/.~".contains(c));
                if plain || path.ends_with('/') || DOTS.is_match(path) {
                    return None;
                }
                let number =
                    |group: Option<regex::Match>| group.and_then(|m| m.as_str().parse().ok());
                Some((
                    path.to_string(),
                    location.as_ref().and_then(|l| number(l.get(1))),
                    location.as_ref().and_then(|l| number(l.get(2))),
                ))
            })?
            .into_iter()
            .map(|((path, line, column), text, range)| PathLink {
                text,
                path,
                line,
                column,
                range,
            })
            .collect())
    }
}

/// `PATH_START` of `terminalLinks.ts`: a character a path may follow.
fn path_start(c: char) -> bool {
    let space = c.is_whitespace() && c != '\u{85}' || c == '\u{feff}';
    space || "\"'`([{<=,;|".contains(c)
}

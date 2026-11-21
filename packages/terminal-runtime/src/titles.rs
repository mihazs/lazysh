//! Window titles (`OSC 0` and `OSC 2`) read from the raw byte stream ([#1321]).
//!
//! libghostty-vt tracks the title and has a callback for it, which the vendored binding does not wrap and
//! #384 forbids patching, so a title change would never reach the host. Like [`crate::colors`], this scanner
//! watches the bytes the VT is given and reports what an `OSC 0 ; text` or `OSC 2 ; text` set, so the control
//! plane can raise the adapter's `title` event. `OSC 1` (the icon name) is not a title.
//!
//! Limits: only the 7-bit form `ESC ] n ; text (BEL | ESC)` is recognised, a sequence the VT is ignoring (inside a
//! string it does not parse as an OSC) is read as a title all the same, and a title past [`MAX_TITLE`] bytes is
//! cut at a character boundary. Bytes that are not UTF-8 are replaced, as xterm.js decodes them.
//!
//! [#1321]: https://github.com/mihazs/lazysh/issues/1321

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
/// The longest title kept, in bytes of UTF-8.
pub(crate) const MAX_TITLE: usize = 1024;

#[derive(Default)]
pub(crate) struct Titles {
    /// The last byte of the previous chunk was an ESC: a `]` first in this one opens an OSC.
    escaped: bool,
    /// Inside an OSC, its bytes so far (`0;` or `2;` first); kept only up to the title's bound, the rest is skipped.
    text: Option<Vec<u8>>,
}

impl Titles {
    /// The last title `chunk` set, if it completed one. The state carries over to the next chunk.
    pub(crate) fn scan(&mut self, chunk: &[u8]) -> Option<String> {
        let (mut title, mut at) = (None, 0);
        while at < chunk.len() {
            let Some(text) = self.text.as_mut() else {
                match self.opening(chunk, at) {
                    Some(after) => (self.text, at) = (Some(Vec::new()), after),
                    None => break,
                }
                continue;
            };
            // Up to the byte that ends the OSC (BEL, or the ESC of ST) or cancels it.
            let end = chunk[at..]
                .iter()
                .position(|b| matches!(*b, BEL | ESC | CAN | SUB))
                .map_or(chunk.len(), |len| at + len);
            let room = (MAX_TITLE + 2).saturating_sub(text.len());
            text.extend_from_slice(&chunk[at..end.min(at + room)]);
            if let Some(&last) = chunk.get(end) {
                let finished = self.text.take().unwrap_or_default();
                if matches!(last, BEL | ESC) {
                    title = Self::title(&finished).or(title);
                }
                self.escaped = last == ESC;
            }
            at = end + 1;
        }
        title
    }

    /// Where the text of an OSC starts: just after the first `ESC ]` at or after `from`, if the chunk has one.
    fn opening(&mut self, chunk: &[u8], from: usize) -> Option<usize> {
        let mut at = from;
        if std::mem::take(&mut self.escaped) && chunk[at] == b']' {
            return Some(at + 1);
        }
        while let Some(esc) = chunk[at..].iter().position(|&b| b == ESC) {
            at += esc + 1;
            match chunk.get(at) {
                Some(b']') => return Some(at + 1),
                Some(_) => {}
                None => self.escaped = true,
            }
        }
        None
    }

    /// The title an OSC sets: `0;` or `2;` and then the text (`1;` is the icon name), bounded and as UTF-8.
    fn title(osc: &[u8]) -> Option<String> {
        let text = osc.strip_prefix(b"0;").or(osc.strip_prefix(b"2;"))?;
        // C0 controls inside an OSC string are ignored by the VT, so they are not part of the title.
        let mut title: String = String::from_utf8_lossy(text)
            .chars()
            .filter(|c| !c.is_control())
            .collect();
        let mut end = MAX_TITLE.min(title.len());
        while !title.is_char_boundary(end) {
            end -= 1;
        }
        title.truncate(end);
        Some(title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_what_osc_0_and_2_set_whatever_ends_them_or_splits_the_stream() {
        let mut titles = Titles::default();
        assert_eq!(titles.scan(b"plain \x1b[1mtext\x1b[0m").as_deref(), None);
        assert_eq!(titles.scan(b"\x1b]0;one\x07").as_deref(), Some("one"));
        assert_eq!(titles.scan(b"\x1b]2;two\x1b\\").as_deref(), Some("two"));
        // Only the last title of a chunk counts, and a stream cut anywhere gives the same answer.
        assert_eq!(
            titles.scan(b"\x1b]0;a\x07x\x1b]2;b\x07").as_deref(),
            Some("b")
        );
        assert_eq!(
            titles.scan(b"\x1b]0;a\x1b\x1b]2;b\x07").as_deref(),
            Some("b"),
            "an ESC that ends one OSC may start the next"
        );
        let stream = "\x1b]2;日本 title\x07".as_bytes();
        for cut in 0..stream.len() {
            let mut cut_titles = Titles::default();
            assert_eq!(cut_titles.scan(&stream[..cut]), None);
            assert_eq!(
                cut_titles.scan(&stream[cut..]).as_deref(),
                Some("日本 title"),
                "{cut}"
            );
        }
        assert_eq!(
            titles.scan(b"\x1b]2;\x07").as_deref(),
            Some(""),
            "an empty title clears it"
        );
        assert_eq!(
            titles.scan(b"\x1b]2;a\nb\x7f\x07").as_deref(),
            Some("ab"),
            "controls are dropped"
        );
    }

    #[test]
    fn what_is_not_a_title_or_was_cancelled_sets_none() {
        let mut titles = Titles::default();
        for not_a_title in [
            &b"\x1b]1;icon\x07"[..],
            b"\x1b]7;file:///tmp\x07",
            b"\x1b]20;x\x07",
            b"\x1b]2;cancelled\x18more\x07",
            b"\x1b[2;3H",
        ] {
            assert_eq!(titles.scan(not_a_title), None, "{not_a_title:?}");
        }
        // Cancelled and finished sequences leave the scanner in step: the next one is read as usual.
        assert_eq!(titles.scan(b"\x1b]2;after\x07").as_deref(), Some("after"));
    }

    #[test]
    fn a_title_is_bounded_and_cut_on_a_character_boundary() {
        let mut titles = Titles::default();
        let long = format!("\x1b]0;{}\x07", "é".repeat(MAX_TITLE));
        let title = titles.scan(long.as_bytes()).unwrap();
        assert!(
            title.len() <= MAX_TITLE && title.starts_with("éé") && title.chars().all(|c| c == 'é')
        );
        // Garbage bytes are replaced, not refused, and the scanner is back in step afterwards.
        assert_eq!(
            titles.scan(b"\x1b]2;a\xffb\x07").as_deref(),
            Some("a\u{fffd}b")
        );
        assert_eq!(titles.scan(b"\x1b]2;ok\x07").as_deref(), Some("ok"));
    }
}

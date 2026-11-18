//! Default colour queries answered from the host's theme ([#1314]).
//!
//! `OSC 4 ; n ; ?` (palette) is libghostty-vt's own: the runtime points the VT's default palette at
//! the theme (`Terminal::set_default_palette`) and the VT answers, in order, with the terminator the
//! query used. `OSC 10`, `11` and `12` (default foreground, background and cursor) are answered
//! only once the embedder configured those colours with `ghostty_terminal_set`, which the vendored
//! binding does not wrap and #384 forbids patching, so a program that probes them to pick a light
//! or dark scheme (Codex, Zellij, OpenCode, vim, tmux) would wait for a reply that never comes. This
//! scanner watches the raw byte stream for those queries so the runtime can answer from the theme.
//!
//! The VT still parses every byte, and answers itself when it holds a colour (a program set one
//! with `OSC 10` to `12`); the runtime adds the theme's reply only when it did not, so one query
//! gets one reply and a colour a program set is the one reported, as xterm.js does. The reply uses
//! the query's terminator, as xterm and libghostty-vt do (xterm.js always answers with ST).
//!
//! Limits: only the 7-bit form `ESC ] 1x ; ? ... (BEL | ESC)` is recognised, and a sequence that
//! also sets a colour is left to the VT. When the VT answers some but not all of a chained query
//! (`10;?;?;?`) the theme answers none. Like the Mosh scanner it does not know whether the VT is
//! inside another string when the prefix appears.
//!
//! [#1314]: https://github.com/mihazs/lazysh/issues/1314

use crate::render::Theme;
use ghostty_vt::RgbColor;
use std::fmt::Write;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
/// Longest query text kept: `10;?;?;?`, one `?` for each colour libghostty-vt knows, with room to spare.
const MAX_TEXT: usize = 16;

enum State {
    Ground,
    /// Saw ESC.
    Escape,
    /// Inside `ESC ]`, reading `text`.
    Text,
}

/// The theme's three default colours and the scanner that answers queries for them.
pub(crate) struct ColorQueries {
    /// Foreground, background and cursor: `OSC 10`, `11` and `12`.
    colors: [RgbColor; 3],
    state: State,
    text: [u8; MAX_TEXT],
    len: usize,
}

impl ColorQueries {
    pub(crate) fn new(theme: &Theme) -> Self {
        Self {
            colors: [theme.foreground, theme.background, theme.cursor],
            state: State::Ground,
            text: [0; MAX_TEXT],
            len: 0,
        }
    }

    /// The next completed query at or after `from`: the offset just past the byte the VT dispatches
    /// it on (BEL, or the ESC of ST) and the reply. `None` consumes the rest of the chunk; the state
    /// carries over to the next one.
    pub(crate) fn find(&mut self, chunk: &[u8], from: usize) -> Option<(usize, String)> {
        let mut i = from;
        while i < chunk.len() {
            if matches!(self.state, State::Ground) {
                // Most bytes are not an ESC: skip to the next one without a state change.
                i += chunk[i..].iter().position(|&b| b == ESC)?;
            }
            let b = chunk[i];
            i += 1;
            match self.state {
                State::Ground => self.state = State::Escape,
                State::Escape => {
                    self.state = match b {
                        b']' => {
                            self.len = 0;
                            State::Text
                        }
                        ESC => State::Escape,
                        _ => State::Ground,
                    }
                }
                State::Text => match b {
                    BEL | ESC => {
                        self.state = if b == BEL {
                            State::Ground
                        } else {
                            State::Escape
                        };
                        if let Some(reply) = self.reply(b == BEL) {
                            return Some((i, reply));
                        }
                    }
                    CAN | SUB => self.state = State::Ground,
                    _ if continues_query(self.len, b) => {
                        self.text[self.len] = b;
                        self.len += 1;
                    }
                    _ => self.state = State::Ground,
                },
            }
        }
        None
    }

    /// One `OSC n ; rgb:RRRR/GGGG/BBBB` report for each `?` in the text, in order.
    fn reply(&self, bel: bool) -> Option<String> {
        let text = std::str::from_utf8(&self.text[..self.len]).ok()?;
        let (first, specs) = text.split_once(';')?;
        let first: usize = first.parse().ok()?;
        let end = if bel { "\x07" } else { "\x1b\\" };
        let mut reply = String::new();
        // xterm: each further spec belongs to the next dynamic colour (10, 11, 12).
        for (n, _) in (first..=12)
            .zip(specs.split(';'))
            .filter(|(_, spec)| *spec == "?")
        {
            let [r, g, b] = {
                let c = self.colors[n - 10];
                [c.r, c.g, c.b].map(|c| u16::from(c) * 257)
            };
            let _ = write!(reply, "\x1b]{n};rgb:{r:04x}/{g:04x}/{b:04x}{end}");
        }
        (!reply.is_empty()).then_some(reply)
    }
}

/// Whether `b` can come after `len` bytes of a query: `1x;` with x in 0..=2, then only `?` and `;`.
fn continues_query(len: usize, b: u8) -> bool {
    match len {
        0 => b == b'1',
        1 => matches!(b, b'0'..=b'2'),
        2 => b == b';',
        MAX_TEXT.. => false,
        _ => matches!(b, b'?' | b';'),
    }
}

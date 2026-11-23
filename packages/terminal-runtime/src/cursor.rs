//! Whether a program chose the cursor's style (`DECSCUSR`, `CSI Ps SP q`), read from the raw byte stream (#2380).
//!
//! libghostty-vt draws the cursor a program asked for and otherwise a steady block, and it shows the same
//! state for the default (`Ps` 0, or nothing sent) and for an explicit steady block (`Ps` 2). A host whose
//! preferences name a default cursor, as xterm.js's `cursorStyle` and `cursorBlink` do, must keep a program's own
//! choice (vim's normal mode asks for a block), so it has to know which of the two it is looking at. The vendored
//! binding has no call for it and #384 forbids patching it, so, like [`crate::colors`] and [`crate::titles`], this
//! scanner watches the bytes the VT is given: `Ps` 1 to 6 is a choice, `Ps` 0 or none gives the cursor back, and
//! `ESC c` (a full reset) does too, as the VT's own reset.
//!
//! Limits: only the 7-bit form `ESC [ Ps SP q` is recognised, and a sequence inside a string the VT is skipping
//! (a DCS passthrough, say) is read all the same. A request with more than one parameter, a private marker or a
//! `Ps` above 6 is not one: the VT ignores it too.

const ESC: u8 = 0x1b;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
/// A parameter this large is no style; the value only has to stay out of the way of 0 to 6.
const MAX_PARAM: u32 = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    /// Saw ESC.
    Escape,
    /// Inside `ESC [`, reading parameters.
    Params,
    /// `ESC [ Ps SP`: a `q` now is DECSCUSR.
    Space,
    /// Inside a control sequence that is not one: skipped to its final byte.
    Skip,
}

pub(crate) struct CursorChoice {
    state: State,
    /// The first parameter of the sequence being read; `None` while it has none.
    param: Option<u32>,
    /// The sequence has one parameter and no private marker, which is all DECSCUSR has.
    plain: bool,
    chosen: bool,
}

impl CursorChoice {
    pub(crate) fn new() -> Self {
        Self {
            state: State::Ground,
            param: None,
            plain: true,
            chosen: false,
        }
    }

    /// A program asked for a cursor style and has not given it back.
    pub(crate) fn chosen(&self) -> bool {
        self.chosen
    }

    /// Follow `chunk`; the state carries over to the next one.
    pub(crate) fn scan(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            self.state = match (self.state, byte) {
                (_, ESC) => State::Escape,
                (_, CAN | SUB) => State::Ground,
                (State::Ground, _) => State::Ground,
                (State::Escape, b'[') => {
                    (self.param, self.plain) = (None, true);
                    State::Params
                }
                (State::Escape, b'c') => {
                    self.chosen = false;
                    State::Ground
                }
                (State::Escape, _) => State::Ground,
                (State::Params, b'0'..=b'9') => {
                    let digit = u32::from(byte - b'0');
                    self.param = Some((self.param.unwrap_or(0) * 10 + digit).min(MAX_PARAM));
                    State::Params
                }
                (State::Params, b':' | b';' | b'<'..=b'?') => {
                    self.plain = false;
                    State::Params
                }
                (State::Params, b' ') if self.plain => State::Space,
                (State::Params | State::Space, 0x20..=0x3f) => State::Skip,
                (State::Space, b'q') => {
                    self.request();
                    State::Ground
                }
                (State::Params | State::Space | State::Skip, 0x40..=0x7e) => State::Ground,
                // Controls (and anything the VT executes in the middle of a sequence) do not end it.
                (state, _) => state,
            };
        }
    }

    fn request(&mut self) {
        match self.param {
            None | Some(0) => self.chosen = false,
            Some(1..=6) => self.chosen = true,
            Some(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chosen_after(chunks: &[&[u8]]) -> bool {
        let mut choice = CursorChoice::new();
        chunks.iter().for_each(|chunk| choice.scan(chunk));
        choice.chosen()
    }

    #[test]
    fn a_style_from_one_to_six_is_a_choice_and_zero_or_none_gives_the_cursor_back() {
        assert!(!chosen_after(&[b"plain output \x1b[31mred\x1b[0m"]));
        for style in 1..=6 {
            assert!(
                chosen_after(&[format!("\x1b[{style} q").as_bytes()]),
                "{style}"
            );
        }
        assert!(!chosen_after(&[b"\x1b[6 q\x1b[0 q"]));
        assert!(!chosen_after(&[b"\x1b[6 q\x1b[ q"]), "no parameter is 0");
        assert!(chosen_after(&[b"\x1b[6 q\x1b[0 q\x1b[2 q"]));
        assert!(
            !chosen_after(&[b"\x1b[2 q\x1bc"]),
            "a full reset gives it back"
        );
    }

    #[test]
    fn what_is_not_decscusr_changes_nothing() {
        // A parameter past 6, several parameters, a private marker, another intermediate or another final.
        for other in [
            &b"\x1b[7 q"[..],
            b"\x1b[99 q",
            b"\x1b[1;2 q",
            b"\x1b[?2 q",
            b"\x1b[2!q",
            b"\x1b[2 p",
            b"\x1b[2q",
            b"\x1b[2  q",
            b"\x1b[2 0q",
        ] {
            assert!(!chosen_after(&[other]), "{other:?}");
            assert!(
                chosen_after(&[b"\x1b[5 q", other]),
                "{other:?} leaves a choice in force"
            );
        }
        // Text that only looks like it, and a reset that is not one.
        assert!(!chosen_after(&[b"[2 q \x1b]0;[2 q\x07 \x1bd"]));
    }

    #[test]
    fn a_sequence_split_anywhere_is_found_and_a_cancelled_one_is_not() {
        let bytes = b"ab\x1b[4 qcd";
        for cut in 0..=bytes.len() {
            assert!(
                chosen_after(&[&bytes[..cut], &bytes[cut..]]),
                "cut at {cut}"
            );
        }
        assert!(!chosen_after(&[b"\x1b[4\x18 q"]), "CAN ends it");
        assert!(!chosen_after(&[b"\x1b[4\x1a q"]), "so does SUB");
        assert!(
            chosen_after(&[b"\x1b[3\x1b[4 q"]),
            "an ESC starts a new one"
        );
        assert!(
            chosen_after(&[b"\x1b[4\n \x07q"]),
            "a control in the middle is executed, not an end"
        );
    }
}

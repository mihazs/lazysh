//! Terminal output to plain text: escape sequences are dropped, an OSC 8 hyperlink is reported only
//! when the text it shows is the address it opens, and every state is bounded so a binary dump
//! cannot make the stripper retain memory or stop reading.
use super::url::MAX_URL;

/// A string sequence (DCS, APC, a clipboard OSC) is skipped up to this many bytes; a longer one is
/// not one a terminal would accept either, so reading resumes as text.
const MAX_STRING: usize = 64 * 1024;
const MAX_CSI: usize = 64;
/// Links one feed can report; more are ignored.
const MAX_LINKS: usize = 8;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Ground,
    Esc,
    /// One more byte belongs to the escape (a character set designation such as `ESC ( B`).
    EscSkip,
    Csi(usize),
    /// First two bytes of an OSC payload: they decide whether it is OSC 8.
    OscHead,
    Osc8,
    /// DCS, APC, PM, SOS and every other OSC: skipped to the string terminator.
    Skip(usize),
}

struct Link {
    target: Vec<u8>,
    text: Vec<u8>,
}

pub(super) struct Stripper {
    state: State,
    /// The last byte inside a string was ESC: `\` ends the string, anything else starts a sequence.
    string_esc: bool,
    payload: Vec<u8>,
    link: Option<Link>,
    after_cr: bool,
    /// Targets of the hyperlinks whose text was their own address, since the last drain.
    pub(super) links: Vec<String>,
}

fn squash(bytes: &[u8]) -> Vec<u8> {
    bytes.iter().copied().filter(u8::is_ascii_graphic).collect()
}

impl Stripper {
    pub(super) fn new() -> Self {
        Self {
            state: State::Ground,
            string_esc: false,
            payload: Vec::new(),
            link: None,
            after_cr: false,
            links: Vec::new(),
        }
    }

    /// Visible bytes of `bytes` are appended to `out`: `\r` and `\n` become one `\n`, a tab a space.
    pub(super) fn push(&mut self, bytes: &[u8], out: &mut Vec<u8>) {
        for &byte in bytes {
            self.byte(byte, out);
        }
    }

    fn text(&mut self, byte: u8, out: &mut Vec<u8>) {
        out.push(byte);
        if let Some(link) = self.link.as_mut() {
            if link.text.len() < MAX_URL + 256 {
                link.text.push(byte);
            } else {
                // A link that never closes is not a link.
                self.link = None;
            }
        }
    }

    fn close_link(&mut self) {
        let Some(link) = self.link.take() else { return };
        // A hyperlink whose text differs from its target is how a program hides where a click goes:
        // the target is not an address the user was shown.
        if link.target.len() <= MAX_URL
            && self.links.len() < MAX_LINKS
            && squash(&link.target) == squash(&link.text)
        {
            if let Ok(target) = String::from_utf8(link.target) {
                self.links.push(target);
            }
        }
    }

    fn finish_string(&mut self) {
        if self.state == State::Osc8 {
            let payload = std::mem::take(&mut self.payload);
            // `8;params;URI`: the URI follows the second semicolon.
            let uri = payload[2..]
                .splitn(2, |b| *b == b';')
                .nth(1)
                .unwrap_or_default();
            self.close_link();
            if !uri.is_empty() && uri.iter().all(u8::is_ascii_graphic) {
                self.link = Some(Link {
                    target: uri.to_vec(),
                    text: Vec::new(),
                });
            }
        }
        self.payload.clear();
        self.state = State::Ground;
    }

    fn byte(&mut self, byte: u8, out: &mut Vec<u8>) {
        match self.state {
            State::OscHead | State::Osc8 | State::Skip(_) => {
                if std::mem::take(&mut self.string_esc) {
                    if byte == b'\\' {
                        return self.finish_string();
                    }
                    // ESC inside a string aborts it and begins a new sequence.
                    self.payload.clear();
                    self.state = State::Esc;
                    return self.byte(byte, out);
                }
                match byte {
                    0x07 => self.finish_string(),
                    0x1b => self.string_esc = true,
                    0x18 | 0x1a => {
                        self.payload.clear();
                        self.state = State::Ground;
                    }
                    _ => self.string_byte(byte),
                }
            }
            State::Csi(length) => match byte {
                0x40..=0x7e => {
                    self.state = State::Ground;
                    match byte {
                        // Cursor moves and screen clears start a new line of text.
                        b'H' | b'f' | b'A' | b'B' | b'E' | b'F' | b'G' | b'd' | b'J' => {
                            self.text(b'\n', out);
                        }
                        b'C' => self.text(b' ', out),
                        _ => {}
                    }
                }
                0x20..=0x3f if length < MAX_CSI => self.state = State::Csi(length + 1),
                0x1b => self.state = State::Esc,
                _ => self.state = State::Ground,
            },
            State::Esc => match byte {
                b'[' => self.state = State::Csi(0),
                b']' => {
                    self.payload.clear();
                    self.state = State::OscHead;
                }
                b'P' | b'X' | b'^' | b'_' => self.state = State::Skip(0),
                b'(' | b')' | b'*' | b'+' | b'#' | b'%' | b' ' => self.state = State::EscSkip,
                0x1b => {}
                _ => self.state = State::Ground,
            },
            State::EscSkip => self.state = State::Ground,
            State::Ground => match byte {
                0x1b => self.state = State::Esc,
                b'\r' => {
                    self.after_cr = true;
                    self.text(b'\n', out);
                }
                b'\n' => {
                    if !std::mem::take(&mut self.after_cr) {
                        self.text(b'\n', out);
                    }
                }
                0x00..=0x08 | 0x0b..=0x1f | 0x7f => {}
                _ => {
                    self.after_cr = false;
                    self.text(if byte == b'\t' { b' ' } else { byte }, out);
                }
            },
        }
    }

    fn string_byte(&mut self, byte: u8) {
        match self.state {
            State::OscHead => {
                self.payload.push(byte);
                if self.payload.len() == 2 {
                    if self.payload == b"8;" {
                        self.state = State::Osc8;
                    } else {
                        self.payload.clear();
                        self.state = State::Skip(0);
                    }
                }
            }
            State::Osc8 if self.payload.len() < MAX_URL + 128 => self.payload.push(byte),
            State::Osc8 => {
                self.payload.clear();
                self.state = State::Skip(0);
            }
            State::Skip(seen) if seen >= MAX_STRING => self.state = State::Ground,
            State::Skip(seen) => self.state = State::Skip(seen + 1),
            _ => {}
        }
    }
}

#[cfg(test)]
impl Stripper {
    pub(super) fn retained(&self) -> usize {
        self.payload.len()
            + self
                .link
                .as_ref()
                .map_or(0, |link| link.target.len() + link.text.len())
    }
}

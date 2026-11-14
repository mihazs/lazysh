//! Mosh's canonical framebuffer in the core ([#1317]).
//!
//! The Mosh client wraps every display update in private OSC 7777 envelopes,
//! `lazysh-mosh;1;begin;<id>;<cols>;<rows>` before it and `lazysh-mosh;1;end;<id>` after it, each
//! terminated by ST (see `packages/mosh-transport`). The server owns the screen size, so the
//! `begin` geometry is applied as a transport-authoritative, top-anchored resize and UI geometry is
//! only an intent the transport answers. A malformed, stale, nested or unfinished envelope fails
//! the display for good: [`DisplayFailure`] mirrors `moshResize.failure` of the xterm backend.
//!
//! The scanner watches the raw byte stream (chunk boundaries may split an envelope anywhere) and
//! never withholds a byte: the VT still parses the envelope, which it ignores as an unknown OSC, so
//! its parser state is the same as xterm.js's when the resize is applied right after the ST.
//!
//! Limit: the scanner does not know whether the VT is inside another string (DCS, APC) when the
//! envelope prefix appears. Mosh's `Display` never nests the envelope, and the server drops OSC
//! 7777 from application output, so only the transport can write it.
//!
//! [#1317]: https://github.com/mihazs/lazysh/issues/1317

/// The Mosh transport refuses larger framebuffers (`packages/mosh-transport`, "Embedding changes
/// and bounds"), so the core does too.
pub const MAX_COLS: u16 = 512;
pub const MAX_ROWS: u16 = 256;
pub const MAX_FRAME_CELLS: u32 = 32768;
/// Longest accepted envelope text after `7777;` (the xterm backend rejects more than this).
const MAX_DATA: usize = 128;
/// Ids are exchanged as JavaScript numbers by the xterm backend; keep the same range.
const MAX_ID: u64 = (1 << 53) - 1;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;
const CAN: u8 = 0x18;
const SUB: u8 = 0x1a;
const OPEN: &[u8] = b"\x1b]7777;";
const TAG: &[u8] = b"lazysh-mosh;";

/// Why the display stopped following the transport; the session cannot recover from either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisplayFailure {
    /// A malformed, out-of-range, stale or nested envelope.
    InvalidFrame,
    /// The stream ended while a frame was still open.
    PartialFrame,
}

pub(crate) fn valid_size(cols: u16, rows: u16) -> bool {
    (2..=MAX_COLS).contains(&cols)
        && (1..=MAX_ROWS).contains(&rows)
        && u32::from(cols) * u32::from(rows) <= MAX_FRAME_CELLS
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Signal {
    Begin { id: u64, cols: u16, rows: u16 },
    End { id: u64 },
    Malformed,
}

enum State {
    Ground,
    /// Matched this many bytes of `ESC ] 7777 ;`.
    Open(usize),
    /// Inside the OSC text; `data` holds what follows `7777;`.
    Data,
    /// Saw ESC inside the text: `\` makes it ST.
    DataEsc,
}

struct Scanner {
    state: State,
    data: Vec<u8>,
}

impl Scanner {
    /// The next completed envelope at or after `from`, as the offset just past its terminator.
    /// `None` consumes the rest of the chunk (the state carries over to the next one).
    fn find(&mut self, chunk: &[u8], from: usize) -> Option<(usize, Signal)> {
        let mut i = from;
        while i < chunk.len() {
            let b = chunk[i];
            i += 1;
            match self.state {
                State::Ground => {
                    if b == ESC {
                        self.state = State::Open(1);
                    }
                }
                State::Open(n) if b == OPEN[n] => {
                    self.state = if n + 1 == OPEN.len() {
                        self.data.clear();
                        State::Data
                    } else {
                        State::Open(n + 1)
                    };
                }
                State::Open(_) => {
                    self.state = if b == ESC {
                        State::Open(1)
                    } else {
                        State::Ground
                    };
                }
                State::Data => match b {
                    BEL => {
                        if let Some(signal) = self.finish() {
                            return Some((i, signal));
                        }
                    }
                    ESC => self.state = State::DataEsc,
                    CAN | SUB => self.state = State::Ground,
                    _ => {
                        self.data.push(b);
                        let n = self.data.len();
                        if n <= TAG.len() && b != TAG[n - 1] {
                            // Some other OSC 7777: not ours, leave it to the VT.
                            self.state = State::Ground;
                        } else if n > MAX_DATA {
                            self.state = State::Ground;
                            return Some((i, Signal::Malformed));
                        }
                    }
                },
                State::DataEsc => {
                    if b == b'\\' {
                        if let Some(signal) = self.finish() {
                            return Some((i, signal));
                        }
                    } else {
                        // The ESC started another sequence, so the text was never terminated:
                        // fail closed if it was ours, and read this byte again as what follows
                        // that ESC.
                        let ours = self.data.len() >= TAG.len();
                        self.state = State::Open(1);
                        if ours {
                            return Some((i - 1, Signal::Malformed));
                        }
                        i -= 1;
                    }
                }
            }
        }
        None
    }

    /// `Some` unless the text was too short to be ours (some other, shorter OSC 7777).
    fn finish(&mut self) -> Option<Signal> {
        self.state = State::Ground;
        (self.data.len() >= TAG.len()).then(|| parse(&self.data[TAG.len()..]))
    }
}

/// `[1-9][0-9]{0,max-1}`, as the xterm backend's patterns.
fn number(text: Option<&[u8]>, max_digits: usize) -> Option<u64> {
    let text = text?;
    if text.is_empty()
        || text.len() > max_digits
        || text[0] == b'0'
        || !text.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    std::str::from_utf8(text).ok()?.parse().ok()
}

fn parse(body: &[u8]) -> Signal {
    let mut parts = body.split(|&b| b == b';');
    let signal = (|| {
        if parts.next()? != b"1" {
            return None;
        }
        let signal = match parts.next()? {
            b"begin" => Signal::Begin {
                id: number(parts.next(), 16)?,
                cols: number(parts.next(), 3)? as u16,
                rows: number(parts.next(), 3)? as u16,
            },
            b"end" => Signal::End {
                id: number(parts.next(), 16)?,
            },
            _ => return None,
        };
        parts.next().is_none().then_some(signal)
    })();
    signal.unwrap_or(Signal::Malformed)
}

/// What the runtime must do after an envelope.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    Resize { cols: u16, rows: u16 },
    Failed(DisplayFailure),
}

/// Envelope tracking for one Mosh session: ordering, the open frame, and the sticky failure.
pub(crate) struct Display {
    scanner: Scanner,
    active: Option<u64>,
    last: u64,
    failure: Option<DisplayFailure>,
    finished: bool,
}

impl Display {
    pub(crate) fn new() -> Self {
        Self {
            scanner: Scanner {
                state: State::Ground,
                data: Vec::new(),
            },
            active: None,
            last: 0,
            failure: None,
            finished: false,
        }
    }

    pub(crate) fn failure(&self) -> Option<DisplayFailure> {
        self.failure
    }

    /// Whether envelopes still matter: after a failure or the end of the stream they are ignored.
    pub(crate) fn scanning(&self) -> bool {
        self.failure.is_none() && !self.finished
    }

    pub(crate) fn find(&mut self, chunk: &[u8], from: usize) -> Option<(usize, Signal)> {
        self.scanner.find(chunk, from)
    }

    pub(crate) fn handle(&mut self, signal: Signal) -> Option<Action> {
        if !self.scanning() {
            return None;
        }
        match signal {
            Signal::Begin { id, cols, rows }
                if id <= MAX_ID
                    && id > self.last
                    && self.active.is_none()
                    && valid_size(cols, rows) =>
            {
                self.active = Some(id);
                self.last = id;
                Some(Action::Resize { cols, rows })
            }
            Signal::End { id } if self.active == Some(id) => {
                self.active = None;
                None
            }
            _ => Some(self.fail(DisplayFailure::InvalidFrame)),
        }
    }

    /// The transport ended: a frame that never got its `end` was partial. Idempotent.
    pub(crate) fn finish(&mut self) -> Option<Action> {
        let open = self.active.take().is_some();
        let was_scanning = self.scanning();
        self.finished = true;
        (open && was_scanning).then(|| self.fail(DisplayFailure::PartialFrame))
    }

    pub(crate) fn fail(&mut self, failure: DisplayFailure) -> Action {
        self.failure = Some(failure);
        self.active = None;
        Action::Failed(failure)
    }
}

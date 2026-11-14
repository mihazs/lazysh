#![allow(dead_code)]
use lazysh_terminal_runtime::{
    ffi, Appearance, CellWide, Config, Frame, Hooks, Hub, Image, KeyInput, Offer, Origin,
    PtyWriter, ReferenceRenderer, Refused, Session, Size, TerminalRenderer, TerminalRuntime, Theme,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::*};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub const CELL_W: u32 = 10;
pub const CELL_H: u32 = 20;

pub fn runtime(cols: u16, rows: u16) -> TerminalRuntime {
    TerminalRuntime::new(Config {
        size: Size {
            cols,
            rows,
            cell_width_px: CELL_W,
            cell_height_px: CELL_H,
        },
        ..Config::default()
    })
    .expect("runtime")
}

/// Offer in transport-sized chunks and process everything, like the transport loop will.
pub fn feed(rt: &mut TerminalRuntime, bytes: &[u8]) {
    for chunk in bytes.chunks(16 * 1024) {
        feed_chunk(rt, chunk);
    }
}

/// Offer one transport chunk and process it.
pub fn feed_chunk(rt: &mut TerminalRuntime, chunk: &[u8]) {
    match rt.offer(chunk.to_vec()) {
        Offer::Accepted => {}
        other => panic!("unexpected {other:?}"),
    }
    rt.pump(usize::MAX);
}

/// Visible text per row, blanks as spaces, trailing blanks trimmed, wide-cell spacers skipped.
pub fn lines(frame: &Frame) -> Vec<String> {
    let mut rows = frame.dirty.clone();
    rows.sort_by_key(|row| row.y);
    rows.iter()
        .map(|row| {
            let text: String = row
                .cells
                .iter()
                .filter(|cell| !matches!(cell.wide, CellWide::SpacerTail | CellWide::SpacerHead))
                .map(|cell| {
                    if cell.text.is_empty() {
                        " "
                    } else {
                        cell.text.as_str()
                    }
                })
                .collect();
            text.trim_end().to_string()
        })
        .collect()
}

pub fn screen(rt: &mut TerminalRuntime) -> Vec<String> {
    lines(&rt.snapshot().expect("snapshot"))
}

pub fn key(key: ffi::GhosttyKey, mods: u16, text: Option<&str>) -> KeyInput {
    KeyInput {
        key,
        mods,
        text: text.map(str::to_string),
        composing: false,
        repeat: false,
        release: false,
    }
}

/// Transport chunk size and credit window of the Rust session workers.
pub const CHUNK: usize = 16 * 1024;
pub const WINDOW: usize = 256 * 1024;

/// A writer that records what leaves the terminal and can refuse like a locked app would.
pub struct Recorder {
    sent: Mutex<Vec<(Origin, Vec<u8>)>>,
    pub open: AtomicBool,
}

impl Recorder {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            sent: Mutex::default(),
            open: AtomicBool::new(true),
        })
    }

    pub fn sent(&self) -> Vec<(Origin, Vec<u8>)> {
        self.sent.lock().unwrap().clone()
    }
}

impl PtyWriter for Recorder {
    fn write(&self, origin: Origin, bytes: &[u8]) -> Result<(), Refused> {
        if !self.open.load(Acquire) {
            return Err(Refused);
        }
        self.sent.lock().unwrap().push((origin, bytes.to_vec()));
        Ok(())
    }
}

/// The transport's credit window: a producer blocks here until the VT has parsed earlier bytes.
pub struct Window {
    free: Mutex<usize>,
    freed: Condvar,
}

impl Window {
    pub fn new(bytes: usize) -> Arc<Self> {
        Arc::new(Self {
            free: Mutex::new(bytes),
            freed: Condvar::new(),
        })
    }

    pub fn acquire(&self, bytes: usize) {
        let mut free = self.free.lock().unwrap();
        while *free < bytes {
            free = self.freed.wait(free).unwrap();
        }
        *free -= bytes;
    }

    pub fn release(&self, bytes: usize) {
        *self.free.lock().unwrap() += bytes;
        self.freed.notify_all();
    }
}

pub fn config(cols: u16, rows: u16, scrollback_bytes: usize) -> Config {
    Config {
        size: Size {
            cols,
            rows,
            cell_width_px: CELL_W,
            cell_height_px: CELL_H,
        },
        scrollback_bytes,
        ingress_bytes: WINDOW,
        ..Config::default()
    }
}

/// Hooks that accept everything and return credit immediately: for tests of other properties.
pub fn quiet_hooks() -> Hooks {
    Hooks {
        writer: Recorder::new(),
        credit: Box::new(|_| {}),
        changed: None,
    }
}

pub struct Fixture {
    pub session: Session,
    pub writer: Arc<Recorder>,
    pub window: Arc<Window>,
    pub credited: Arc<AtomicU64>,
}

pub fn session(hub: &Hub, id: &str, config: Config) -> Fixture {
    session_watched(hub, id, config).0
}

/// Also returns how many times the session told its (attached) view that the screen may have changed.
pub fn session_watched(hub: &Hub, id: &str, config: Config) -> (Fixture, Arc<AtomicU64>) {
    let changes = Arc::new(AtomicU64::new(0));
    let writer = Recorder::new();
    let window = Window::new(config.ingress_bytes);
    let credited = Arc::new(AtomicU64::new(0));
    let hooks = Hooks {
        writer: writer.clone(),
        credit: {
            let (window, credited) = (window.clone(), credited.clone());
            Box::new(move |bytes| {
                credited.fetch_add(bytes as u64, SeqCst);
                window.release(bytes);
            })
        },
        changed: Some({
            let changes = changes.clone();
            Box::new(move || {
                changes.fetch_add(1, SeqCst);
            })
        }),
    };
    let session = hub.create(id, config, hooks).expect("create");
    let fixture = Fixture {
        session,
        writer,
        window,
        credited,
    };
    (fixture, changes)
}

impl Fixture {
    /// What a transport worker does: take credit, then feed; never more than the window in flight.
    pub fn send(&self, bytes: &[u8]) {
        for chunk in bytes.chunks(CHUNK) {
            self.window.acquire(chunk.len());
            assert_eq!(
                self.session.feed(chunk.to_vec()).unwrap(),
                Offer::Accepted,
                "a producer holding credit is never refused"
            );
        }
    }

    pub fn settle(&self, total: u64) {
        wait_until(|| self.session.stats().unwrap().processed == total);
    }
}

pub fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting");
        std::thread::sleep(Duration::from_millis(1));
    }
}

/// Lines of exactly one known width each, so the whole history is a function of every byte.
pub fn numbered_lines(count: usize) -> Vec<u8> {
    (0..count)
        .flat_map(|n| {
            format!("line {n:07} the quick brown fox jumps over the lazy dog\r\n").into_bytes()
        })
        .collect()
}

/// A CPU reference renderer on an 8x16 pixel cell surface for `size`.
pub fn reference_renderer(size: Size) -> ReferenceRenderer {
    let (w, h) = (u32::from(size.cols) * 8, u32::from(size.rows) * 16);
    let surface = Image::new(w, h, Theme::default().background).unwrap();
    ReferenceRenderer::create(surface, Appearance::default()).unwrap()
}

/// What a renderer does with a frame: apply it, draw the dirty rows, present.
pub fn draw_frame(renderer: &mut ReferenceRenderer, frame: &Frame) {
    renderer.apply(frame).expect("apply");
    renderer.draw().expect("draw");
    renderer.present().expect("present");
}

/// One pass of `data` through a fresh 80x24 runtime in transport-sized chunks, calling `after_chunk`
/// (a frame per chunk, for example) after each one; MiB/s of the whole pass.
pub fn pass(data: &[u8], mut after_chunk: Option<&mut dyn FnMut(&mut TerminalRuntime)>) -> f64 {
    let mut rt = runtime(80, 24);
    let start = Instant::now();
    for chunk in data.chunks(CHUNK) {
        feed_chunk(&mut rt, chunk);
        if let Some(after_chunk) = after_chunk.as_deref_mut() {
            after_chunk(&mut rt);
        }
    }
    data.len() as f64 / (1024.0 * 1024.0) / start.elapsed().as_secs_f64()
}

pub fn with_scrollback(cols: u16, bytes: usize) -> TerminalRuntime {
    TerminalRuntime::new(Config {
        size: Size::new(cols, 24),
        scrollback_bytes: bytes,
        ..Config::default()
    })
    .expect("runtime")
}

/// Numbered lines that exactly fill `cols` minus one column, so none wraps.
pub fn fit_lines(total: usize, cols: usize) -> Vec<u8> {
    (0..)
        .flat_map(|n| format!("{n:0>w$}\r\n", w = cols - 1).into_bytes())
        .take(total)
        .collect()
}

/// Scrollback rows kept after feeding `data` at a byte budget (libghostty-vt budgets bytes, lazysh lines).
pub fn rows_kept(cols: u16, budget: usize, data: &[u8]) -> usize {
    let mut rt = with_scrollback(cols, budget);
    feed(&mut rt, data);
    rt.scrollback_rows().unwrap()
}

/// Resident growth in KiB for `count` sessions that each received `data` at the default budget;
/// `None` where /proc is unavailable. The sessions are dropped before returning.
pub fn sessions_rss_growth(count: usize, data: &[u8]) -> Option<u64> {
    let before = rss_kib()?;
    let mut sessions: Vec<TerminalRuntime> = (0..count).map(|_| runtime(80, 24)).collect();
    for session in &mut sessions {
        feed(session, data);
    }
    Some(rss_kib()?.saturating_sub(before))
}

/// Resident set in KiB (Linux), for memory measurements.
pub fn rss_kib() -> Option<u64> {
    let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
    Some(statm.split_whitespace().nth(1)?.parse::<u64>().ok()? * 4)
}

/// (median, min, max) of a sample set.
pub fn median(mut v: Vec<f64>) -> (f64, f64, f64) {
    v.sort_by(f64::total_cmp);
    (v[v.len() / 2], v[0], v[v.len() - 1])
}

pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

/// Benchmark volume per workload: 64 MiB.
pub const TOTAL: usize = 64 * 1024 * 1024;

pub fn plain(total: usize) -> Vec<u8> {
    (0..)
        .flat_map(|n| {
            format!(
                "line {n:08} the quick brown fox jumps over the lazy dog 0123456789 abcdefghij\r\n"
            )
            .into_bytes()
        })
        .take(total)
        .collect()
}

pub fn ansi_color(total: usize) -> Vec<u8> {
    (0..).flat_map(|n| format!("\x1b[{}m word{n}\x1b[0m \x1b[1;38;2;{};{};200mtruecolor\x1b[0m \x1b[48;5;{}m  \x1b[0m\r\n", 31 + n % 7, n % 256, (n * 7) % 256, n % 256).into_bytes()).take(total).collect()
}

/// Full-screen redraw: home, then 24 rows of positioned colored text, like a TUI repaint.
pub fn redraw(total: usize) -> Vec<u8> {
    let frame: String = std::iter::once("\x1b[H".to_string())
        .chain((1..=24).map(|row| {
            format!(
                "\x1b[{row};1H\x1b[{}m{:<80}\x1b[0m",
                30 + row % 8,
                format!("row {row} status ▕██████▏ 42%")
            )
        }))
        .collect();
    frame.into_bytes().into_iter().cycle().take(total).collect()
}

pub fn unicode(total: usize) -> Vec<u8> {
    "日本語のテキスト 😀 e\u{301}\u{302} 👨\u{200d}👩\u{200d}👧 한국어 ‑ العربية\r\n"
        .as_bytes()
        .iter()
        .copied()
        .cycle()
        .take(total)
        .collect()
}

/// A workload name as a file name: lowercase ASCII, anything else a dash.
pub fn slug(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

pub fn workloads() -> [(&'static str, Vec<u8>); 4] {
    [
        ("plain text", plain(TOTAL)),
        ("ANSI + truecolor", ansi_color(TOTAL)),
        ("full-screen redraw", redraw(TOTAL)),
        ("CJK/emoji/combining", unicode(TOTAL)),
    ]
}

/// The host load changes these numbers by tens of percent, so every result records it.
pub fn load_average() -> String {
    std::fs::read_to_string("/proc/loadavg")
        .unwrap_or_default()
        .trim()
        .to_string()
}

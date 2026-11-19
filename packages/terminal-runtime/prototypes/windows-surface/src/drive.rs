//! The probe's script, on a thread of its own so the window thread keeps pumping messages while it waits: for each way of
//! stacking and painting the surface it creates, moves, destroys and recreates it, and after every step reads the window back
//! twice (PrintWindow and a screen copy) and judges what is on screen. It reports; it does not decide the strategy.
use crate::{
    app::{Cmd, Layout, Msg, Shared},
    capture::{self, Readback},
    child::{Order, Paint},
    pixels::{judge, Judgement, Rect},
};
use std::{fmt::Write as _, fs, path::PathBuf, sync::mpsc, thread::sleep, time::Duration};
use tao::event_loop::EventLoopProxy;

const GREEN: [u8; 3] = [0, 200, 0];
const BLUE: [u8; 3] = [0x33, 0x66, 0xff];
/// DirectComposition and the swapchain present asynchronously; the Linux probe waits as long.
const SETTLE: Duration = Duration::from_millis(1200);
const HOME: [f64; 4] = [60.0, 40.0, 240.0, 160.0];
const MOVED: [f64; 4] = [110.0, 70.0, 150.0, 100.0];
const READBACKS: [Readback; 2] = [Readback::Screen, Readback::PrintWindow];

struct Row {
    surface: String,
    readback: Readback,
    seen: Result<Judgement, String>,
}

struct Probe {
    hwnd: isize,
    proxy: EventLoopProxy<Msg>,
    shared: Shared,
    out: PathBuf,
    rows: Vec<Row>,
    notes: Vec<String>,
}

fn die(why: &str) -> ! {
    eprintln!("probe stopped: {why}");
    std::process::exit(2)
}

impl Probe {
    fn ask(&self, cmd: Cmd) -> Result<String, String> {
        let (reply, answer) = mpsc::channel();
        self.proxy
            .send_event(Msg::Do(cmd, reply))
            .map_err(|e| e.to_string())?;
        answer
            .recv_timeout(Duration::from_secs(30))
            .unwrap_or_else(|_| die("the window thread did not answer"))
    }

    /// The latest layout the page reported, once it matches `css` when one is given.
    fn layout_at(&self, css: Option<[f64; 4]>) -> Layout {
        for _ in 0..400 {
            let layout = *self.shared.lock().unwrap();
            if let Some(l) =
                layout.filter(|l| css.is_none_or(|css| l.anchor == Rect::from_css(css, l.dpr)))
            {
                return l;
            }
            sleep(Duration::from_millis(50));
        }
        die("the page did not report the expected layout")
    }

    fn move_anchor(&self, css: [f64; 4]) {
        let [x, y, w, h] = css;
        self.ask(Cmd::Script(format!("setAnchor({x},{y},{w},{h})")))
            .unwrap_or_else(|e| die(&e));
        self.layout_at(Some(css));
        sleep(SETTLE);
    }

    fn measure(&mut self, surface: &str, step: &'static str, colour: [u8; 3], shown: bool) {
        let layout = self.layout_at(None);
        for readback in READBACKS {
            let seen = capture::client(self.hwnd as _, readback).and_then(|frame| {
                let path = self.out.join(format!("{surface}-{step}-{readback:?}.png"));
                frame.save_png(&path)?;
                Ok(judge(&frame, layout.anchor, layout.overlay, colour, shown))
            });
            println!("{surface} {step} {readback:?}: {seen:?}");
            self.rows.push(Row {
                surface: surface.into(),
                readback,
                seen,
            });
        }
    }

    fn scenario(&mut self, order: Order, paint: Paint) {
        let name = format!("{order:?}-{paint:?}").to_lowercase();
        self.move_anchor(HOME);
        match self.ask(Cmd::Create(order, paint, GREEN)) {
            Ok(adapter) => self.notes.push(format!("{name}: created {adapter}")),
            Err(why) => return self.notes.push(format!("{name}: unavailable: {why}")),
        }
        sleep(SETTLE);
        self.measure(&name, "created", GREEN, true);
        self.move_anchor(MOVED);
        self.measure(&name, "moved", GREEN, true);
        self.ask(Cmd::Destroy).unwrap_or_else(|e| die(&e));
        sleep(SETTLE);
        self.measure(&name, "destroyed", GREEN, false);
        self.ask(Cmd::Create(order, paint, BLUE))
            .unwrap_or_else(|e| die(&e));
        sleep(SETTLE);
        self.measure(&name, "recreated", BLUE, true);
        self.ask(Cmd::Destroy).unwrap_or_else(|e| die(&e));
    }

    /// One line per surface and readback: pass or fail for each step, whether the page's overlay stayed on top, and the colour at the anchor.
    fn report(&self) -> String {
        let mut table = String::from("| Surface | Readback | Created | Moved | Destroyed | Recreated | Overlay over surface | Colour at anchor, created |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n");
        let mut surfaces: Vec<_> = self
            .rows
            .iter()
            .map(|r| r.surface.as_str())
            .filter(|s| *s != "control")
            .collect();
        surfaces.dedup();
        for surface in surfaces {
            for readback in READBACKS {
                let rows: Vec<_> = self
                    .rows
                    .iter()
                    .filter(|r| r.surface == surface && r.readback == readback)
                    .collect();
                let steps: Vec<_> = rows
                    .iter()
                    .map(|r| {
                        r.seen
                            .as_ref()
                            .map_or("error", |j| if j.placed() { "pass" } else { "fail" })
                    })
                    .collect();
                let overlay = if rows
                    .iter()
                    .all(|r| r.seen.as_ref().is_ok_and(Judgement::overlay_on_top))
                {
                    "yes"
                } else {
                    "no"
                };
                let centre = rows
                    .first()
                    .and_then(|r| r.seen.as_ref().ok()?.centre)
                    .map_or("-".into(), |[r, g, b]| format!("#{r:02x}{g:02x}{b:02x}"));
                let _ = writeln!(
                    table,
                    "| {surface} | {readback:?} | {} | {overlay} | {centre} |",
                    steps.join(" | ")
                );
            }
        }
        table
    }
}

pub fn run(hwnd: isize, proxy: EventLoopProxy<Msg>, shared: Shared, out: PathBuf) -> ! {
    let mut probe = Probe {
        hwnd,
        proxy,
        shared,
        out,
        rows: Vec::new(),
        notes: Vec::new(),
    };
    probe.layout_at(None);
    sleep(SETTLE);
    // Control: no surface yet. If the page is not drawn in a readback, that readback sees nothing and its results mean nothing.
    probe.measure("control", "none", GREEN, false);
    let valid = |how: Readback| {
        probe
            .rows
            .iter()
            .any(|r| r.readback == how && r.seen.as_ref().is_ok_and(Judgement::overlay_on_top))
    };
    let (screen, print_window) = (valid(Readback::Screen), valid(Readback::PrintWindow));
    if screen {
        for paint in [Paint::Gdi, Paint::Direct3D12] {
            for order in [Order::Below, Order::BelowClipped, Order::AboveCutOut] {
                probe.scenario(order, paint);
            }
        }
    }
    let report = format!(
        "Control (no surface): the page's overlay is drawn in the screen readback: {screen}; in the PrintWindow readback: {print_window}.\n\n{}\n{}\n",
        probe.report(),
        probe.notes.join("\n")
    );
    fs::write(probe.out.join("report.md"), &report).unwrap_or_else(|e| die(&e.to_string()));
    println!("\n{report}");
    std::process::exit(if screen { 0 } else { 2 })
}

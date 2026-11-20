//! The driver: runs the scenarios on its own thread, asks the host (the main thread) to act, and judges what the window server shows.
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::mpsc::{self, Receiver};
use std::thread::sleep;
use std::time::{Duration, Instant};

use surface_analysis::{is_color, is_red, page_origin, Raster, Rect};
use tao::event_loop::EventLoopProxy;

use crate::capture;
use crate::host::{out_dir, Cmd, Event2, Info, Msg, Reply};

pub struct Settings {
    pub want_scale: Option<f64>,
    pub transparent: bool,
}

impl Settings {
    pub fn from_env() -> Self {
        Self {
            want_scale: std::env::var("POC_SCALE").ok().and_then(|v| v.parse().ok()),
            transparent: std::env::var("POC_TRANSPARENT").map_or(true, |v| v != "0"),
        }
    }
}

type Outcome<T> = Result<T, String>;

/// The page's boxes in CSS pixels from the web view's corner: the anchor the page reports, the DOM box over its corner, the anchor
/// after the page moves it.
const ANCHOR: [f64; 4] = [60.0, 40.0, 240.0, 160.0];
const DOM_BOX: [f64; 4] = [200.0, 120.0, 140.0, 100.0];
const MOVED: [f64; 4] = [110.0, 70.0, 150.0, 100.0];
const BLUE: u32 = 0x3366ff;
const ORANGE: u32 = 0xff9900;
/// How far a pixel of the surface may be from the colour it was asked for (the window server may colour-match) and from the
/// colour seen at the anchor's interior (the surface is one colour).
const NOMINAL_TOLERANCE: u8 = 40;
const SEEN_TOLERANCE: u8 = 6;
/// Placement is judged exact within this many device pixels on every edge.
const PLACEMENT_LIMIT: i64 = 1;
const SETTLE: Duration = Duration::from_secs(6);

pub fn run(settings: Settings, proxy: EventLoopProxy<Msg>, events: Receiver<Event2>) {
    let quit = proxy.clone();
    let code = drive(settings, proxy, events).unwrap_or_else(|why| {
        println!("ERROR {why}");
        2
    });
    let (reply, _) = mpsc::channel();
    let _ = quit.send_event(Msg::Cmd(Cmd::Quit(code), reply));
}

struct Probe {
    proxy: EventLoopProxy<Msg>,
    events: Receiver<Event2>,
    logs: Vec<String>,
    last_anchor: Option<[f64; 4]>,
    out: PathBuf,
    records: File,
    label: String,
    settings: Settings,
    scale: f64,
    window: u32,
    origin: (i64, i64),
    failed: bool,
    checks: (usize, usize),
}

fn json(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

fn rgb(color: u32) -> [u8; 3] {
    [(color >> 16) as u8, (color >> 8) as u8, color as u8]
}

fn drive(settings: Settings, proxy: EventLoopProxy<Msg>, events: Receiver<Event2>) -> Outcome<i32> {
    let out = out_dir();
    fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let records = OpenOptions::new()
        .create(true)
        .append(true)
        .open(out.join("records.jsonl"))
        .map_err(|e| e.to_string())?;
    let mut probe = Probe {
        proxy,
        events,
        logs: Vec::new(),
        last_anchor: None,
        out,
        records,
        label: String::new(),
        settings,
        scale: 1.0,
        window: 0,
        origin: (0, 0),
        failed: false,
        checks: (0, 0),
    };
    probe.wait_anchor(None)?;
    let info = probe.info()?;
    if let Some(want) = probe.settings.want_scale {
        if (info.scale - want).abs() > 0.01 {
            println!(
                "SKIP wanted a {want}x display, the window is on a {}x one",
                info.scale
            );
            return Ok(3);
        }
    }
    probe.scale = info.scale;
    probe.window = info.window;
    probe.label = format!(
        "{}x{}",
        info.scale,
        if probe.settings.transparent {
            ""
        } else {
            "-opaque"
        }
    );
    println!(
        "INFO scale {}x, window {}x{} points with a {}x{} content view (flipped: {}), views {}",
        info.scale,
        info.frame.0,
        info.frame.1,
        info.content.0,
        info.content.1,
        info.flipped,
        info.chain
    );
    if probe.settings.transparent {
        probe.scenarios()?;
    } else {
        probe.opaque_control()?;
    }
    println!(
        "SUMMARY {}: {} checks passed, {} failed",
        probe.label, probe.checks.0, probe.checks.1
    );
    Ok(i32::from(probe.failed))
}

impl Probe {
    fn command(&self, cmd: Cmd) -> Outcome<Reply> {
        let (reply, answer) = mpsc::channel();
        self.proxy
            .send_event(Msg::Cmd(cmd, reply))
            .map_err(|_| "the host has gone".to_string())?;
        answer
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| "the host did not answer".to_string())
    }

    fn done(&self, cmd: Cmd) -> Outcome<()> {
        match self.command(cmd)? {
            Reply::Text(text) if text.starts_with("error") => Err(text),
            _ => Ok(()),
        }
    }

    fn text(&self, cmd: Cmd) -> Outcome<String> {
        match self.command(cmd)? {
            Reply::Text(text) => Ok(text),
            _ => Err("the host answered with something else".into()),
        }
    }

    fn info(&self) -> Outcome<Info> {
        match self.command(Cmd::Info)? {
            Reply::Info(info) => Ok(info),
            _ => Err("the host answered with something else".into()),
        }
    }

    fn pump(&mut self, wait: Duration) -> bool {
        match self.events.recv_timeout(wait) {
            Ok(Event2::Anchor(a)) => self.last_anchor = Some(a),
            Ok(Event2::Log(m)) => self.logs.push(m),
            Err(_) => return false,
        }
        true
    }

    /// Waits until the page reports an anchor (`want`, or any).
    fn wait_anchor(&mut self, want: Option<[f64; 4]>) -> Outcome<[f64; 4]> {
        let end = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(a) = self.last_anchor {
                if want.is_none_or(|w| a.iter().zip(w).all(|(a, w)| (a - w).abs() < 0.5)) {
                    return Ok(a);
                }
            }
            if Instant::now() > end {
                return Err(format!(
                    "the page never reported the anchor {want:?}; last {:?}",
                    self.last_anchor
                ));
            }
            self.pump(Duration::from_millis(100));
        }
    }

    /// Whether the page logged a line starting with `prefix` after the first `mark` lines.
    fn wait_log(&mut self, prefix: &str, mark: usize, wait: Duration) -> bool {
        let end = Instant::now() + wait;
        while Instant::now() < end {
            if self.logs[mark..].iter().any(|l| l.starts_with(prefix)) {
                return true;
            }
            self.pump(Duration::from_millis(100));
        }
        false
    }

    fn record(&mut self, scenario: &str, name: &str, verdict: &str, detail: &str) {
        println!("{verdict} {scenario} / {name}: {detail}");
        let _ = writeln!(
            self.records,
            r#"{{"scale":{},"transparent":{},"scenario":"{}","check":"{}","verdict":"{}","detail":"{}"}}"#,
            self.scale,
            self.settings.transparent,
            json(scenario),
            json(name),
            verdict,
            json(detail)
        );
    }

    fn check(&mut self, scenario: &str, name: &str, ok: bool, detail: String) {
        self.record(scenario, name, if ok { "PASS" } else { "FAIL" }, &detail);
        self.failed |= !ok;
        if ok {
            self.checks.0 += 1
        } else {
            self.checks.1 += 1
        }
    }

    fn note(&mut self, scenario: &str, name: &str, detail: String) {
        self.record(scenario, name, "INFO", &detail);
    }

    fn rect(&self, css: [f64; 4]) -> Rect {
        Rect::from_css(css, self.origin, self.scale)
    }

    fn point(&self, x: f64, y: f64) -> (i64, i64) {
        let r = self.rect([x, y, 0.0, 0.0]);
        (r.x, r.y)
    }

    /// Captures the window until `done` holds (the page-to-native hop and the window server are asynchronous) or the time is up,
    /// and keeps the last image as a PNG. Returns it with whether the condition held and how long that took.
    fn capture_until(
        &mut self,
        step: &str,
        done: impl Fn(&Probe, &Raster) -> bool,
    ) -> Outcome<(Raster, bool, u128)> {
        let start = Instant::now();
        let (shot, held) = loop {
            let shot = capture::window_image(self.window)?;
            let held = done(self, &shot);
            if held || start.elapsed() > SETTLE {
                break (shot, held);
            }
            sleep(Duration::from_millis(200));
        };
        let path = self.out.join(format!("{}-{step}.png", self.label));
        if let Err(why) = capture::write_png(&shot, &path) {
            println!("INFO could not write {}: {why}", path.display());
        }
        Ok((shot, held, start.elapsed().as_millis()))
    }

    fn capture_after(&mut self, step: &str, pause: Duration) -> Outcome<Raster> {
        sleep(pause);
        Ok(self.capture_until(step, |_, _| true)?.0)
    }

    /// Whether `shot` shows a surface of `color` within the placement limit of `anchor`.
    fn placed(&self, shot: &Raster, anchor: [f64; 4], color: u32) -> bool {
        shot.largest_region(|px| is_color(px, rgb(color), NOMINAL_TOLERANCE))
            .is_some_and(|(found, _)| found.error(&self.rect(anchor)) <= PLACEMENT_LIMIT)
    }

    /// Calibrates the page origin from the red DOM box, which no surface ever covers entirely.
    fn calibrate(&mut self, shot: &Raster, scenario: &str) -> bool {
        match page_origin(shot, DOM_BOX, self.scale) {
            Some(origin) => {
                if origin != self.origin && self.origin != (0, 0) {
                    self.note(
                        scenario,
                        "page origin",
                        format!("moved from {:?} to {origin:?}", self.origin),
                    );
                }
                self.origin = origin;
                true
            }
            None => false,
        }
    }

    fn placement(
        &mut self,
        scenario: &str,
        shot: &Raster,
        anchor: [f64; 4],
        color: u32,
    ) -> [u8; 3] {
        let want = self.rect(anchor);
        let (cx, cy) = self.point(anchor[0] + 12.0, anchor[1] + 12.0);
        let pixel = shot.get(cx, cy);
        let nominal = rgb(color);
        let near = pixel.map(|p| {
            (0..3)
                .map(|i| (i16::from(p[i]) - i16::from(nominal[i])).abs())
                .max()
                .unwrap_or(0)
        });
        self.check(
            scenario,
            "surface shows through the transparent web view",
            pixel.is_some_and(|p| p[3] == 255)
                && near.is_some_and(|n| n <= i16::from(NOMINAL_TOLERANCE)),
            format!("pixel {pixel:?} inside the anchor, asked for {nominal:?}, {near:?} off"),
        );
        let seen = pixel.map_or(nominal, |p| [p[0], p[1], p[2]]);
        let found = shot.largest_region(|px| is_color(px, seen, SEEN_TOLERANCE));
        let verdict = found.map(|(r, n)| (r.error(&want), r, n));
        self.check(
            scenario,
            "placement at the DOM anchor",
            verdict.is_some_and(|(error, ..)| error <= PLACEMENT_LIMIT),
            match verdict {
                Some((error, found, n)) => {
                    format!("surface {found:?}, anchor {want:?}, error {error} px, {n} pixels")
                }
                None => format!("no pixel of the surface colour in the capture; anchor {want:?}"),
            },
        );
        seen
    }

    /// The DOM box over the anchor's corner must stay on top of a surface below the web view, and be hidden by one above it.
    fn overlap(
        &mut self,
        scenario: &str,
        shot: &Raster,
        anchor: [f64; 4],
        surface: [u8; 3],
        box_on_top: bool,
    ) {
        let Some(shared) = self.rect(anchor).intersect(&self.rect(DOM_BOX)) else {
            return self.check(
                scenario,
                "DOM box over the surface",
                false,
                "the anchor and the box do not overlap".into(),
            );
        };
        let (x, y) = shared.center();
        let px = shot.px(x, y);
        let on_top = is_red(px);
        let covered = is_color(px, surface, SEEN_TOLERANCE);
        let (name, ok) = if box_on_top {
            ("DOM box stays on top of the surface", on_top)
        } else {
            (
                "DOM box is hidden by a surface above the web view (the check can fail)",
                covered,
            )
        };
        self.check(
            scenario,
            name,
            ok,
            format!("pixel {px:?} at the centre of the overlap, {shared:?}"),
        );
        if box_on_top {
            let whole = shot
                .largest_region(is_red)
                .map(|(r, _)| r.error(&self.rect(DOM_BOX)));
            self.check(
                scenario,
                "DOM box is drawn whole",
                whole.is_some_and(|e| e <= PLACEMENT_LIMIT),
                format!("box edges off by {whole:?} px"),
            );
        }
    }

    fn transparent_elsewhere(&mut self, scenario: &str, shot: &Raster) {
        let (x, y) = self.point(400.0, 300.0);
        let px = shot.get(x, y);
        self.check(
            scenario,
            "the page stays transparent away from the surface",
            px.is_some_and(|p| p[3] == 0),
            format!("pixel {px:?} at (400,300) CSS"),
        );
    }

    /// Pointer and keyboard routing: AppKit's hit test and first responder, and, when synthesized clicks reach the page at all
    /// (`clicks`), one click through `NSWindow.sendEvent` inside the anchor.
    fn routing(
        &mut self,
        scenario: &str,
        anchor: [f64; 4],
        clicks: bool,
        surface_on_top: bool,
        baseline_responder: bool,
    ) -> Outcome<()> {
        let (x, y) = (anchor[0] + 12.0, anchor[1] + 12.0);
        let route = self.text(Cmd::Route(x, y))?;
        let flag = |key: &str| route.contains(&format!("{key}=true"));
        self.check(
            scenario,
            if surface_on_top {
                "a surface above the web view takes the pointer (the check can fail)"
            } else {
                "pointer hit test reaches the web view"
            },
            flag("hit_web") != surface_on_top,
            route.clone(),
        );
        self.check(
            scenario,
            "keyboard focus stays where it was before the surface",
            flag("responder_web") == baseline_responder,
            format!(
                "first responder in the web view: {}, before the surface: {baseline_responder}",
                flag("responder_web")
            ),
        );
        if clicks {
            let mark = self.logs.len();
            self.done(Cmd::Click(x, y))?;
            let arrived = self.wait_log(
                &format!("mousedown {x},{y}"),
                mark,
                Duration::from_secs(if surface_on_top { 2 } else { 5 }),
            );
            let detail = format!("page logged: {:?}", &self.logs[mark..]);
            if surface_on_top {
                // Reported, not judged: the comparison exists to show the hit test, and a synthesized click is not a real one.
                self.note(
                    scenario,
                    "a click in the anchor with the surface on top",
                    format!("reaches the page: {arrived}; {detail}"),
                );
            } else {
                self.check(
                    scenario,
                    "a click in the anchor reaches the page",
                    arrived,
                    detail,
                );
            }
        }
        Ok(())
    }

    /// The first capture, with the page and nothing else, once the DOM box shows in it; it fixes the page origin.
    fn capture_page(&mut self, scenario: &str) -> Outcome<Raster> {
        let (shot, held, _) =
            self.capture_until("1-page", |p, s| page_origin(s, DOM_BOX, p.scale).is_some())?;
        if !held {
            return Err("the DOM box never showed in the capture of the window".into());
        }
        self.calibrate(&shot, scenario);
        Ok(shot)
    }

    fn scenarios(&mut self) -> Outcome<()> {
        // 1. The page alone: transparent over the pane, and where the page sits in the capture.
        let shot = self.capture_page("page")?;
        let info = self.info()?;
        self.note(
            "page",
            "capture geometry",
            format!(
                "image {}x{} px for a {}x{} point window at {}x; page origin {:?} px, from the window's own geometry {:?}",
                shot.width,
                shot.height,
                info.frame.0,
                info.frame.1,
                self.scale,
                self.origin,
                (0, ((info.frame.1 - info.content.1) * self.scale).round() as i64)
            ),
        );
        let (x, y) = self.point(ANCHOR[0] + 120.0, ANCHOR[1] + 80.0);
        let px = shot.get(x, y);
        self.check(
            "page",
            "the web view is transparent over the pane",
            px.is_some_and(|p| p[3] == 0),
            format!("pixel {px:?} at the anchor's centre"),
        );
        let responder = self.text(Cmd::Route(80.0, 60.0))?;
        let baseline_responder = responder.contains("responder_web=true");
        self.note("page", "routing before any surface", responder);
        let mark = self.logs.len();
        self.done(Cmd::Click(500.0, 300.0))?;
        let clicks = self.wait_log("mousedown 500,300", mark, Duration::from_secs(5));
        self.note(
            "page",
            "synthesized click",
            format!("reaches the page with no surface: {clicks}"),
        );

        // 2. The surface below the web view.
        self.done(Cmd::Create {
            rgb: BLUE,
            above: false,
        })?;
        let (shot, held, ms) = self.capture_until("2-below", |p, s| p.placed(s, ANCHOR, BLUE))?;
        self.note(
            "below",
            "settled",
            format!("{ms} ms, condition held: {held}"),
        );
        self.calibrate(&shot, "below");
        let surface = self.placement("below", &shot, ANCHOR, BLUE);
        self.overlap("below", &shot, ANCHOR, surface, true);
        self.transparent_elsewhere("below", &shot);
        self.routing("below", ANCHOR, clicks, false, baseline_responder)?;

        // 3. The page moves the anchor: the surface follows it.
        self.done(Cmd::Eval(format!(
            "setAnchor({},{},{},{})",
            MOVED[0], MOVED[1], MOVED[2], MOVED[3]
        )))?;
        self.wait_anchor(Some(MOVED))?;
        let (shot, held, ms) =
            self.capture_until("3-anchor-moved", |p, s| p.placed(s, MOVED, BLUE))?;
        self.note(
            "anchor change",
            "settled",
            format!("{ms} ms, condition held: {held}"),
        );
        let surface = self.placement("anchor change", &shot, MOVED, BLUE);
        self.overlap("anchor change", &shot, MOVED, surface, true);

        // 4. The window is resized and resized back: the host places the surface again.
        for (step, (w, h)) in [("4-smaller", (560.0, 360.0)), ("5-larger", (640.0, 400.0))] {
            self.done(Cmd::Resize(w, h))?;
            sleep(Duration::from_millis(500));
            let (shot, held, ms) = self.capture_until(step, |p, s| p.placed(s, MOVED, BLUE))?;
            self.note(
                "resize",
                "settled",
                format!("{w}x{h} points, {ms} ms, condition held: {held}"),
            );
            let content = self.info()?.content;
            self.calibrate(&shot, "resize");
            self.note(
                "resize",
                "content view",
                format!("{}x{} points", content.0, content.1),
            );
            let surface = self.placement(&format!("resize to {w}x{h}"), &shot, MOVED, BLUE);
            self.overlap(&format!("resize to {w}x{h}"), &shot, MOVED, surface, true);
        }

        // 5. The surface is destroyed: nothing is left at the anchor.
        self.done(Cmd::Destroy)?;
        let (shot, held, _) = self.capture_until("6-destroyed", |p, s| {
            s.find_color(rgb(BLUE), NOMINAL_TOLERANCE).is_none() && p.settings.transparent
        })?;
        let left = shot
            .find_color(rgb(BLUE), NOMINAL_TOLERANCE)
            .map(|(_, n)| n);
        self.check(
            "destroy",
            "nothing is left on screen",
            held && left.is_none(),
            format!("{left:?} pixels of the surface colour remain"),
        );

        // 6. A new surface, another colour, from the same session.
        self.done(Cmd::Create {
            rgb: ORANGE,
            above: false,
        })?;
        let (shot, held, ms) =
            self.capture_until("7-recreated", |p, s| p.placed(s, MOVED, ORANGE))?;
        self.note(
            "recreate",
            "settled",
            format!("{ms} ms, condition held: {held}"),
        );
        let surface = self.placement("recreate", &shot, MOVED, ORANGE);
        self.overlap("recreate", &shot, MOVED, surface, true);

        // 7. The comparison that must fail: the same surface above the web view.
        self.done(Cmd::Destroy)?;
        self.done(Cmd::Create {
            rgb: BLUE,
            above: true,
        })?;
        let (shot, held, ms) = self.capture_until("8-above", |p, s| p.placed(s, MOVED, BLUE))?;
        self.note(
            "above",
            "settled",
            format!("{ms} ms, condition held: {held}"),
        );
        let surface = self.placement("above", &shot, MOVED, BLUE);
        self.overlap("above", &shot, MOVED, surface, false);
        self.routing("above", MOVED, clicks, true, baseline_responder)?;
        self.done(Cmd::Destroy)?;
        Ok(())
    }

    /// The control: a web view built without wry's `drawsBackground` key paints opaque white over the pane, so a surface below it
    /// is never seen. It shows what the private key buys.
    fn opaque_control(&mut self) -> Outcome<()> {
        let shot = self.capture_page("control")?;
        let (x, y) = self.point(ANCHOR[0] + 120.0, ANCHOR[1] + 80.0);
        let px = shot.get(x, y);
        self.check(
            "control",
            "an opaque web view paints over the pane",
            px.is_some_and(|p| p[3] == 255),
            format!("pixel {px:?} at the anchor's centre"),
        );
        self.done(Cmd::Create {
            rgb: BLUE,
            above: false,
        })?;
        let shot = self.capture_after("2-below", Duration::from_millis(2000))?;
        let seen = shot
            .find_color(rgb(BLUE), NOMINAL_TOLERANCE)
            .map(|(_, n)| n);
        self.check(
            "control",
            "a surface below an opaque web view is hidden",
            seen.is_none(),
            format!("{seen:?} pixels of the surface colour"),
        );
        self.done(Cmd::Destroy)?;
        Ok(())
    }
}

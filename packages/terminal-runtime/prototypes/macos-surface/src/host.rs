//! The probe's window: tao and wry exactly as Tauri builds them, the native surface, and the commands the driver thread sends.
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObjectProtocol};
use objc2::ClassType;
use objc2_app_kit::{NSEvent, NSEventModifierFlags, NSEventType, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSProcessInfo};
use tao::dpi::LogicalSize;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use wry::{WebViewBuilder, WebViewExtMacOS};

use crate::capture;
use crate::probe::{self, Settings};
use crate::surface::Surface;

pub enum Cmd {
    Create {
        rgb: u32,
        above: bool,
    },
    Destroy,
    Eval(String),
    Resize(f64, f64),
    Info,
    /// What AppKit routes a pointer at, and where the keyboard goes, for a point in CSS pixels from the web view's corner.
    Route(f64, f64),
    Click(f64, f64),
    Quit(i32),
}

pub enum Reply {
    Done,
    Info(Info),
    Text(String),
}

#[derive(Clone, Debug)]
pub struct Info {
    pub scale: f64,
    pub window: u32,
    pub frame: (f64, f64),
    pub content: (f64, f64),
    pub chain: String,
    pub flipped: bool,
}

pub enum Msg {
    Cmd(Cmd, mpsc::Sender<Reply>),
    Anchor([f64; 4]),
    Log(String),
}

/// What the page told the driver.
pub enum Event2 {
    Anchor([f64; 4]),
    Log(String),
}

/// The fixture page: transparent over the pane, an anchor, an opaque red DOM box over the anchor's lower right corner (the menu, the
/// palette or a selection handle that must stay on top) and a field. It reports the anchor's rectangle in CSS pixels.
const PAGE: &str = r##"<!doctype html><meta charset="utf-8"><body style="margin:0;background:transparent;overflow:hidden;font:14px sans-serif">
<div id="anchor" style="position:absolute;left:60px;top:40px;width:240px;height:160px"></div>
<div id="box" style="position:absolute;left:200px;top:120px;width:140px;height:100px;background:#f00;color:#fff">DOM box</div>
<input id="field" style="position:absolute;left:360px;top:40px;width:150px">
<script>
const send = text => window.ipc.postMessage(text);
const report = () => { const r = document.getElementById('anchor').getBoundingClientRect(); send('anchor:' + [r.x, r.y, r.width, r.height].join(',')); };
addEventListener('load', report); addEventListener('resize', report);
window.setAnchor = (x, y, w, h) => { Object.assign(document.getElementById('anchor').style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); report(); };
addEventListener('mousedown', e => send('log:mousedown ' + e.clientX + ',' + e.clientY));
</script>"##;

fn class_name(object: &AnyObject) -> String {
    object.class().name().to_string_lossy().into_owned()
}

pub fn run() {
    let settings = Settings::from_env();
    // The display mode is put back when this value is dropped, at the end of the run.
    let restore = settings.want_scale.and_then(|scale| {
        match capture::switch_to_scale(capture::main_display(), scale) {
            Ok(restore) => {
                std::thread::sleep(Duration::from_secs(3)); // the display settles before a window is placed on it
                restore
            }
            Err(why) => {
                println!("SKIP no {scale}x display: {why}");
                std::process::exit(3)
            }
        }
    });
    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("surface-poc")
        .with_transparent(true)
        .with_inner_size(LogicalSize::new(640.0, 400.0))
        .build(&event_loop)
        .expect("window");
    let proxy = event_loop.create_proxy();
    let ipc = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_transparent(settings.transparent)
        .with_html(PAGE)
        .with_ipc_handler(move |request| {
            let body = request.body();
            let sent = if let Some(rect) = body.strip_prefix("anchor:") {
                let v: Vec<f64> = rect.split(',').filter_map(|s| s.parse().ok()).collect();
                (v.len() == 4).then(|| ipc.send_event(Msg::Anchor([v[0], v[1], v[2], v[3]])))
            } else {
                body.strip_prefix("log:")
                    .map(|m| ipc.send_event(Msg::Log(m.into())))
            };
            drop(sent);
        })
        .build(&window)
        .expect("web view");
    let web = webview.webview();
    let parent: Retained<NSView> = unsafe { web.superview() }.expect("the web view has a parent");

    let (events_tx, events_rx) = mpsc::channel();
    let driver = proxy.clone();
    std::thread::spawn(move || probe::run(settings, driver, events_rx));

    let mut surface: Option<Surface> = None;
    let mut anchor = [0.0f64; 4];
    let mut restore = restore;
    let scale = {
        let parent = parent.clone();
        move || parent.window().map_or(1.0, |w| w.backingScaleFactor())
    };
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            // The page's report is the host's cue to place the surface: the same hop the app would have.
            Event::UserEvent(Msg::Anchor(a)) => {
                anchor = a;
                if let Some(s) = &surface {
                    s.place(&parent, a, scale());
                }
                let _ = events_tx.send(Event2::Anchor(a));
            }
            Event::UserEvent(Msg::Log(m)) => {
                let _ = events_tx.send(Event2::Log(m));
            }
            // The host's job on a resize: the parent view keeps its bottom left origin, so the surface is placed again.
            Event::WindowEvent {
                event: WindowEvent::Resized(_),
                ..
            } => {
                if let Some(s) = &surface {
                    s.place(&parent, anchor, scale());
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *flow = ControlFlow::Exit,
            Event::UserEvent(Msg::Cmd(cmd, reply)) => {
                let mtm = MainThreadMarker::new().expect("main thread");
                let answer = match cmd {
                    Cmd::Create { rgb, above } => {
                        match Surface::new(mtm, &parent, &web, above, rgb) {
                            Ok(s) => {
                                s.place(&parent, anchor, scale());
                                surface = Some(s);
                                Reply::Done
                            }
                            Err(why) => Reply::Text(format!("error {why}")),
                        }
                    }
                    Cmd::Destroy => {
                        if let Some(s) = surface.take() {
                            s.remove();
                        }
                        Reply::Done
                    }
                    Cmd::Eval(js) => Reply::Text(format!("{:?}", webview.evaluate_script(&js))),
                    Cmd::Resize(w, h) => {
                        window.set_inner_size(LogicalSize::new(w, h));
                        Reply::Done
                    }
                    Cmd::Info => {
                        let ns_window = parent.window().expect("window");
                        let (frame, content) = (ns_window.frame().size, parent.bounds().size);
                        Reply::Info(Info {
                            flipped: parent.isFlipped(),
                            scale: ns_window.backingScaleFactor(),
                            window: ns_window.windowNumber() as u32,
                            frame: (frame.width, frame.height),
                            content: (content.width, content.height),
                            chain: format!(
                                "{} > {}{}",
                                class_name(&parent),
                                class_name(&web),
                                surface.as_ref().map_or(String::new(), |s| format!(
                                    " + {}",
                                    class_name(s.view())
                                ))
                            ),
                        })
                    }
                    Cmd::Route(x, y) => Reply::Text(route(&parent, &web, x, y)),
                    Cmd::Click(x, y) => Reply::Text(click(&parent, x, y)),
                    Cmd::Quit(code) => {
                        drop(restore.take());
                        *flow = ControlFlow::ExitWithCode(code);
                        Reply::Done
                    }
                };
                let _ = reply.send(answer);
            }
            _ => {}
        }
    });
}

/// A point in CSS pixels from the web view's top left corner, in the parent's coordinates.
fn local(parent: &NSView, x: f64, y: f64) -> NSPoint {
    NSPoint::new(
        x,
        if parent.isFlipped() {
            y
        } else {
            parent.bounds().size.height - y
        },
    )
}

/// Which view AppKit's hit test gives a pointer at that point, and whether the keyboard's first responder is the web view.
fn route(parent: &NSView, web: &NSView, x: f64, y: f64) -> String {
    let superview = unsafe { parent.superview() };
    let point = parent.convertPoint_toView(local(parent, x, y), superview.as_deref());
    let hit = parent.hitTest(point);
    let hit_web = hit.as_ref().is_some_and(|v| v.isDescendantOf(web));
    let responder = parent.window().and_then(|w| w.firstResponder());
    let responder_web = responder.as_ref().is_some_and(|r| {
        r.isKindOfClass(NSView::class())
            && unsafe { &*(Retained::as_ptr(r) as *const NSView) }.isDescendantOf(web)
    });
    format!(
        "hit={} hit_web={hit_web} responder={} responder_web={responder_web}",
        hit.as_ref().map_or("none".into(), |v| class_name(v)),
        responder.as_ref().map_or("none".into(), |r| class_name(r)),
    )
}

/// A left click through `NSWindow.sendEvent`, the path a real one takes after the window server.
fn click(parent: &NSView, x: f64, y: f64) -> String {
    let Some(window) = parent.window() else {
        return "error no window".into();
    };
    let at = parent.convertPoint_toView(local(parent, x, y), None);
    let time = NSProcessInfo::processInfo().systemUptime();
    for (n, kind) in [NSEventType::LeftMouseDown, NSEventType::LeftMouseUp]
        .into_iter()
        .enumerate()
    {
        let event = NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            kind,
            at,
            NSEventModifierFlags::empty(),
            time,
            window.windowNumber(),
            None,
            n as isize,
            1,
            1.0,
        );
        match event {
            Some(e) => window.sendEvent(&e),
            None => return "error no event".into(),
        }
    }
    "sent".into()
}

pub fn out_dir() -> PathBuf {
    PathBuf::from(std::env::var("POC_OUT").unwrap_or_else(|_| "surface-poc-out".into()))
}

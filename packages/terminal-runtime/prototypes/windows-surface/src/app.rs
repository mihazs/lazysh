//! The app's window and web view, built the way Tauri builds them (tao window, wry WebView2 with a transparent background),
//! and the window thread's side of the probe: it owns the surface and acts on what `drive` asks of it.
use crate::{
    child::{Child, Order, Paint},
    drive,
    pixels::Rect,
};
use std::{
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
};
use tao::{
    dpi::{LogicalPosition, LogicalSize},
    event::Event,
    event_loop::{ControlFlow, EventLoopBuilder},
    platform::windows::WindowExtWindows,
    window::WindowBuilder,
};
use windows_sys::Win32::Foundation::HWND;
use wry::WebViewBuilder;

/// The page is transparent, so only the surface can be what shows at the anchor. The page reports
/// [devicePixelRatio, anchor x y w h, overlay x y w h] in CSS pixels whenever the anchor moves.
const PAGE: &str = r#"<!doctype html><html><body style="margin:0;background:transparent">
<div id="anchor" style="position:absolute;left:60px;top:40px;width:240px;height:160px"></div>
<div id="overlay" style="position:absolute;left:200px;top:120px;width:140px;height:100px;background:#f00"></div>
<script>
const box = id => { const r = document.getElementById(id).getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; };
const report = () => window.ipc.postMessage(JSON.stringify([devicePixelRatio, ...box('anchor'), ...box('overlay')]));
window.setAnchor = (x, y, w, h) => { Object.assign(document.getElementById('anchor').style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' }); report(); };
addEventListener('load', report);
</script></body></html>"#;

/// The anchor and the overlay in device pixels, which are also the child window's coordinates.
#[derive(Clone, Copy, Debug)]
pub struct Layout {
    pub dpr: f64,
    pub anchor: Rect,
    pub overlay: Rect,
}

pub type Shared = Arc<Mutex<Option<Layout>>>;

pub enum Cmd {
    Script(String),
    Create(Order, Paint, [u8; 3]),
    Destroy,
}

pub enum Msg {
    Layout(Layout),
    /// The answer is the Direct3D adapter's name, or why the command failed.
    Do(Cmd, mpsc::Sender<Result<String, String>>),
}

fn layout_from(body: &str) -> Option<Layout> {
    let v: Vec<f64> = serde_json::from_str(body)
        .ok()
        .filter(|v: &Vec<f64>| v.len() == 9)?;
    let rect = |at: usize| Rect::from_css([v[at], v[at + 1], v[at + 2], v[at + 3]], v[0]);
    Some(Layout {
        dpr: v[0],
        anchor: rect(1),
        overlay: rect(5),
    })
}

/// `opaque_window` leaves the tao window opaque (the app's default) and makes only the web view transparent.
pub fn run(out: PathBuf, opaque_window: bool) -> ! {
    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    // Small and near the corner: a hosted runner's desktop can be 1024x768, and the screen readback must see all of the client area.
    let window = WindowBuilder::new()
        .with_title("surface-poc")
        .with_transparent(!opaque_window)
        .with_always_on_top(true)
        .with_position(LogicalPosition::new(20.0, 20.0))
        .with_inner_size(LogicalSize::new(640.0, 420.0))
        .build(&event_loop)
        .expect("window");
    let proxy = event_loop.create_proxy();
    let page = proxy.clone();
    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(PAGE)
        .with_ipc_handler(move |request| {
            if let Some(layout) = layout_from(request.body()) {
                let _ = page.send_event(Msg::Layout(layout));
            }
        })
        .build(&window)
        .expect("WebView2");
    let hwnd = window.hwnd();
    let shared: Shared = Arc::default();
    let latest = shared.clone();
    std::thread::spawn(move || drive::run(hwnd, proxy, shared, out, opaque_window));

    let mut surface: Option<Child> = None;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        let Event::UserEvent(message) = event else {
            return;
        };
        match message {
            // The host re-places the surface whenever the page reports a new anchor, as the app will.
            Msg::Layout(layout) => {
                *latest.lock().unwrap() = Some(layout);
                if let Some(Err(e)) = surface
                    .as_mut()
                    .map(|s| s.place(layout.anchor, layout.overlay))
                {
                    eprintln!("place: {e}");
                }
            }
            Msg::Do(cmd, reply) => {
                let answer = match cmd {
                    Cmd::Script(js) => webview
                        .evaluate_script(&js)
                        .map(|()| String::new())
                        .map_err(|e| e.to_string()),
                    Cmd::Destroy => {
                        surface = None;
                        Ok(String::new())
                    }
                    Cmd::Create(order, paint, colour) => {
                        surface = None;
                        let layout = latest
                            .lock()
                            .unwrap()
                            .ok_or("the page has not reported a layout");
                        layout.map_err(String::from).and_then(|layout| {
                            let mut child = Child::new(hwnd as HWND, order, paint, colour)?;
                            child.place(layout.anchor, layout.overlay)?;
                            let adapter = child.adapter().unwrap_or_default().to_string();
                            surface = Some(child);
                            Ok(adapter)
                        })
                    }
                };
                let _ = reply.send(answer);
            }
        }
    })
}

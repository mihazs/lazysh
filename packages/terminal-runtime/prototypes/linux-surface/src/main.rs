//! Composition probe for #1331: a native surface next to the WebKitGTK web view the app uses (tao + wry), on Wayland
//! (a `wl_subsurface` of the toplevel) and X11 (a child window). It paints a solid colour, nothing else, and is not shipped.
//! Line protocol on stdin/stdout so `scripts/check.py` can capture the compositor between steps.
use gtk::prelude::*;
use std::io::BufRead;
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy},
    platform::unix::WindowExtUnix,
    window::WindowBuilder,
};
use wry::{WebView, WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix};

mod gpu;
mod wl;
mod x11;

#[derive(Debug)]
enum Msg {
    Anchor([f64; 4]),
    Cmd(String),
    Log(String),
    /// The web view's allocation changed: its offset inside the toplevel may have too.
    Moved,
}

pub trait Surface {
    fn place(&mut self, x: i32, y: i32, w: i32, h: i32);
}

const HTML: &str = r##"<!doctype html><html><body style="margin:0;background:transparent;font:14px sans-serif">
<div id="anchor" style="position:absolute;left:60px;top:40px;width:240px;height:160px;outline:1px dashed #888"></div>
<div id="overlay" style="position:absolute;left:200px;top:120px;width:140px;height:100px;background:#f00;color:#fff">DOM overlay</div>
<input id="field" style="position:absolute;left:360px;top:40px;width:150px" autofocus>
<div id="log" style="position:absolute;left:360px;top:80px;width:200px">no events</div>
<script>
let n = 0;
function report() { const r = document.getElementById('anchor').getBoundingClientRect(); window.ipc.postMessage(JSON.stringify([r.x, r.y, r.width, r.height])); }
addEventListener('load', report); addEventListener('resize', report);
window.setAnchor = (x, y, w, h) => { const a = document.getElementById('anchor').style; a.left = x + 'px'; a.top = y + 'px'; a.width = w + 'px'; a.height = h + 'px'; report(); };
for (const t of ['mousedown', 'keydown']) addEventListener(t, e => { const m = t + ' #' + (++n) + ' at ' + (e.clientX ?? '-') + ',' + (e.clientY ?? '-'); document.getElementById('log').textContent = m; window.ipc.postMessage('log:' + m); });
</script></body></html>"##;

fn main() {
    let mode = std::env::var("POC_MODE").unwrap_or_else(|_| "wayland".into());
    let below = std::env::var("POC_ORDER")
        .map(|v| v != "above")
        .unwrap_or(true);
    if mode == "x11" {
        std::env::set_var("GDK_BACKEND", "x11")
    } else {
        std::env::set_var("GDK_BACKEND", "wayland")
    }
    let event_loop = EventLoopBuilder::<Msg>::with_user_event().build();
    let window = WindowBuilder::new()
        .with_title("surface-poc")
        .with_transparent(true)
        .with_inner_size(tao::dpi::LogicalSize::new(1000.0, 700.0))
        .build(&event_loop)
        .unwrap();
    let proxy: EventLoopProxy<Msg> = event_loop.create_proxy();
    let ipc_proxy = proxy.clone();
    let vbox = window.default_vbox().expect("default vbox");
    let webview = WebViewBuilder::new()
        .with_transparent(true)
        .with_html(HTML)
        .with_ipc_handler(move |req| {
            if let Some(m) = req.body().strip_prefix("log:") {
                let _ = ipc_proxy.send_event(Msg::Log(m.to_string()));
            } else if let Ok(v) = serde_json_lite(req.body()) {
                let _ = ipc_proxy.send_event(Msg::Anchor(v));
            }
        })
        .build_gtk(vbox)
        .unwrap();
    let moved = proxy.clone();
    webview.webview().connect_size_allocate(move |_, _| {
        let _ = moved.send_event(Msg::Moved);
    });
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let _ = proxy.send_event(Msg::Cmd(line));
        }
    });
    let mut surface: Option<Box<dyn Surface>> = None;
    let mut anchor = [0.0f64; 4];
    let mut surface_color: u32 = 0xff00c800;
    event_loop.run(move |event, _, flow| {
        *flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(Msg::Moved) => {
                if let Some(s) = surface.as_mut() {
                    place_at(s.as_mut(), &window, &webview, anchor);
                }
            }
            Event::UserEvent(Msg::Anchor(a)) => {
                anchor = a;
                if let Some(s) = surface.as_mut() {
                    place_at(s.as_mut(), &window, &webview, a);
                }
            }
            Event::UserEvent(Msg::Log(m)) => println!("LOG {m}"),
            Event::UserEvent(Msg::Cmd(c)) => {
                let mut it = c.split_whitespace();
                match it.next() {
                    Some("create") => {
                        surface = Some(make(&window, &mode, surface_color, below));
                        place_at(
                            surface.as_mut().unwrap().as_mut(),
                            &window,
                            &webview,
                            anchor,
                        );
                        println!("DONE create anchor={:?}", anchor);
                    }
                    Some("destroy") => {
                        surface = None;
                        println!("DONE destroy");
                    }
                    Some("anchor") => {
                        let v: Vec<i32> = it.filter_map(|s| s.parse().ok()).collect();
                        let js = format!("setAnchor({},{},{},{})", v[0], v[1], v[2], v[3]);
                        let _ = webview.evaluate_script(&js);
                        println!("DONE anchor {js}");
                    }
                    Some("resize") => {
                        let v: Vec<f64> = it.filter_map(|s| s.parse().ok()).collect();
                        window.set_inner_size(tao::dpi::LogicalSize::new(v[0], v[1]));
                        println!("DONE resize");
                    }
                    Some("color") => {
                        surface_color =
                            0xff000000 | u32::from_str_radix(it.next().unwrap(), 16).unwrap();
                        println!("DONE color");
                    }
                    Some("focus") => {
                        let _ = webview.focus();
                        let _ = webview.evaluate_script("document.getElementById('field').focus()");
                        println!("DONE focus");
                    }
                    Some("info") => {
                        let gw = window.gtk_window();
                        let g = gw.window().unwrap();
                        println!(
                            "DONE info toplevel={}x{} pos={:?} scale={}",
                            g.width(),
                            g.height(),
                            g.position(),
                            gw.scale_factor()
                        );
                    }
                    Some("quit") => {
                        println!("DONE quit");
                        *flow = ControlFlow::Exit;
                    }
                    _ => println!("ERR {c}"),
                }
            }
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *flow = ControlFlow::Exit,
            _ => {}
        }
    });
}

fn serde_json_lite(body: &str) -> Result<[f64; 4], ()> {
    let t = body.trim().trim_start_matches('[').trim_end_matches(']');
    let v: Vec<f64> = t.split(',').filter_map(|s| s.trim().parse().ok()).collect();
    if v.len() == 4 {
        Ok([v[0], v[1], v[2], v[3]])
    } else {
        Err(())
    }
}

fn make(window: &tao::window::Window, mode: &str, color: u32, below: bool) -> Box<dyn Surface> {
    let gdk = window.gtk_window().window().expect("gdk window");
    if mode == "x11" {
        Box::new(x11::X11Surface::new(&gdk, color))
    } else {
        Box::new(wl::WlSurfaceChild::new(&gdk, color, below))
    }
}

/// Places the surface at an anchor given in the web view's coordinates. The toplevel's `wl_surface` (or X window) also holds
/// the client-side decoration (title bar, shadow) GTK draws when the compositor offers none, so the web view is not at its origin.
fn place_at(
    surface: &mut dyn Surface,
    window: &tao::window::Window,
    webview: &WebView,
    a: [f64; 4],
) {
    let (dx, dy) = webview
        .webview()
        .translate_coordinates(window.gtk_window(), 0, 0)
        .unwrap_or((0, 0));
    surface.place(a[0] as i32 + dx, a[1] as i32 + dy, a[2] as i32, a[3] as i32);
}

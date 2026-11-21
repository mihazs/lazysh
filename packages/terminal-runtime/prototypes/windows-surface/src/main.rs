//! Composition probe for #1332: does a native surface show through the transparent WebView2 the app uses (tao + wry)?
//! It opens the real window and page, puts a child window below or above the web view, reads its own window back and
//! writes what it saw to `report.md`. Run `surface-poc [--opaque-window] OUTDIR`; nothing here ships.
// Off Windows only the arithmetic and its tests build, so the readback helpers look unused there.
#[cfg_attr(not(windows), allow(dead_code))]
mod pixels;

#[cfg(windows)]
mod app;
#[cfg(windows)]
mod capture;
#[cfg(windows)]
mod child;
#[cfg(windows)]
mod drive;
#[cfg(windows)]
mod gpu;

#[cfg(windows)]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let out = args
        .iter()
        .find(|a| !a.starts_with("--"))
        .map_or("surface-poc-out", String::as_str);
    std::fs::create_dir_all(out).expect("output directory");
    app::run(out.into(), args.iter().any(|a| a == "--opaque-window"))
}

#[cfg(not(windows))]
fn main() {
    eprintln!("the composition probe runs on Windows only; `cargo test` covers its pixel arithmetic anywhere");
    std::process::exit(2);
}

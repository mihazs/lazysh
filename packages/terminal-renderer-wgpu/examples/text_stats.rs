//! What real fonts cost the wgpu renderer (#1325): the streams of `renderer_stats` drawn once with
//! the layout's dot-pattern glyphs and once with the fixture fonts, per workload the glyph cache
//! hit rate, bytes uploaded to both atlases, and the time spent choosing faces, shaping and
//! rasterizing (per miss and per frame). The fixtures are subsets, so characters they lack (most
//! CJK and emoji of the unicode workload) draw the missing-glyph box: that still costs a
//! rasterization, which is what is being measured, but it is not a full CJK font.
//! Run in release: `cargo run --release --example text_stats`; the caller records the environment.

mod common;

use common::support::{feed, load_average, runtime, workloads};
use common::{play, show};
use lazysh_terminal_renderer_wgpu::{FontLibrary, Target, WgpuRenderer};
use lazysh_terminal_runtime::{Appearance, CellMetrics, TerminalRenderer};
use std::time::{Duration, Instant};

const VOLUME: usize = 16 * 1024 * 1024;
const FAMILIES: [&str; 3] = [
    "DejaVu Sans Mono",
    "Noto Sans Mono CJK JP",
    "Noto Color Emoji",
];

fn fonts() -> FontLibrary {
    let mut lib = FontLibrary::new();
    let fixtures: [(&str, bool, bool, &[u8]); 5] = [
        (
            FAMILIES[0],
            false,
            false,
            include_bytes!("../tests/fonts/DejaVuSansMono.subset.ttf"),
        ),
        (
            FAMILIES[0],
            true,
            false,
            include_bytes!("../tests/fonts/DejaVuSansMono-Bold.subset.ttf"),
        ),
        (
            FAMILIES[0],
            false,
            true,
            include_bytes!("../tests/fonts/DejaVuSansMono-Oblique.subset.ttf"),
        ),
        (
            FAMILIES[1],
            false,
            false,
            include_bytes!("../tests/fonts/NotoSansMonoCJKjp.subset.otf"),
        ),
        (
            FAMILIES[2],
            false,
            false,
            include_bytes!("../tests/fonts/NotoColorEmoji.subset.ttf"),
        ),
    ];
    for (family, bold, italic, data) in fixtures {
        lib.add(family, bold, italic, data, 0)
            .expect("fixture font");
    }
    lib
}

fn appearance(scale: u32) -> Appearance {
    Appearance {
        metrics: CellMetrics::default().scaled(scale, 1).unwrap(),
        font_families: FAMILIES.iter().map(|f| f.to_string()).collect(),
        ..Appearance::default()
    }
}

fn renderer(cols: u16, rows: u16, ap: &Appearance, with_fonts: bool) -> WgpuRenderer {
    let m = ap.metrics;
    let mut target = Target::new(
        u32::from(cols) * m.cell_width,
        u32::from(rows) * m.cell_height,
    );
    if with_fonts {
        target = target.with_fonts(fonts());
    }
    WgpuRenderer::create(target, ap.clone()).expect("a GPU adapter is required")
}

fn main() {
    println!("host load average at start: {}", load_average());
    let probe = renderer(80, 24, &appearance(1), false);
    println!("adapter: {:?}\n", probe.adapter());
    drop(probe);

    println!("Cold start: build the library of five faces, create the renderer and draw one frame of ASCII\n");
    let ap = appearance(2);
    let started = Instant::now();
    let mut r = renderer(80, 24, &ap, true);
    let created = started.elapsed();
    let mut rt = runtime(80, 24);
    feed(
        &mut rt,
        "The quick brown fox jumps over the lazy dog 0123456789\r\n"
            .repeat(20)
            .as_bytes(),
    );
    let drawn = Instant::now();
    show(&mut r, &mut rt);
    println!("| library + renderer ms | first frame ms | text ms in that frame | glyph misses |");
    println!("|---|---|---|---|");
    let g = r.gpu_stats();
    println!(
        "| {:.2} | {:.2} | {:.2} | {} |",
        created.as_secs_f64() * 1e3,
        drawn.elapsed().as_secs_f64() * 1e3,
        g.text_time.as_secs_f64() * 1e3,
        g.glyph_misses
    );

    println!("\nPer workload (80x24, display scale 2: 16x32 px cells); dots = the layout's reference glyphs, fonts = real fonts\n");
    println!("| workload | glyphs | frames | glyph hits | glyph misses | hit rate % | atlas upload KiB | text ms total | us per miss | us per frame | wall ms per frame |");
    println!("|---|---|---|---|---|---|---|---|---|---|---|");
    for (name, data) in &workloads() {
        for with_fonts in [false, true] {
            let mut r = renderer(80, 24, &ap, with_fonts);
            let mut rt = runtime(80, 24);
            let started = Instant::now();
            play(&mut r, &mut rt, data, VOLUME);
            let wall = started.elapsed();
            let (g, s) = (r.gpu_stats(), r.stats());
            let lookups = g.glyph_hits + g.glyph_misses;
            let per = |t: Duration, n: u64| t.as_secs_f64() * 1e6 / n.max(1) as f64;
            println!(
                "| {name} | {} | {} | {} | {} | {:.2} | {:.1} | {:.2} | {:.1} | {:.1} | {:.3} |",
                if with_fonts { "fonts" } else { "dots" },
                s.frames_drawn,
                g.glyph_hits,
                g.glyph_misses,
                100.0 * g.glyph_hits as f64 / lookups.max(1) as f64,
                g.atlas_upload_bytes as f64 / 1024.0,
                g.text_time.as_secs_f64() * 1e3,
                per(g.text_time, g.glyph_misses),
                per(g.text_time, s.frames_drawn),
                wall.as_secs_f64() * 1e3 / s.frames_drawn.max(1) as f64,
            );
        }
    }
}

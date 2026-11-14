//! `cargo run --release --example glyph_bench -- [regular.ttf bold.ttf]`: the cost of the glyphs a terminal draws for the first time.
use lazysh_terminal_glyph_raster::{load, rasterize, scanned_extent};
use std::time::Instant;

fn median(mut v: Vec<f64>) -> f64 {
    v.sort_by(f64::total_cmp);
    v[v.len() / 2]
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let regular = args.first().map_or(
        "/usr/share/fonts/liberation/LiberationMono-Regular.ttf",
        String::as_str,
    );
    let bold = args.get(1).map_or(
        "/usr/share/fonts/liberation/LiberationMono-Bold.ttf",
        String::as_str,
    );
    let fonts = [load(regular), load(bold)];
    let ascii: Vec<char> = (0x21u8..0x7f).map(char::from).collect();
    println!("fonts: {regular}, {bold}\nprintable ASCII: {} glyphs; times are per glyph, median of 15 runs, one thread", ascii.len());
    for (label, px) in [
        ("devicePixelRatio 3, 14 px font (42 px)", 42.0f32),
        ("devicePixelRatio 1, 14 px font", 14.0),
    ] {
        // The design measured: one mask per glyph and weight, colour applied by the shader, extent from the rasterizer.
        let per_glyph = |font: &fontdue::Font, scan: bool| {
            median(
                (0..15)
                    .map(|_| {
                        let start = Instant::now();
                        let mut ink = 0usize;
                        for &ch in &ascii {
                            let mask = rasterize(font, ch, px);
                            ink += if scan {
                                scanned_extent(&mask).map_or(0, |e| e.2)
                            } else {
                                mask.width
                            };
                        }
                        std::hint::black_box(ink);
                        start.elapsed().as_secs_f64() * 1e6 / ascii.len() as f64
                    })
                    .collect(),
            )
        };
        let masks = per_glyph(&fonts[0], false);
        let scanned = per_glyph(&fonts[0], true);
        let weights =
            (fonts.iter().map(|f| per_glyph(f, false)).sum::<f64>()) * ascii.len() as f64 / 1000.0;
        // The design of the addon, in native code: one rasterization per glyph-and-colour pair, as many pairs as the stream shows.
        let pairs = 33_838usize;
        let start = Instant::now();
        let mut ink = 0usize;
        for i in 0..pairs {
            ink += rasterize(&fonts[0], ascii[i % ascii.len()], px).width;
        }
        std::hint::black_box(ink);
        let baked = start.elapsed().as_secs_f64() * 1e3;
        println!("\n{label}\n  rasterize one glyph (extent from the rasterizer): {masks:7.1} us\n  rasterize and scan the mask for its extent:       {scanned:7.1} us\n  every printable ASCII glyph, regular and bold:    {weights:7.2} ms (colour applied by the shader: all the work a first screen of any colours needs)\n  {pairs} glyph-and-colour pairs baked one by one:  {baked:7.1} ms (the cache design of the xterm.js addon, native rasterizer, no readback)");
    }
}

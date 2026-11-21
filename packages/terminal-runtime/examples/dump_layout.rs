//! Writes the shared layout (`layout::row_draws`) of the benchmark workloads as frames of draws,
//! for a renderer written in another language to replay (the Android Canvas candidate of #1323).
//! `cargo run --release --example dump_layout -- <dir>` writes `<workload>.lzl` per workload: the
//! screen as it stands after each 256 KiB of the first 16 MiB, every row, 80x24 cells of 8x16 px.
//!
//! Format, big endian: `LZL1`, u16 cols, rows, cell width, cell height, u32 frames; per frame u32
//! draws; per draw a tag u8 (0 rect, 1 glyph) then
//! rect: u16 x, y, w, h, rgb u8 x3 | glyph: u16 x, y, u8 cells, u8 bold, rgb u8 x3, u8 length, utf-8.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::layout::{row_draws, Draw, Glyph, Rect};
use lazysh_terminal_runtime::{Appearance, RgbColor, Screen};
use support::{feed_chunk, runtime, workloads, CHUNK, WINDOW};

const VOLUME: usize = 16 * 1024 * 1024;

fn put(out: &mut Vec<u8>, values: &[u16]) {
    values.iter().for_each(|v| out.extend(v.to_be_bytes()));
}

fn rgb(out: &mut Vec<u8>, c: RgbColor) {
    out.extend([c.r, c.g, c.b]);
}

fn draw(out: &mut Vec<u8>, d: &Draw<'_>) {
    match d {
        Draw::Rect(Rect { x, y, w, h, color }) => {
            out.push(0);
            put(out, &[*x as u16, *y as u16, *w as u16, *h as u16]);
            rgb(out, *color);
        }
        Draw::Glyph(Glyph {
            x,
            y,
            cells,
            text,
            color,
            bold,
            ..
        }) => {
            out.push(1);
            put(out, &[*x as u16, *y as u16]);
            out.extend([*cells as u8, u8::from(*bold)]);
            rgb(out, *color);
            let text = &text.as_bytes()[..text.len().min(255)];
            out.push(text.len() as u8);
            out.extend(text);
        }
    }
}

fn main() {
    let dir = std::env::args().nth(1).expect("usage: dump_layout <dir>");
    std::fs::create_dir_all(&dir).expect("create the output directory");
    let appearance = Appearance::default();
    let (cols, rows) = (80u16, 24u16);
    for (name, data) in workloads() {
        let (mut rt, mut screen, mut frames) =
            (runtime(cols, rows), Screen::new(), Vec::<Vec<u8>>::new());
        let mut taken = 0;
        for chunk in data[..VOLUME].chunks(CHUNK) {
            feed_chunk(&mut rt, chunk);
            taken += chunk.len();
            if taken < WINDOW {
                continue;
            }
            taken = 0;
            if let Some(frame) = rt.take_frame().expect("frame") {
                screen.apply(&frame).expect("apply");
            }
            let draws: Vec<_> = (0..rows)
                .flat_map(|y| row_draws(&screen, y, &appearance))
                .collect();
            let mut out = (draws.len() as u32).to_be_bytes().to_vec();
            draws.iter().for_each(|d| draw(&mut out, d));
            frames.push(out);
        }
        let m = appearance.metrics;
        let mut file = b"LZL1".to_vec();
        put(
            &mut file,
            &[cols, rows, m.cell_width as u16, m.cell_height as u16],
        );
        file.extend((frames.len() as u32).to_be_bytes());
        frames.iter().for_each(|f| file.extend(f));
        let slug = support::slug(name);
        std::fs::write(format!("{dir}/{slug}.lzl"), file).expect("write the layout");
    }
}

//! Rows of history kept per byte budget, by width and content, and what `scrollback_bytes_for_lines`
//! does with them: the data behind the History lines mapping. Host numbers only (no transport, no
//! renderer, no device). `cargo run --release --example scrollback_budget`; the caller records host,
//! toolchain and commit next to the output.

#[path = "../tests/support/mod.rs"]
mod support;

use lazysh_terminal_runtime::scrollback_bytes_for_lines;
use support::*;

const WORKLOADS: [(&str, Workload); 6] = [
    ("plain", plain_rows),
    ("coloured", colour_rows),
    ("syntax", syntax_rows),
    ("cell styles", cell_style_rows),
    ("graphemes", grapheme_rows),
    ("links", link_rows),
];
const WIDTHS: [u16; 6] = [20, 40, 80, 120, 200, 279];
const LINES: [usize; 4] = [100, 1_000, 5_000, 20_000];

fn main() {
    let budget = 16 << 20;
    println!(
        "Rows kept by a {} MiB budget, and bytes per cell at that fill",
        budget >> 20
    );
    println!(
        "| content | {} |",
        WIDTHS.map(|c| format!("{c} cols")).join(" | ")
    );
    for (name, workload) in WORKLOADS {
        let cells: Vec<String> = WIDTHS
            .iter()
            .map(|&cols| {
                let rows = 4 * budget / (usize::from(cols) * 8);
                let kept = fed_scrollback(cols, budget, rows, workload)
                    .scrollback_rows()
                    .unwrap();
                format!(
                    "{kept} ({:.1} B/cell)",
                    budget as f64 / (kept * usize::from(cols)) as f64
                )
            })
            .collect();
        println!("| {name} | {} |", cells.join(" | "));
    }

    println!(
        "\nRows kept at the mapped budget, as a share of the requested lines (fed 3x the lines)"
    );
    for (name, workload) in WORKLOADS {
        println!(
            "| {name}, lines | {} |",
            WIDTHS.map(|c| format!("{c} cols")).join(" | ")
        );
        for lines in LINES {
            let cells: Vec<String> = WIDTHS
                .iter()
                .map(|&cols| {
                    let rt = fed_scrollback(
                        cols,
                        scrollback_bytes_for_lines(lines, cols),
                        3 * lines,
                        workload,
                    );
                    format!("{:.2}", rt.scrollback_rows().unwrap() as f64 / lines as f64)
                })
                .collect();
            println!("| {lines} | {} |", cells.join(" | "));
        }
    }
}

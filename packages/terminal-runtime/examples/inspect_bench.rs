//! Host cost of the text queries a tap triggers: Herdr's navigation check reads the first row and
//! the right edge of the second ([#1318]), and a screen read returns every visible row. Core only:
//! no bridge, no JavaScript, no device. `cargo run --release --example inspect_bench`; the caller
//! records host, toolchain and commit next to the output.
//!
//! [#1318]: https://github.com/mihazs/lazysh/issues/1318

#[path = "../tests/support/mod.rs"]
mod support;

use std::time::Instant;
use support::*;

fn measure(label: &str, query: impl FnMut()) {
    println!("{label}: {}", Timings::of(20_000, query));
}

fn main() {
    for (cols, rows) in [(46, 30), (80, 24), (200, 60)] {
        let mut rt = runtime(cols, rows);
        let chrome = format!(
            "\x1b[44m{:<w$}\x1b[0m\r\n\x1b[44m{:>w$}\x1b[0m\r\n",
            "● Development  tab 1",
            "│ switch  ",
            w = usize::from(cols)
        );
        feed(&mut rt, chrome.as_bytes());
        let body: String = (2..rows)
            .map(|row| format!("agent output {row} with some text\r\n"))
            .collect();
        feed(&mut rt, body.as_bytes());
        measure(
            &format!("{cols}x{rows} Herdr tap (row 0 and the right edge of row 1)"),
            || {
                let first = rt.read_rows(0, 1, None).unwrap();
                let edge = rt.read_rows(1, 1, Some(cols - 10..cols)).unwrap();
                assert!(first[0].starts_with("● Dev") && edge[0].ends_with("switch"));
            },
        );
        measure(&format!("{cols}x{rows} every visible row"), || {
            assert_eq!(
                rt.read_rows(0, usize::from(rows), None).unwrap().len(),
                usize::from(rows)
            );
        });
    }
}

#![allow(dead_code)]
use lazysh_terminal_runtime::{CellWide, Config, Frame, Offer, Size, TerminalRuntime};

pub const CELL_W: u32 = 10;
pub const CELL_H: u32 = 20;

pub fn runtime(cols: u16, rows: u16) -> TerminalRuntime {
    TerminalRuntime::new(Config {
        size: Size {
            cols,
            rows,
            cell_width_px: CELL_W,
            cell_height_px: CELL_H,
        },
        ..Config::default()
    })
    .expect("runtime")
}

/// Offer in transport-sized chunks and process everything, like the transport loop will.
pub fn feed(rt: &mut TerminalRuntime, bytes: &[u8]) {
    for chunk in bytes.chunks(16 * 1024) {
        match rt.offer(chunk.to_vec()) {
            Offer::Accepted => {}
            other => panic!("unexpected {other:?}"),
        }
        rt.pump(usize::MAX);
    }
}

/// Visible text per row, blanks as spaces, trailing blanks trimmed, wide-cell spacers skipped.
pub fn lines(frame: &Frame) -> Vec<String> {
    let mut rows = frame.dirty.clone();
    rows.sort_by_key(|row| row.y);
    rows.iter()
        .map(|row| {
            let text: String = row
                .cells
                .iter()
                .filter(|cell| !matches!(cell.wide, CellWide::SpacerTail | CellWide::SpacerHead))
                .map(|cell| {
                    if cell.text.is_empty() {
                        " "
                    } else {
                        cell.text.as_str()
                    }
                })
                .collect();
            text.trim_end().to_string()
        })
        .collect()
}

pub fn screen(rt: &mut TerminalRuntime) -> Vec<String> {
    lines(&rt.snapshot().expect("snapshot"))
}

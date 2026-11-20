//! Shared by the examples: show a frame on a renderer and play a stream into one.
#![allow(dead_code)]

#[path = "../../../terminal-runtime/tests/support/mod.rs"]
pub mod support;

use lazysh_terminal_renderer_wgpu::WgpuRenderer;
use lazysh_terminal_runtime::{TerminalRenderer, TerminalRuntime};
use support::{feed_chunk, CHUNK, WINDOW};

/// The core's pending frame, if any, applied, drawn and presented.
pub fn show(r: &mut WgpuRenderer, rt: &mut TerminalRuntime) {
    if let Some(frame) = rt.take_frame().expect("frame") {
        r.apply(&frame).expect("apply");
        r.draw().expect("draw");
        r.present().expect("present");
    }
}

/// Feed the first `volume` bytes of `data` to the core and show a frame every `WINDOW` bytes.
pub fn play(r: &mut WgpuRenderer, rt: &mut TerminalRuntime, data: &[u8], volume: usize) {
    let mut taken = 0;
    for chunk in data[..volume].chunks(CHUNK) {
        feed_chunk(rt, chunk);
        taken += chunk.len();
        if taken >= WINDOW {
            taken = 0;
            show(r, rt);
        }
    }
}

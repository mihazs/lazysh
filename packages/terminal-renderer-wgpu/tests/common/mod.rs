#![allow(dead_code)]
//! Shared by the test crates: a GPU renderer and the CPU reference side by side, fed by the real
//! libghostty-vt core. Without a GPU adapter (a software one counts) every test fails instead of
//! skipping, because a skipped correctness check looks like a pass.

#[path = "../../../terminal-runtime/tests/support/mod.rs"]
pub mod support;

use lazysh_terminal_renderer_wgpu::{Policy, Target, WgpuRenderer};
use lazysh_terminal_runtime::{
    Appearance, Frame, Image, Overlay, ReferenceRenderer, TerminalRenderer, TerminalRuntime, Theme,
};

pub const W: u32 = 8;
pub const H: u32 = 16;

/// A target for `cols` x `rows` default cells that accepts software adapters, as CI has only those.
pub fn target(cols: u16, rows: u16) -> Target {
    Target::new(u32::from(cols) * W, u32::from(rows) * H)
        .with_policy(Policy::for_platform().with_software())
}

pub fn gpu(cols: u16, rows: u16) -> WgpuRenderer {
    WgpuRenderer::create(target(cols, rows), Appearance::default())
        .expect("a GPU adapter is required")
}

/// A core that received `bytes`.
pub fn runtime(cols: u16, rows: u16, bytes: &[u8]) -> TerminalRuntime {
    let mut rt = support::runtime(cols, rows);
    support::feed(&mut rt, bytes);
    rt
}

pub struct Pair {
    pub gpu: WgpuRenderer,
    pub cpu: ReferenceRenderer,
}

impl Pair {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self::with(gpu(cols, rows), cols, rows)
    }

    pub fn with(gpu: WgpuRenderer, cols: u16, rows: u16) -> Self {
        let blank = Image::new(
            u32::from(cols) * W,
            u32::from(rows) * H,
            Theme::default().background,
        )
        .unwrap();
        Self {
            gpu,
            cpu: ReferenceRenderer::create(blank, Appearance::default()).unwrap(),
        }
    }

    /// Show a frame on both and return the rows each one drew.
    pub fn show(&mut self, frame: &Frame) -> (u32, u32) {
        self.gpu.apply(frame).unwrap();
        self.cpu.apply(frame).unwrap();
        self.flush()
    }

    pub fn overlay(&mut self, overlay: Overlay) {
        self.gpu.set_overlay(overlay).unwrap();
        self.cpu.set_overlay(overlay).unwrap();
        let (gpu, cpu) = self.flush();
        assert_eq!(gpu, cpu, "both renderers judge the overlay alike");
    }

    fn flush(&mut self) -> (u32, u32) {
        let drawn = (self.gpu.draw().unwrap(), self.cpu.draw().unwrap());
        self.gpu.present().unwrap();
        self.cpu.present().unwrap();
        drawn
    }

    /// The images are identical, and the oracle is not blank (which would prove nothing).
    pub fn assert_same(&mut self, what: &str) {
        let (gpu, cpu) = (self.gpu.read_image().unwrap(), self.cpu.surface().clone());
        let bg = Theme::default().background;
        assert!(
            cpu.rgb.chunks(3).any(|p| p != [bg.r, bg.g, bg.b]),
            "{what}: the oracle image is blank, so equality would prove nothing"
        );
        assert_eq!(
            (gpu.width, gpu.height),
            (cpu.width, cpu.height),
            "{what}: size"
        );
        let at = gpu.rgb.iter().zip(&cpu.rgb).position(|(a, b)| a != b);
        assert!(
            at.is_none(),
            "{what}: first difference at pixel ({}, {})",
            at.unwrap() / 3 % gpu.width as usize,
            at.unwrap() / 3 / gpu.width as usize
        );
    }
}

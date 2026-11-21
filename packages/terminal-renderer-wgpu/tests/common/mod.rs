#![allow(dead_code)]
//! Shared by the test crates: a GPU renderer and the CPU reference side by side, fed by the real
//! libghostty-vt core. Without a GPU adapter (a software one counts) every test fails instead of
//! skipping, because a skipped correctness check looks like a pass.

#[path = "../../../terminal-runtime/tests/support/mod.rs"]
pub mod support;

use lazysh_terminal_renderer_wgpu::{FontLibrary, Policy, Target, WgpuRenderer};
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

/// A GPU renderer for `cols` x `rows` cells of `appearance`, which may be scaled.
pub fn gpu_at(cols: u16, rows: u16, appearance: &Appearance) -> WgpuRenderer {
    let (width, height) = surface(cols, rows, appearance);
    let target = Target::new(width, height).with_policy(Policy::for_platform().with_software());
    WgpuRenderer::create(target, appearance.clone()).expect("a GPU adapter is required")
}

/// A GPU renderer for `cols` x `rows` cells of `appearance` that draws glyphs with `fonts`.
pub fn gpu_with_fonts(
    cols: u16,
    rows: u16,
    appearance: &Appearance,
    fonts: FontLibrary,
) -> WgpuRenderer {
    let (width, height) = surface(cols, rows, appearance);
    let target = Target::new(width, height)
        .with_policy(Policy::for_platform().with_software())
        .with_fonts(fonts);
    WgpuRenderer::create(target, appearance.clone()).expect("a GPU adapter is required")
}

/// The surface size of `cols` x `rows` cells of `appearance`, in device pixels.
pub fn surface(cols: u16, rows: u16, appearance: &Appearance) -> (u32, u32) {
    let m = appearance.metrics;
    (
        u32::from(cols) * m.cell_width,
        u32::from(rows) * m.cell_height,
    )
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
        Self::at(gpu, cols, rows, &Appearance::default())
    }

    /// The pair at a given appearance: the reference renderer is created for the same surface.
    pub fn at(gpu: WgpuRenderer, cols: u16, rows: u16, appearance: &Appearance) -> Self {
        let (width, height) = surface(cols, rows, appearance);
        let blank = Image::new(width, height, Theme::default().background).unwrap();
        Self {
            gpu,
            cpu: ReferenceRenderer::create(blank, appearance.clone()).unwrap(),
        }
    }

    /// Both renderers recover from core state, as the host does after a loss: a snapshot, drawn
    /// and presented (the reference renderer never lost anything and just repaints).
    pub fn show_snapshot(&mut self, core: &mut TerminalRuntime) {
        self.show(&core.snapshot().unwrap());
    }

    /// A new appearance and surface size on both renderers (a display scale change); returns the
    /// rows each one repainted.
    pub fn rescale(&mut self, cols: u16, rows: u16, appearance: &Appearance) -> (u32, u32) {
        let (width, height) = surface(cols, rows, appearance);
        for r in [&mut self.gpu as &mut dyn Resizable, &mut self.cpu] {
            r.rescale(appearance, width, height);
        }
        self.flush()
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

    pub fn flush(&mut self) -> (u32, u32) {
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

/// What a display scale change does to either renderer, so `Pair::rescale` treats them alike.
trait Resizable {
    fn rescale(&mut self, appearance: &Appearance, width: u32, height: u32);
}

impl<R: TerminalRenderer> Resizable for R {
    fn rescale(&mut self, appearance: &Appearance, width: u32, height: u32) {
        self.set_appearance(appearance.clone()).unwrap();
        self.resize(width, height).unwrap();
    }
}

//! What the renderer does and does not do between frames, observed through the counters of the
//! GPU side and the memory it holds: idle costs nothing, a change costs one pass, memory under
//! churn has an upper bound, `destroy` frees it, and the adapter policy falls back.

mod common;

use common::*;
use lazysh_terminal_renderer_wgpu::{Policy, Target, WgpuRenderer};
use lazysh_terminal_runtime::{Appearance, RenderError, TerminalRenderer};
use wgpu::Backend;

/// The renderer showing what the core shows, drawn and presented.
fn shown(
    cols: u16,
    rows: u16,
    bytes: &[u8],
) -> (lazysh_terminal_runtime::TerminalRuntime, WgpuRenderer) {
    let mut rt = runtime(cols, rows, bytes);
    let mut r = gpu(cols, rows);
    r.apply(&rt.snapshot().unwrap()).unwrap();
    assert_eq!(r.draw().unwrap(), u32::from(rows));
    r.present().unwrap();
    (rt, r)
}

#[test]
fn an_unchanged_screen_submits_nothing_and_asks_for_no_frame() {
    let (mut rt, mut r) = shown(40, 10, "idle 日本 \x1b[1mbold\x1b[0m".as_bytes());
    assert!(!r.needs_draw(), "everything is drawn");
    let (gpu, stats) = (r.gpu_stats(), r.stats());
    for _ in 0..1_000 {
        assert_eq!(r.draw().unwrap(), 0);
        r.present().unwrap();
    }
    assert_eq!(r.gpu_stats(), gpu, "no submission, upload or atlas lookup");
    assert_eq!(r.stats(), stats, "no frame counted, no time spent");
    // The core has nothing new, and neither a repeated snapshot nor an identical overlay or size
    // is a change.
    assert!(rt.take_frame().unwrap().is_none());
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.set_overlay(Default::default()).unwrap();
    r.resize(40 * W, 10 * H).unwrap();
    assert!(
        !r.needs_draw(),
        "an identical screen, overlay and size need no frame"
    );
    assert_eq!(r.draw().unwrap(), 0);
    assert_eq!(r.gpu_stats(), gpu);
}

#[test]
fn an_application_rewriting_the_same_text_costs_no_frame() {
    let (mut rt, mut r) = shown(40, 5, b"\x1b[1;1Hclock 12:00:00");
    let before = r.gpu_stats();
    for _ in 0..50 {
        support::feed(&mut rt, b"\x1b[1;1Hclock 12:00:00");
        if let Some(frame) = rt.take_frame().unwrap() {
            r.apply(&frame).unwrap();
        }
        assert!(!r.needs_draw(), "the same cells and the same cursor");
        assert_eq!(r.draw().unwrap(), 0);
    }
    assert_eq!(r.gpu_stats(), before);
    support::feed(&mut rt, b"\x1b[1;1Hclock 12:00:01");
    r.apply(&rt.take_frame().unwrap().unwrap()).unwrap();
    assert!(r.needs_draw(), "a changed digit does");
    assert_eq!(r.draw().unwrap(), 1);
    assert_eq!(r.gpu_stats().submissions, before.submissions + 1);
}

#[test]
fn a_change_costs_one_pass_and_uploads_only_what_it_needs() {
    let (mut rt, mut r) = shown(
        80,
        24,
        "the quick brown fox jumps over the lazy dog".as_bytes(),
    );
    let (gpu, stats) = (r.gpu_stats(), r.stats());
    support::feed(&mut rt, b"\x1b[10;1Hthe quick brown fox");
    r.apply(&rt.take_frame().unwrap().unwrap()).unwrap();
    assert!(r.needs_draw());
    let rows = r.draw().unwrap();
    r.present().unwrap();
    let (after, stats_after) = (r.gpu_stats(), r.stats());
    assert_eq!(rows, 2, "the row written and the row the cursor left");
    assert_eq!(after.submissions - gpu.submissions, 1);
    assert_eq!(after.passes - gpu.passes, 1);
    assert_eq!(
        after.glyph_misses, gpu.glyph_misses,
        "every letter was already in the atlas"
    );
    assert_eq!(after.atlas_upload_bytes, gpu.atlas_upload_bytes);
    let uploaded = stats_after.bytes_uploaded - stats.bytes_uploaded;
    assert!(
        uploaded > 0 && uploaded < 4_096,
        "two rows of instances, not the surface: {uploaded} bytes"
    );
    assert!(!r.needs_draw());
}

#[test]
fn a_repaint_clears_once_and_is_one_pass() {
    let (_, mut r) = shown(80, 24, "hello".as_bytes());
    let before = r.gpu_stats();
    r.resize(80 * W + 8, 24 * H).unwrap();
    assert!(r.needs_draw(), "a new surface size repaints everything");
    assert_eq!(r.draw().unwrap(), 24);
    assert_eq!(r.gpu_stats().passes - before.passes, 1);
}

/// Distinct glyphs forever through a 28-slot atlas: memory stays what it was after the first frame.
#[test]
fn memory_has_an_upper_bound_under_glyph_churn() {
    let tiny = target(30, 6).with_atlas_side(64).with_color_atlas_side(64);
    let mut rt = runtime(30, 6, b"");
    let mut r = WgpuRenderer::create(tiny, Appearance::default()).unwrap();
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    let mut written = 0u32;
    let mut churn =
        |rt: &mut lazysh_terminal_runtime::TerminalRuntime, r: &mut WgpuRenderer, frames: u32| {
            for _ in 0..frames {
                let text: String = (0..60)
                    .filter_map(|i| char::from_u32(0x4e00 + written * 7 + i))
                    .collect();
                written += 1;
                support::feed(rt, format!("\r\n{text}").as_bytes());
                r.apply(&rt.take_frame().unwrap().unwrap()).unwrap();
                r.draw().unwrap();
                r.present().unwrap();
            }
        };
    churn(&mut rt, &mut r, 20);
    let memory = r.memory();
    churn(&mut rt, &mut r, 200);
    let settled = r.live_resources().unwrap();
    let settled_evictions = r.gpu_stats().atlas_evictions;
    churn(&mut rt, &mut r, 200);
    let after = r.live_resources().unwrap();
    assert_eq!(
        r.memory(),
        memory,
        "the atlas, target and instance buffers did not grow"
    );
    // The driver layer pools staging memory while it warms up; a leak would add a buffer per frame.
    assert_eq!(after.textures, settled.textures, "no texture per frame");
    assert_eq!(after.texture_bytes, settled.texture_bytes);
    assert!(
        after.buffers <= settled.buffers && after.buffer_bytes <= settled.buffer_bytes,
        "buffers grew while the churn went on: {settled:?} then {after:?}"
    );
    let stats = r.gpu_stats();
    assert!(
        stats.atlas_evictions > 2_000 && stats.atlas_evictions > settled_evictions,
        "the churn really evicted: {stats:?}"
    );
    assert!(stats.glyph_misses > 2_000);
    let (capacity, resident) = r.atlas_slots();
    assert!(resident <= capacity);
    assert!(
        memory.total() < 64 * 1024 + 30 * W as u64 * 6 * H as u64 * 4 + (1 << 16) * 32 + 16,
        "{memory:?}"
    );
}

#[test]
fn destroy_releases_the_buffers_and_textures_it_created() {
    let (_, mut r) = shown(40, 10, "something to draw 日本 ".as_bytes());
    let alive = r.live_resources().unwrap();
    assert!(r.memory().total() > 0);
    let stats = r.gpu_stats();
    r.destroy();
    r.destroy();
    assert_eq!(r.memory().total(), 0);
    assert_eq!(r.atlas_slots(), (0, 0));
    assert_eq!(r.draw(), Err(RenderError::Destroyed));
    assert_eq!(r.gpu_stats(), stats, "the counters survive");
    let left = r.resources_after_destroy().expect("measured at destroy");
    // Which counters a backend maintains differs (Vulkan counts bytes, OpenGL counts objects), and
    // the driver layer keeps scratch of its own: so each kind must have shrunk on one of them.
    assert!(
        left.buffers < alive.buffers || left.buffer_bytes < alive.buffer_bytes,
        "buffers: {alive:?} before, {left:?} after"
    );
    assert!(
        left.textures < alive.textures || left.texture_bytes < alive.texture_bytes,
        "textures: {alive:?} before, {left:?} after"
    );
}

#[test]
fn a_surface_the_device_cannot_hold_is_refused_not_a_panic() {
    let huge = Target::new(1 << 20, 16).with_policy(Policy::for_platform().with_software());
    assert!(matches!(
        WgpuRenderer::create(huge, Appearance::default()),
        Err(RenderError::InvalidSize)
    ));
    let mut r = gpu(10, 2);
    assert_eq!(r.resize(0, 5), Err(RenderError::InvalidSize));
    assert_eq!(r.resize(1 << 20, 5), Err(RenderError::InvalidSize));
    r.resize(10 * W, 2 * H).unwrap();
}

fn backends(list: &[Backend]) -> Policy {
    Policy {
        backends: list.to_vec(),
        allow_software: true,
    }
}

fn create_on(list: &[Backend], cols: u16, rows: u16) -> Result<WgpuRenderer, RenderError> {
    WgpuRenderer::create(
        target(cols, rows).with_policy(backends(list)),
        Appearance::default(),
    )
}

#[test]
fn a_backend_the_host_does_not_have_is_unsupported_and_the_next_one_is_used() {
    if cfg!(target_vendor = "apple") {
        return;
    }
    assert!(matches!(
        create_on(&[Backend::Metal], 10, 2),
        Err(RenderError::Unsupported(_))
    ));
    let r = create_on(&[Backend::Metal, Backend::Vulkan, Backend::Gl], 10, 2)
        .expect("a later backend is the fallback");
    assert_ne!(r.adapter().unwrap().backend, Backend::Metal);
}

#[test]
fn the_strict_policy_never_returns_a_software_adapter() {
    let strict = Policy::for_platform();
    match WgpuRenderer::create(
        Target::new(80, 32).with_policy(strict),
        Appearance::default(),
    ) {
        Ok(r) => {
            let info = r.adapter().unwrap();
            assert_ne!(info.device_type, wgpu::DeviceType::Cpu, "{info:?}");
        }
        Err(e) => assert!(matches!(e, RenderError::Unsupported(_)), "{e:?}"),
    }
}

#[test]
fn the_opengl_backend_draws_the_same_pixels_where_the_host_offers_it() {
    if !cfg!(any(target_os = "linux", target_os = "android")) {
        return;
    }
    let mut rt = runtime(
        20,
        3,
        "gl 日本\r\n\x1b[7minverse\x1b[0m \x1b[4mline\x1b[0m".as_bytes(),
    );
    let Ok(gl) = create_on(&[Backend::Gl], 20, 3) else {
        eprintln!("no OpenGL adapter on this host: the fallback backend was not exercised");
        return;
    };
    eprintln!("OpenGL adapter: {:?}", gl.adapter().unwrap());
    let mut pair = Pair::with(gl, 20, 3);
    pair.show(&rt.snapshot().unwrap());
    pair.assert_same("OpenGL backend");
}

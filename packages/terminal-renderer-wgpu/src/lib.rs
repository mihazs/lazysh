//! wgpu implementation of the lazysh Terminal Renderer API (#1324).
//!
//! The core owns the screen and `layout::row_draws` decides what each row looks like; this crate
//! only rasterizes. A frame is built from the rows that changed:
//!
//! * **Instanced quads.** Every draw of the shared layout (a cell background, an underline, a
//!   cursor, a glyph) is one 32-byte instance of a single pipeline; a draw call paints all of them.
//! * **Dirty rows only.** The target texture persists between frames, so a frame submits the
//!   instances of the rows that changed and loads the rest. A repaint clears first.
//! * **Glyph atlas of fixed size.** Masks live in slots of one or two cells, with
//!   least-recently-used eviction ([`atlas`]); a screen that needs more distinct glyphs than the
//!   atlas holds is drawn in several passes. GPU memory therefore has an upper bound that does not
//!   depend on how much is written or how many distinct characters pass through.
//! * **Event driven.** Nothing is submitted for a screen that did not change: `draw` returns 0
//!   without touching the GPU, and [`WgpuRenderer::gpu_stats`] counts submissions so tests can say so.
//! * **Capabilities.** The adapter is chosen by a [`Policy`]: backends in order of preference, GPUs
//!   before software; with none left `create` fails with [`RenderError::Unsupported`] and the host
//!   keeps its fallback renderer.
//!
//! The surface of this crate is an offscreen texture (`Target`), which is what the tests and the
//! benchmarks read back. A window or `ANativeWindow` surface is #1327.
//!
//! **Text.** Without fonts the glyph masks are the reference dot patterns of the layout. With a
//! [`FontLibrary`] on the [`Target`] they come from real fonts ([`text`]): face choice with
//! fallback, shaping, and rasterization into the cluster's cells, in an `R8` atlas for coverage and
//! an `RGBA8` atlas for color glyphs (emoji), each of fixed size.

mod adapter;
mod atlas;
mod fonts;
mod text;

pub use adapter::{rank, ranked, AdapterInfo, Policy};
pub use fonts::{FontError, FontLibrary};

use atlas::{Atlas, Slot};
use bytemuck::{Pod, Zeroable};
use lazysh_terminal_runtime::layout::{row_draws, Draw, Glyph, Rect};
use lazysh_terminal_runtime::{
    forward_to_core, Appearance, CellMetrics, DrawPlan, Image, RenderError, RendererCore, Resume,
    RgbColor, TerminalRenderer,
};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use text::{Glyphs, Kind};

/// Default atlas side in texels: 4 MiB of masks.
const ATLAS_SIDE: u32 = 2048;
/// Instances per render pass: the instance buffer never grows past this, however large the screen.
const MAX_PASS_INSTANCES: usize = 1 << 16;
const SOLID: u32 = u32::MAX;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const ATLAS_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R8Unorm;
const COLOR_ATLAS_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
/// Default side of the color glyph atlas: 1 MiB. A screen with more distinct emoji than it holds is
/// drawn in several passes (a few dozen wide ones at phone sizes); a host that shows more raises it.
const COLOR_ATLAS_SIDE: u32 = 512;
const INSTANCE: u64 = std::mem::size_of::<Instance>() as u64;

/// The surface: an offscreen texture of this size in device pixels, on the adapter the policy picks.
#[derive(Debug, Clone)]
pub struct Target {
    pub width: u32,
    pub height: u32,
    pub policy: Policy,
    /// Side of the square glyph atlas in texels (the device's limit if smaller). The default holds
    /// thousands of glyphs; tests shrink it to make eviction happen.
    pub atlas_side: u32,
    /// The same for the color (emoji) atlas, which only fills when a color font draws.
    pub color_atlas_side: u32,
    /// Fonts to draw glyphs with; without them glyphs are the reference dot patterns.
    pub fonts: Option<Arc<FontLibrary>>,
}

impl Target {
    /// The shipping policy of this platform ([`Policy::for_platform`]).
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            policy: Policy::for_platform(),
            atlas_side: ATLAS_SIDE,
            color_atlas_side: COLOR_ATLAS_SIDE,
            fonts: None,
        }
    }

    pub fn with_policy(self, policy: Policy) -> Self {
        Self { policy, ..self }
    }

    pub fn with_atlas_side(self, atlas_side: u32) -> Self {
        Self { atlas_side, ..self }
    }

    pub fn with_color_atlas_side(self, color_atlas_side: u32) -> Self {
        Self {
            color_atlas_side,
            ..self
        }
    }

    /// Draw glyphs with `fonts`, ordered by `Appearance::font_families`.
    pub fn with_fonts(self, fonts: FontLibrary) -> Self {
        Self {
            fonts: Some(Arc::new(fonts)),
            ..self
        }
    }
}

/// One rectangle of the shared layout: a solid fill, or a glyph mask taken from the atlas.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct Instance {
    rect: [u32; 4],
    color: u32,
    mask: [u32; 2],
    /// 0: a solid or a coverage mask tinted with `color`; 1: an RGBA glyph from the color atlas.
    kind: u32,
}

impl Instance {
    fn solid(x: u32, y: u32, w: u32, h: u32, color: RgbColor) -> Self {
        Self {
            rect: [x, y, w, h],
            color: u32::from(color.r) | u32::from(color.g) << 8 | u32::from(color.b) << 16,
            mask: [SOLID; 2],
            kind: 0,
        }
    }
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct Globals {
    target: [f32; 2],
    pad: [f32; 2],
}

/// What the GPU side did, cumulative, for the benchmarks and for tests that must show it idle.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GpuStats {
    /// Calls to `Queue::submit` for drawing: zero added while the screen is unchanged.
    pub submissions: u64,
    /// Render passes recorded; more than one per frame only when the atlas spilled.
    pub passes: u64,
    /// Draws the shared layout asked for, and instances actually submitted for them: the gap is
    /// what dirty-row batching saves (cell backgrounds on the row's own color, merged runs).
    pub layout_draws: u64,
    pub instances: u64,
    pub glyph_hits: u64,
    /// Masks rasterized and uploaded.
    pub glyph_misses: u64,
    /// Time spent shaping and rasterizing the masks that missed (zero without fonts); the face lookup
    /// every glyph pays, hit or miss, is not in it.
    pub text_time: std::time::Duration,
    pub atlas_evictions: u64,
    /// Bytes of glyph masks written to the atlas.
    pub atlas_upload_bytes: u64,
    /// Times a frame needed more distinct glyphs than the atlas holds and was split.
    pub atlas_spills: u64,
    /// Devices built after the first: recoveries from a loss.
    pub device_recoveries: u64,
    /// Time spent in `resume` building those devices, pipelines and resources (the part of a
    /// recovery that is not the host's snapshot and redraw).
    pub recovery_time: std::time::Duration,
}

impl GpuStats {
    fn plus(self, other: Self) -> Self {
        Self {
            submissions: self.submissions + other.submissions,
            passes: self.passes + other.passes,
            layout_draws: self.layout_draws + other.layout_draws,
            instances: self.instances + other.instances,
            glyph_hits: self.glyph_hits + other.glyph_hits,
            glyph_misses: self.glyph_misses + other.glyph_misses,
            text_time: self.text_time + other.text_time,
            atlas_evictions: self.atlas_evictions + other.atlas_evictions,
            atlas_upload_bytes: self.atlas_upload_bytes + other.atlas_upload_bytes,
            atlas_spills: self.atlas_spills + other.atlas_spills,
            device_recoveries: self.device_recoveries + other.device_recoveries,
            recovery_time: self.recovery_time + other.recovery_time,
        }
    }
}

/// GPU memory the renderer holds, by construction (sizes of what it created).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct GpuMemory {
    pub atlas_bytes: u64,
    pub target_bytes: u64,
    pub instance_bytes: u64,
}

impl GpuMemory {
    pub fn total(&self) -> u64 {
        self.atlas_bytes + self.target_bytes + self.instance_bytes
    }
}

/// What wgpu's own counters say is alive on the device, independent of [`GpuMemory`].
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct LiveResources {
    pub buffers: isize,
    pub textures: isize,
    pub buffer_bytes: isize,
    pub texture_bytes: isize,
}

fn extent(width: u32, height: u32) -> wgpu::Extent3d {
    wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    }
}

fn texture(
    device: &wgpu::Device,
    label: &str,
    (width, height): (u32, u32),
    format: wgpu::TextureFormat,
    usage: wgpu::TextureUsages,
) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: extent(width, height),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn instance_buffer(device: &wgpu::Device, instances: usize) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("instances"),
        size: instances as u64 * INSTANCE,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

fn layout_entry(
    binding: u32,
    visibility: wgpu::ShaderStages,
    ty: wgpu::BindingType,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility,
        ty,
        count: None,
    }
}

/// A glyph atlas the fragment shader reads with `textureLoad`.
fn atlas_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    layout_entry(
        binding,
        wgpu::ShaderStages::FRAGMENT,
        wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
    )
}

/// The cell backgrounds of a row as runs (neighbours of one color merged, the theme background
/// dropped because the row is cleared to it first), and every other draw in layout order. The
/// layout paints a cell's background before anything else of that cell and no draw leaves its
/// cell, so painting all backgrounds first gives the same pixels with far fewer instances.
fn split_row<'a>(
    draws: Vec<Draw<'a>>,
    m: CellMetrics,
    top: u32,
    bg: RgbColor,
) -> (Vec<Rect>, Vec<Draw<'a>>) {
    let (mut runs, mut rest) = (Vec::<Rect>::new(), Vec::new());
    let mut next = 0;
    for draw in draws {
        match draw {
            Draw::Rect(r)
                if (r.x, r.y, r.h) == (next, top, m.cell_height)
                    && (r.w == m.cell_width || r.w == 2 * m.cell_width) =>
            {
                next += r.w;
                match runs.last_mut() {
                    Some(last) if last.color == r.color && last.x + last.w == r.x => last.w += r.w,
                    _ if r.color == bg => {}
                    _ => runs.push(r),
                }
            }
            other => rest.push(other),
        }
    }
    (runs, rest)
}

fn check_size(limit: u32, width: u32, height: u32) -> Result<(u32, u32), RenderError> {
    if width == 0 || height == 0 || width.max(height) > limit {
        return Err(RenderError::InvalidSize);
    }
    Ok((width, height))
}

/// A glyph atlas and the texture its masks are written to.
struct GlyphAtlas {
    texture: wgpu::Texture,
    atlas: Atlas,
    /// Bytes per texel: 1 for coverage, 4 for RGBA.
    texel: u32,
}

impl GlyphAtlas {
    fn new(
        device: &wgpu::Device,
        label: &str,
        side: u32,
        format: wgpu::TextureFormat,
        texel: u32,
        metrics: CellMetrics,
    ) -> Result<(Self, wgpu::TextureView), RenderError> {
        let atlas = Atlas::new(side, metrics).ok_or(RenderError::InvalidSize)?;
        let (texture, view) = texture(
            device,
            label,
            (side, side),
            format,
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        );
        Ok((
            Self {
                texture,
                atlas,
                texel,
            },
            view,
        ))
    }

    fn bytes(&self) -> u64 {
        let side = u64::from(self.atlas.size);
        side * side * u64::from(self.texel)
    }
}

/// Everything that dies with the device: rebuilt from core state after a loss.
struct Gpu {
    info: AdapterInfo,
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::RenderPipeline,
    globals: wgpu::Buffer,
    /// Coverage masks (text) and RGBA glyphs (emoji).
    masks: GlyphAtlas,
    colors: GlyphAtlas,
    bind_group: wgpu::BindGroup,
    target: wgpu::Texture,
    target_view: wgpu::TextureView,
    size: (u32, u32),
    instances: wgpu::Buffer,
    instance_capacity: usize,
    /// Instances of the pass being built, reused across frames.
    scratch: Vec<Instance>,
    mask: Vec<u8>,
    stats: GpuStats,
    /// Work submitted since the last `present`.
    pending: bool,
}

impl Gpu {
    /// `epoch` names the device that is current: a loss reported by an older one (its callback
    /// also fires when it is dropped) must not mark the new device lost.
    fn new(
        target: &Target,
        appearance: &Appearance,
        lost: Arc<AtomicBool>,
        epoch: &Arc<AtomicU64>,
    ) -> Result<Self, RenderError> {
        let adapter::Selected {
            info,
            device,
            queue,
            ..
        } = adapter::select(&target.policy)?;
        let side = device.limits().max_texture_dimension_2d;
        let size = check_size(side, target.width, target.height)?;
        let mine = epoch.fetch_add(1, Ordering::SeqCst) + 1;
        let current = epoch.clone();
        let report = move |flag: &AtomicBool| {
            if current.load(Ordering::SeqCst) == mine {
                flag.store(true, Ordering::SeqCst);
            }
        };
        let (on_loss, on_error) = (lost.clone(), lost);
        let loss = report.clone();
        device.set_device_lost_callback(move |_, _| loss(&on_loss));
        // wgpu panics on an error nobody captured. After a loss the driver answers every call
        // with one, and an out-of-memory or internal error is the driver failing: those mark the
        // device lost, so the host recovers. A validation error is this crate's own bug and still panics.
        device.on_uncaptured_error(Arc::new(move |error| match error {
            wgpu::Error::OutOfMemory { .. } | wgpu::Error::Internal { .. } => report(&on_error),
            wgpu::Error::Validation {
                ref description, ..
            } if description.contains("lost") || description.contains("destroyed") => {
                report(&on_error)
            }
            other => panic!("wgpu error: {other}"),
        }));

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("terminal shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("terminal layout"),
            entries: &[
                layout_entry(
                    0,
                    wgpu::ShaderStages::VERTEX,
                    wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                ),
                atlas_entry(1),
                atlas_entry(2),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("terminal pipeline layout"),
            bind_group_layouts: &[Some(&bind_layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("terminal pipeline"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: INSTANCE,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &wgpu::vertex_attr_array![0 => Uint32x4, 1 => Uint32, 2 => Uint32x2, 3 => Uint32],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format: FORMAT,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let globals = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("globals"),
            size: std::mem::size_of::<Globals>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let (masks, atlas_view) = GlyphAtlas::new(
            &device,
            "glyph atlas",
            target.atlas_side.min(side),
            ATLAS_FORMAT,
            1,
            appearance.metrics,
        )?;
        let (colors, color_view) = GlyphAtlas::new(
            &device,
            "color glyph atlas",
            target.color_atlas_side.min(side),
            COLOR_ATLAS_FORMAT,
            4,
            appearance.metrics,
        )?;
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("terminal bindings"),
            layout: &bind_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: globals.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(&atlas_view),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::TextureView(&color_view),
                },
            ],
        });
        let (target, target_view) = Self::target(&device, size);
        let gpu = Self {
            info,
            instances: instance_buffer(&device, 1024),
            instance_capacity: 1024,
            device,
            queue,
            pipeline,
            globals,
            masks,
            colors,
            bind_group,
            target,
            target_view,
            size,
            scratch: Vec::new(),
            mask: Vec::new(),
            stats: GpuStats::default(),
            pending: false,
        };
        gpu.write_globals();
        Ok(gpu)
    }

    fn target(device: &wgpu::Device, size: (u32, u32)) -> (wgpu::Texture, wgpu::TextureView) {
        texture(
            device,
            "terminal target",
            size,
            FORMAT,
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        )
    }

    fn write_globals(&self) {
        let globals = Globals {
            target: [self.size.0 as f32, self.size.1 as f32],
            pad: [0.0; 2],
        };
        self.queue
            .write_buffer(&self.globals, 0, bytemuck::bytes_of(&globals));
    }

    fn resize(&mut self, width: u32, height: u32) -> Result<(), RenderError> {
        let size = check_size(self.device.limits().max_texture_dimension_2d, width, height)?;
        self.target.destroy();
        (self.target, self.target_view) = Self::target(&self.device, size);
        self.size = size;
        self.write_globals();
        Ok(())
    }

    /// Empty atlases of the same textures for the cells of `appearance`.
    fn new_atlases(&self, appearance: &Appearance) -> Result<(Atlas, Atlas), RenderError> {
        let m = appearance.metrics;
        let make = |side| Atlas::new(side, m).ok_or(RenderError::InvalidSize);
        Ok((make(self.masks.atlas.size)?, make(self.colors.atlas.size)?))
    }

    fn atlas(&mut self, kind: Kind) -> &mut GlyphAtlas {
        match kind {
            Kind::Mask => &mut self.masks,
            Kind::Color => &mut self.colors,
        }
    }

    fn begin_batch(&mut self) {
        self.masks.atlas.begin_batch();
        self.colors.atlas.begin_batch();
    }

    fn memory(&self) -> GpuMemory {
        GpuMemory {
            atlas_bytes: self.masks.bytes() + self.colors.bytes(),
            target_bytes: u64::from(self.size.0) * u64::from(self.size.1) * 4,
            instance_bytes: self.instance_capacity as u64 * INSTANCE
                + std::mem::size_of::<Globals>() as u64,
        }
    }

    fn live_resources(&self) -> LiveResources {
        let hal = self.device.get_internal_counters().hal;
        LiveResources {
            buffers: hal.buffers.read(),
            textures: hal.textures.read(),
            buffer_bytes: hal.buffer_memory.read(),
            texture_bytes: hal.texture_memory.read(),
        }
    }

    /// Paint `plan`'s rows into the persistent target. Returns the bytes sent to the GPU.
    fn draw(
        &mut self,
        core: &RendererCore,
        plan: &DrawPlan,
        glyphs: &mut Glyphs,
    ) -> Result<u64, RenderError> {
        let m = core.appearance.metrics;
        let (bg, width) = (core.appearance.theme.background, self.size.0);
        let mut uploaded = 0;
        let mut clear = plan.repaint_all;
        self.begin_batch();
        self.scratch.clear();
        for &y in &plan.rows {
            let top = u32::from(y) * m.cell_height;
            if !plan.repaint_all {
                self.scratch
                    .push(Instance::solid(0, top, width, m.cell_height, bg));
            }
            let drawn = row_draws(&core.screen, y, &core.appearance);
            self.stats.layout_draws += drawn.len() as u64;
            let (backgrounds, draws) = split_row(drawn, m, top, bg);
            self.scratch.extend(
                backgrounds
                    .into_iter()
                    .map(|r| Instance::solid(r.x, r.y, r.w, r.h, r.color)),
            );
            for draw in draws {
                let instance = match draw {
                    Draw::Rect(Rect { x, y, w, h, color }) => Instance::solid(x, y, w, h, color),
                    Draw::Glyph(g) => {
                        let (at, kind, bytes) = match self.glyph(glyphs, m, &g) {
                            Some(found) => found,
                            None => {
                                // Every slot belongs to this frame: submit what is built (its
                                // masks are written), after which any slot may be replaced.
                                self.stats.atlas_spills += 1;
                                uploaded += self.pass(core, std::mem::take(&mut clear));
                                self.begin_batch();
                                self.glyph(glyphs, m, &g).ok_or(RenderError::InvalidSize)?
                            }
                        };
                        uploaded += bytes;
                        Instance {
                            mask: [at.0, at.1],
                            kind: u32::from(kind == Kind::Color),
                            ..Instance::solid(
                                g.x,
                                g.y,
                                g.cells * m.cell_width,
                                m.cell_height,
                                g.color,
                            )
                        }
                    }
                };
                self.scratch.push(instance);
                if self.scratch.len() == MAX_PASS_INSTANCES {
                    uploaded += self.pass(core, std::mem::take(&mut clear));
                }
            }
        }
        if !self.scratch.is_empty() || clear {
            uploaded += self.pass(core, clear);
        }
        self.stats.atlas_evictions +=
            self.masks.atlas.take_evictions() + self.colors.atlas.take_evictions();
        Ok(uploaded)
    }

    /// The origin of a glyph's mask in its atlas, which atlas that is, and the bytes it took to put
    /// it there; `None` when the atlas has no slot left for this frame.
    fn glyph(
        &mut self,
        glyphs: &mut Glyphs,
        m: CellMetrics,
        g: &Glyph<'_>,
    ) -> Option<((u32, u32), Kind, u64)> {
        let kind = glyphs.kind(g);
        let at = match self
            .atlas(kind)
            .atlas
            .slot(g.text, g.cells == 2, g.bold, g.italic)
        {
            Slot::Hit(at) => {
                self.stats.glyph_hits += 1;
                return Some((at, kind, 0));
            }
            Slot::Miss(at) => at,
            Slot::Full => return None,
        };
        self.stats.glyph_misses += 1;
        let (w, h) = (g.cells * m.cell_width, m.cell_height);
        // The mask is as the font drew it; a color face decides the kind, which the atlas
        // already assumed from the same choice.
        let drawn = glyphs.render(m, g, &mut self.mask);
        debug_assert_eq!(drawn, kind);
        let into = match kind {
            Kind::Mask => &self.masks,
            Kind::Color => &self.colors,
        };
        let texel = into.texel;
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &into.texture,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: at.0,
                    y: at.1,
                    z: 0,
                },
                aspect: wgpu::TextureAspect::All,
            },
            &self.mask,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w * texel),
                rows_per_image: Some(h),
            },
            extent(w, h),
        );
        let bytes = u64::from(w * h * texel);
        self.stats.atlas_upload_bytes += bytes;
        Some((at, kind, bytes))
    }

    /// Submit the instances built so far as one render pass; returns the bytes uploaded.
    fn pass(&mut self, core: &RendererCore, clear: bool) -> u64 {
        let count = self.scratch.len();
        if count > self.instance_capacity {
            self.instances.destroy();
            self.instance_capacity = count.next_power_of_two().min(MAX_PASS_INSTANCES);
            self.instances = instance_buffer(&self.device, self.instance_capacity);
        }
        let bytes: &[u8] = bytemuck::cast_slice(&self.scratch);
        self.queue.write_buffer(&self.instances, 0, bytes);
        let load = if clear {
            let bg = core.appearance.theme.background;
            let c = |v: u8| f64::from(v) / 255.0;
            wgpu::LoadOp::Clear(wgpu::Color {
                r: c(bg.r),
                g: c(bg.g),
                b: c(bg.b),
                a: 1.0,
            })
        } else {
            wgpu::LoadOp::Load
        };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("terminal pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.target_view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load,
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &self.bind_group, &[]);
            pass.set_vertex_buffer(0, self.instances.slice(..));
            pass.draw(0..4, 0..count as u32);
        }
        self.queue.submit([encoder.finish()]);
        self.stats.submissions += 1;
        self.stats.passes += 1;
        self.stats.instances += count as u64;
        self.pending = true;
        let uploaded = bytes.len() as u64;
        self.scratch.clear();
        uploaded
    }

    /// Free every resource now rather than when the last reference drops.
    fn release(&self) {
        self.target.destroy();
        self.masks.texture.destroy();
        self.colors.texture.destroy();
        self.instances.destroy();
        self.globals.destroy();
    }
}

pub struct WgpuRenderer {
    core: RendererCore,
    /// Where glyph masks come from; lives beside the device, so a loss does not cost the fonts.
    glyphs: Glyphs,
    /// `None` after `destroy`.
    gpu: Option<Gpu>,
    target: Target,
    epoch: Arc<AtomicU64>,
    /// Counters of the devices that are gone, carried into the next one.
    carried: GpuStats,
    /// What the driver still counted alive right after `destroy` freed everything.
    released: Option<LiveResources>,
}

impl WgpuRenderer {
    fn gpu(&self) -> Result<&Gpu, RenderError> {
        self.gpu.as_ref().ok_or(RenderError::Destroyed)
    }

    fn gpu_mut(&mut self) -> Result<&mut Gpu, RenderError> {
        self.gpu.as_mut().ok_or(RenderError::Destroyed)
    }

    /// The adapter the renderer runs on.
    pub fn adapter(&self) -> Result<&AdapterInfo, RenderError> {
        Ok(&self.gpu()?.info)
    }

    pub fn gpu_stats(&self) -> GpuStats {
        let mut stats = self
            .carried
            .plus(self.gpu.as_ref().map(|g| g.stats).unwrap_or_default());
        stats.text_time += self.glyphs.time();
        stats
    }

    /// The GPU memory this renderer holds; zero after `destroy`.
    pub fn memory(&self) -> GpuMemory {
        self.gpu.as_ref().map(Gpu::memory).unwrap_or_default()
    }

    /// Distinct masks the atlas can hold, and how many it holds now.
    pub fn atlas_slots(&self) -> (usize, usize) {
        self.gpu.as_ref().map_or((0, 0), |g| {
            (g.masks.atlas.capacity(), g.masks.atlas.resident())
        })
    }

    /// The same for the color (emoji) atlas.
    pub fn color_atlas_slots(&self) -> (usize, usize) {
        self.gpu.as_ref().map_or((0, 0), |g| {
            (g.colors.atlas.capacity(), g.colors.atlas.resident())
        })
    }

    /// Replace the fonts glyphs are drawn with (the user imported or removed one in Preferences);
    /// every row is repainted. Without any font the glyphs are the reference dot patterns.
    pub fn set_fonts(&mut self, fonts: FontLibrary) -> Result<(), RenderError> {
        self.core.live()?;
        let appearance = self.core.appearance.clone();
        let atlases = self.gpu()?.new_atlases(&appearance)?;
        self.target.fonts = (!fonts.is_empty()).then(|| Arc::new(fonts));
        self.carried.text_time += self.glyphs.time();
        self.glyphs = Glyphs::new(self.target.fonts.as_deref(), &appearance);
        let gpu = self.gpu_mut()?;
        (gpu.masks.atlas, gpu.colors.atlas) = atlases;
        self.core.repaint();
        Ok(())
    }

    /// What wgpu's own counters say is alive on the device.
    pub fn live_resources(&self) -> Result<LiveResources, RenderError> {
        Ok(self.gpu()?.live_resources())
    }

    /// What the driver counted alive right after `destroy`: all zeros when nothing leaked.
    pub fn resources_after_destroy(&self) -> Option<LiveResources> {
        self.released
    }

    /// Simulate what a GPU reset does: the device is destroyed, every call but `resume`, `destroy`
    /// and `stats` reports `DeviceLost`, and `resume` builds a new device.
    pub fn lose_device(&mut self) {
        if let Some(gpu) = &self.gpu {
            gpu.device.destroy();
        }
        self.core.lose_device();
    }

    /// Simulate a driver reset the renderer was not told about: only the device is destroyed. The
    /// loss is learned the way a real one is, from the device's callback or from the errors of
    /// later calls, and every call then reports `DeviceLost` until `resume`.
    pub fn reset_device_behind_the_renderers_back(&mut self) {
        if let Some(gpu) = &self.gpu {
            gpu.device.destroy();
        }
    }

    /// The target as an image. Waits for the GPU; for tests and the bench check, not a frame path.
    pub fn read_image(&mut self) -> Result<Image, RenderError> {
        let gpu = self.gpu_mut()?;
        let (w, h) = gpu.size;
        let row = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(row * h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &gpu.target,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(row),
                    rows_per_image: Some(h),
                },
            },
            extent(w, h),
        );
        gpu.queue.submit([encoder.finish()]);
        buffer.map_async(wgpu::MapMode::Read, .., |result| result.expect("map"));
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|_| RenderError::DeviceLost)?;
        let data = buffer.slice(..).get_mapped_range().expect("mapped range");
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h as usize {
            for px in data[y * row as usize..][..w as usize * 4].chunks_exact(4) {
                rgb.extend_from_slice(&px[..3]);
            }
        }
        drop(data);
        buffer.destroy();
        Ok(Image {
            width: w,
            height: h,
            rgb,
        })
    }
}

impl TerminalRenderer for WgpuRenderer {
    type Surface = Target;

    fn create(surface: Target, appearance: Appearance) -> Result<Self, RenderError> {
        let core = RendererCore::new(appearance)?;
        let epoch = Arc::new(AtomicU64::new(0));
        let gpu = Gpu::new(&surface, &core.appearance, core.lost_flag(), &epoch)?;
        Ok(Self {
            glyphs: Glyphs::new(surface.fonts.as_deref(), &core.appearance),
            core,
            gpu: Some(gpu),
            target: surface,
            epoch,
            carried: GpuStats::default(),
            released: None,
        })
    }

    fn set_appearance(&mut self, appearance: Appearance) -> Result<(), RenderError> {
        self.core.live()?;
        appearance.metrics.validate()?;
        let before = &self.core.appearance;
        // A new cell size or font list changes every mask: the new atlases are built first, so a
        // size the texture cannot hold is refused with everything unchanged.
        let atlases = if before.metrics != appearance.metrics
            || before.font_families != appearance.font_families
        {
            Some(self.gpu()?.new_atlases(&appearance)?)
        } else {
            None
        };
        let glyphs = atlases
            .is_some()
            .then(|| Glyphs::new(self.target.fonts.as_deref(), &appearance));
        self.core.set_appearance(appearance)?;
        if let (Some((masks, colors)), Some(glyphs)) = (atlases, glyphs) {
            let gpu = self.gpu_mut()?;
            (gpu.masks.atlas, gpu.colors.atlas) = (masks, colors);
            self.carried.text_time += self.glyphs.time();
            self.glyphs = glyphs;
        }
        Ok(())
    }

    fn resize(&mut self, width: u32, height: u32) -> Result<(), RenderError> {
        self.core.live()?;
        if self.gpu()?.size == (width, height) {
            return Ok(());
        }
        self.gpu_mut()?.resize(width, height)?;
        (self.target.width, self.target.height) = (width, height);
        self.core.repaint();
        Ok(())
    }

    forward_to_core!(core);

    fn draw(&mut self) -> Result<u32, RenderError> {
        let Some(plan) = self.core.begin_draw()? else {
            return Ok(0);
        };
        let gpu = self.gpu.as_mut().ok_or(RenderError::Destroyed)?;
        self.core.stats.bytes_uploaded += gpu.draw(&self.core, &plan, &mut self.glyphs)?;
        Ok(self.core.finish_draw(&plan))
    }

    /// An offscreen target has no swapchain, so presenting waits until the GPU has finished what
    /// `draw` submitted: the latest moment a swapchain image could be shown.
    fn present(&mut self) -> Result<(), RenderError> {
        if !self.core.begin_present()? {
            return Ok(());
        }
        let gpu = self.gpu.as_mut().ok_or(RenderError::Destroyed)?;
        if !std::mem::take(&mut gpu.pending) {
            return Ok(());
        }
        let started = Instant::now();
        gpu.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|_| RenderError::DeviceLost)?;
        self.core.finish_present(0, started);
        Ok(())
    }

    fn resume(&mut self) -> Result<(), RenderError> {
        if self.core.resume()? == Resume::DeviceRecovered {
            // A destroyed device cannot be reused: build a new one, keeping the counters.
            let started = Instant::now();
            if let Some(old) = self.gpu.take() {
                self.epoch.fetch_add(1, Ordering::SeqCst);
                old.release();
                self.carried = self.carried.plus(old.stats);
                self.carried.device_recoveries += 1;
            }
            let (target, appearance) = (&self.target, &self.core.appearance);
            match Gpu::new(target, appearance, self.core.lost_flag(), &self.epoch) {
                Ok(gpu) => {
                    self.gpu = Some(gpu);
                    self.carried.recovery_time += started.elapsed();
                }
                Err(error) => {
                    // Still no device: stay lost, so the host tries again later.
                    self.core.lose_device();
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    fn destroy(&mut self) {
        self.core.destroy();
        if let Some(gpu) = self.gpu.take() {
            self.epoch.fetch_add(1, Ordering::SeqCst);
            gpu.release();
            // Let the driver reclaim what was destroyed before counting what is left.
            let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            self.released = Some(gpu.live_resources());
            self.carried = self.carried.plus(gpu.stats);
        }
    }
}

//! Prototype wgpu implementation of `TerminalRenderer` for the renderer shootout (#1323). Not for
//! shipping: it draws into an offscreen texture of its own device (no window, no swapchain),
//! rasterizes the same dot-pattern glyphs as the CPU reference renderer through a mask atlas, and
//! has no fonts, shaping, eviction or Android path. What it can show honestly is correctness
//! against the reference (pixel for pixel) and the cost of an instanced-quad pipeline on the host
//! GPU for the same `Frame` stream.

use bytemuck::{Pod, Zeroable};
use lazysh_terminal_runtime::layout::{glyph_pixels, row_draws, Draw, Glyph, Rect};
use lazysh_terminal_runtime::{
    Appearance, CellMetrics, Image, RenderError, RendererCore, Resume, RgbColor, TerminalRenderer,
};
use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Instant;

const ATLAS: u32 = 2048;
const MAX_SIDE: u32 = 8192;
const SOLID: u32 = u32::MAX;
const FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8Unorm;
const INSTANCE: u64 = std::mem::size_of::<Instance>() as u64;

/// The surface of this prototype: the size of the offscreen texture in device pixels.
#[derive(Debug, Clone, Copy)]
pub struct Target {
    pub width: u32,
    pub height: u32,
}

/// One rectangle of the shared layout: a solid fill, or a glyph mask taken from the atlas.
#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct Instance {
    rect: [u32; 4],
    color: u32,
    mask: [u32; 2],
    pad: u32,
}

impl Instance {
    fn solid(x: u32, y: u32, w: u32, h: u32, color: RgbColor) -> Self {
        Self {
            rect: [x, y, w, h],
            color: u32::from(color.r) | u32::from(color.g) << 8 | u32::from(color.b) << 16,
            mask: [SOLID; 2],
            pad: 0,
        }
    }
}

#[derive(Clone, Copy, Pod, Zeroable)]
#[repr(C)]
struct Globals {
    target: [f32; 2],
    pad: [f32; 2],
}

/// The adapter a renderer ended up on, for the environment block of a result.
#[derive(Debug, Clone)]
pub struct AdapterInfo {
    pub name: String,
    pub backend: String,
    pub device_type: String,
    pub driver: String,
}

/// Glyph masks (one byte per pixel, 255 where the glyph paints) packed in shelves. No eviction:
/// a full atlas is an error, which is enough for a prototype fed with a bounded corpus.
struct Atlas {
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    slots: HashMap<(String, u32, bool), (u32, u32)>,
    /// Next free x on the current shelf, the shelf's y and its height.
    shelf: (u32, u32, u32),
}

impl Atlas {
    fn new(device: &wgpu::Device) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("glyph atlas"),
            size: extent(ATLAS, ATLAS),
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Self {
            texture,
            view,
            slots: HashMap::new(),
            shelf: (0, 0, 0),
        }
    }

    /// Where the mask of a cluster lives, rasterizing and uploading it on first use; returns the
    /// bytes uploaded as well.
    fn slot(
        &mut self,
        queue: &wgpu::Queue,
        m: CellMetrics,
        g: &Glyph<'_>,
    ) -> Result<((u32, u32), u64), RenderError> {
        let key = (g.text.to_string(), g.cells, g.bold);
        if let Some(&at) = self.slots.get(&key) {
            return Ok((at, 0));
        }
        let (w, h) = (g.cells * m.cell_width, m.cell_height);
        let (mut x, mut y, mut shelf_h) = self.shelf;
        if x + w > ATLAS {
            (x, y, shelf_h) = (0, y + shelf_h, 0);
        }
        if y + h > ATLAS {
            return Err(RenderError::InvalidFrame("glyph atlas full (no eviction)"));
        }
        let mut mask = vec![0u8; (w * h) as usize];
        for (px, py, run) in glyph_pixels(m, g.cells, g.text, g.bold) {
            let at = (py * w + px) as usize;
            mask[at..at + run as usize].fill(255);
        }
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x, y, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            &mask,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(w),
                rows_per_image: Some(h),
            },
            extent(w, h),
        );
        self.shelf = (x + w, y, shelf_h.max(h));
        self.slots.insert(key, (x, y));
        Ok(((x, y), u64::from(w * h)))
    }
}

fn extent(width: u32, height: u32) -> wgpu::Extent3d {
    wgpu::Extent3d {
        width,
        height,
        depth_or_array_layers: 1,
    }
}

fn new_target(device: &wgpu::Device, size: Target) -> (wgpu::Texture, wgpu::TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("terminal target"),
        size: extent(size.width, size.height),
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
    (texture, view)
}

fn check_size(width: u32, height: u32) -> Result<(), RenderError> {
    if width == 0 || height == 0 || width.max(height) > MAX_SIDE {
        return Err(RenderError::InvalidSize);
    }
    Ok(())
}

pub struct WgpuRenderer {
    core: RendererCore,
    device: wgpu::Device,
    queue: wgpu::Queue,
    info: AdapterInfo,
    pipeline: wgpu::RenderPipeline,
    globals: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    atlas: Atlas,
    target: wgpu::Texture,
    target_view: wgpu::TextureView,
    instances: wgpu::Buffer,
    size: Target,
    submitted: bool,
}

impl WgpuRenderer {
    pub fn adapter(&self) -> &AdapterInfo {
        &self.info
    }

    /// Simulate what a GPU reset does: the device is destroyed, every call but `resume`, `destroy`
    /// and `stats` reports `DeviceLost`, and `resume` builds a new device.
    pub fn lose_device(&mut self) {
        self.device.destroy();
        self.core.lose_device();
    }

    fn write_globals(&self) {
        let globals = Globals {
            target: [self.size.width as f32, self.size.height as f32],
            pad: [0.0; 2],
        };
        self.queue
            .write_buffer(&self.globals, 0, bytemuck::bytes_of(&globals));
    }

    /// The target as an image. Waits for the GPU; for tests and the bench check, not a frame path.
    pub fn read_image(&mut self) -> Image {
        let (w, h) = (self.size.width, self.size.height);
        let row = (w * 4).next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size: u64::from(row * h),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.target,
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
        self.queue.submit([encoder.finish()]);
        buffer.map_async(wgpu::MapMode::Read, .., |result| result.expect("map"));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("poll");
        let data = buffer.slice(..).get_mapped_range().expect("mapped range");
        let mut rgb = Vec::with_capacity((w * h * 3) as usize);
        for y in 0..h as usize {
            for px in data[y * row as usize..][..w as usize * 4].chunks_exact(4) {
                rgb.extend_from_slice(&px[..3]);
            }
        }
        Image {
            width: w,
            height: h,
            rgb,
        }
    }

    /// The instances of the given rows: a background fill of each row, then its layout in order.
    /// Returns them with the bytes uploaded to the atlas on the way.
    fn instances_for(&mut self, rows: &[u16]) -> Result<(Vec<Instance>, u64), RenderError> {
        let m = self.core.appearance.metrics;
        let (bg, width) = (self.core.appearance.theme.background, self.size.width);
        let (mut out, mut uploaded) = (Vec::new(), 0);
        for &y in rows {
            out.push(Instance::solid(
                0,
                u32::from(y) * m.cell_height,
                width,
                m.cell_height,
                bg,
            ));
            for draw in row_draws(&self.core.screen, y, &self.core.appearance) {
                out.push(match draw {
                    Draw::Rect(Rect { x, y, w, h, color }) => Instance::solid(x, y, w, h, color),
                    Draw::Glyph(g) => {
                        let (at, bytes) = self.atlas.slot(&self.queue, m, &g)?;
                        uploaded += bytes;
                        Instance {
                            mask: [at.0, at.1],
                            ..Instance::solid(
                                g.x,
                                g.y,
                                g.cells * m.cell_width,
                                m.cell_height,
                                g.color,
                            )
                        }
                    }
                });
            }
        }
        Ok((out, uploaded))
    }
}

fn bind_group(
    device: &wgpu::Device,
    layout: &wgpu::BindGroupLayout,
    globals: &wgpu::Buffer,
    atlas: &wgpu::TextureView,
) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("terminal bindings"),
        layout,
        entries: &[
            wgpu::BindGroupEntry {
                binding: 0,
                resource: globals.as_entire_binding(),
            },
            wgpu::BindGroupEntry {
                binding: 1,
                resource: wgpu::BindingResource::TextureView(atlas),
            },
        ],
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

fn instance_buffer(device: &wgpu::Device, instances: u64) -> wgpu::Buffer {
    device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("instances"),
        size: instances * INSTANCE,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

impl TerminalRenderer for WgpuRenderer {
    type Surface = Target;

    fn create(surface: Target, appearance: Appearance) -> Result<Self, RenderError> {
        let core = RendererCore::new(appearance)?;
        check_size(surface.width, surface.height)?;
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            ..Default::default()
        }))
        .map_err(|_| RenderError::DeviceLost)?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|_| RenderError::DeviceLost)?;
        let flag = core.lost_flag();
        device.set_device_lost_callback(move |_, _| flag.store(true, Ordering::SeqCst));
        let a = adapter.get_info();
        let info = AdapterInfo {
            name: a.name.clone(),
            backend: format!("{:?}", a.backend),
            device_type: format!("{:?}", a.device_type),
            driver: format!("{} {}", a.driver, a.driver_info),
        };

        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("terminal shader"),
            source: wgpu::ShaderSource::Wgsl(include_str!("shader.wgsl").into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
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
                layout_entry(
                    1,
                    wgpu::ShaderStages::FRAGMENT,
                    wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                ),
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("terminal pipeline layout"),
            bind_group_layouts: &[Some(&layout)],
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
                    attributes: &wgpu::vertex_attr_array![0 => Uint32x4, 1 => Uint32, 2 => Uint32x2],
                })],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(FORMAT.into())],
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
        let atlas = Atlas::new(&device);
        let (target, target_view) = new_target(&device, surface);
        let renderer = Self {
            core,
            bind_group: bind_group(&device, &layout, &globals, &atlas.view),
            instances: instance_buffer(&device, 4096),
            device,
            queue,
            info,
            pipeline,
            globals,
            atlas,
            target,
            target_view,
            size: surface,
            submitted: false,
        };
        renderer.write_globals();
        Ok(renderer)
    }

    fn set_appearance(&mut self, appearance: Appearance) -> Result<(), RenderError> {
        self.core.set_appearance(appearance)?;
        self.atlas.slots.clear();
        self.atlas.shelf = (0, 0, 0);
        Ok(())
    }

    fn resize(&mut self, width: u32, height: u32) -> Result<(), RenderError> {
        self.core.live()?;
        check_size(width, height)?;
        self.size = Target { width, height };
        (self.target, self.target_view) = new_target(&self.device, self.size);
        self.write_globals();
        self.core.repaint();
        Ok(())
    }

    fn draw(&mut self) -> Result<u32, RenderError> {
        let Some(plan) = self.core.begin_draw()? else {
            return Ok(0);
        };
        let (instances, atlas_bytes) = self.instances_for(&plan.rows)?;
        let bytes: &[u8] = bytemuck::cast_slice(&instances);
        if bytes.len() as u64 > self.instances.size() {
            self.instances =
                instance_buffer(&self.device, (instances.len() as u64).next_power_of_two());
        }
        self.queue.write_buffer(&self.instances, 0, bytes);
        let bg = self.core.appearance.theme.background;
        let load = if plan.repaint_all {
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
            pass.draw(0..4, 0..instances.len() as u32);
        }
        self.queue.submit([encoder.finish()]);
        self.submitted = true;
        // Uploads happen at submit time here (a swapchain would copy nothing at present).
        self.core.stats.bytes_uploaded += bytes.len() as u64 + atlas_bytes;
        Ok(self.core.finish_draw(&plan))
    }

    /// An offscreen target has no swapchain, so presenting waits until the GPU has finished what
    /// `draw` submitted: the latest moment a swapchain image could be shown.
    fn present(&mut self) -> Result<(), RenderError> {
        if !self.core.begin_present()? || !std::mem::take(&mut self.submitted) {
            return Ok(());
        }
        let started = Instant::now();
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map_err(|_| RenderError::DeviceLost)?;
        self.core.finish_present(0, started);
        Ok(())
    }

    fn resume(&mut self) -> Result<(), RenderError> {
        if self.core.resume()? == Resume::DeviceRecovered {
            // A destroyed device cannot be reused: build a new one, keeping the counters.
            let stats = self.core.stats;
            *self = Self::create(self.size, self.core.appearance.clone())?;
            self.core.stats = stats;
        }
        Ok(())
    }

    fn destroy(&mut self) {
        self.core.destroy();
    }

    lazysh_terminal_runtime::forward_to_core!(core);
}

//! A wgpu (Vulkan) swapchain on a raw Wayland surface: what the real renderer needs from a native surface.
use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, WaylandDisplayHandle, WaylandWindowHandle,
};
use std::ptr::NonNull;

pub struct VulkanTarget {
    // Field order is drop order: the surface goes before the instance that made it.
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pub adapter: String,
}

impl VulkanTarget {
    /// `display` and `surface` are the `wl_display` and `wl_surface` pointers; both must outlive the target.
    pub fn new(display: *mut std::ffi::c_void, surface: *mut std::ffi::c_void) -> Self {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::VULKAN,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let target = wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Wayland(WaylandDisplayHandle::new(
                NonNull::new(display).unwrap(),
            ))),
            raw_window_handle: RawWindowHandle::Wayland(WaylandWindowHandle::new(
                NonNull::new(surface).unwrap(),
            )),
        };
        let surface = unsafe { instance.create_surface_unsafe(target) }
            .expect("vulkan surface on a wl_surface");
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            ..Default::default()
        }))
        .expect("adapter");
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .expect("device");
        let mut config = surface
            .get_default_config(&adapter, 16, 16)
            .expect("surface config");
        // exact 8 bit colour: a non-sRGB format keeps the clear value as written
        config.format = wgpu::TextureFormat::Bgra8Unorm;
        let info = adapter.get_info();
        Self {
            surface,
            device,
            queue,
            config,
            adapter: format!("{} ({:?})", info.name, info.backend),
        }
    }

    pub fn present(&mut self, w: u32, h: u32, argb: u32) {
        self.config.width = w.max(1);
        self.config.height = h.max(1);
        self.surface.configure(&self.device, &self.config);
        let frame = match self.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            other => panic!("no frame: {other:?}"),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let c = |shift: u32| f64::from((argb >> shift) & 0xff) / 255.0;
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color {
                        r: c(16),
                        g: c(8),
                        b: c(0),
                        a: 1.0,
                    }),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        }));
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
    }
}

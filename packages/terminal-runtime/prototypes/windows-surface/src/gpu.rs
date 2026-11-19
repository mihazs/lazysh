//! A wgpu Direct3D 12 swapchain on a child window: what the real renderer needs from a native surface.
use raw_window_handle::{
    RawDisplayHandle, RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle,
};
use std::num::NonZeroIsize;

pub struct Swapchain {
    // Field order is drop order: the surface goes before the instance that made it.
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pub adapter: String,
}

impl Swapchain {
    pub fn new(hwnd: isize) -> Result<Self, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            ..wgpu::InstanceDescriptor::new_without_display_handle()
        });
        let target = wgpu::SurfaceTargetUnsafe::RawHandle {
            raw_display_handle: Some(RawDisplayHandle::Windows(WindowsDisplayHandle::new())),
            raw_window_handle: RawWindowHandle::Win32(Win32WindowHandle::new(
                NonZeroIsize::new(hwnd).ok_or("null window")?,
            )),
        };
        let surface = unsafe { instance.create_surface_unsafe(target) }
            .map_err(|e| format!("surface: {e}"))?;
        // A hosted runner has no GPU: Direct3D 12 there is WARP, the CPU adapter that ships with Windows.
        let adapter = [false, true]
            .into_iter()
            .find_map(|force_fallback_adapter| {
                let options = wgpu::RequestAdapterOptions {
                    compatible_surface: Some(&surface),
                    force_fallback_adapter,
                    ..Default::default()
                };
                pollster::block_on(instance.request_adapter(&options)).ok()
            })
            .ok_or("no Direct3D 12 adapter")?;
        let (device, queue) =
            pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default()))
                .map_err(|e| format!("device: {e}"))?;
        let mut config = surface
            .get_default_config(&adapter, 16, 16)
            .ok_or("surface has no configuration")?;
        // Exact 8 bit colour: a non-sRGB format keeps the clear value as written.
        config.format = wgpu::TextureFormat::Bgra8Unorm;
        let info = adapter.get_info();
        Ok(Self {
            surface,
            device,
            queue,
            config,
            adapter: format!("{} ({:?}, {:?})", info.name, info.backend, info.device_type),
        })
    }

    /// Resizes the swapchain to the window and presents one frame of a solid colour.
    pub fn present(&mut self, w: i32, h: i32, rgb: [u8; 3]) -> Result<(), String> {
        self.config.width = w.max(1) as u32;
        self.config.height = h.max(1) as u32;
        self.surface.configure(&self.device, &self.config);
        let (wgpu::CurrentSurfaceTexture::Success(frame)
        | wgpu::CurrentSurfaceTexture::Suboptimal(frame)) = self.surface.get_current_texture()
        else {
            return Err("the swapchain gave no frame".into());
        };
        let view = frame.texture.create_view(&Default::default());
        let [r, g, b] = rgb.map(|c| f64::from(c) / 255.0);
        let clear = wgpu::Color { r, g, b, a: 1.0 };
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        let attachment = wgpu::RenderPassColorAttachment {
            view: &view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(clear),
                store: wgpu::StoreOp::Store,
            },
        };
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(attachment)],
            ..Default::default()
        }));
        self.queue.submit([encoder.finish()]);
        self.queue.present(frame);
        Ok(())
    }
}

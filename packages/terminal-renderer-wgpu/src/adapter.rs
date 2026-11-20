//! Which GPU the renderer runs on, and what happens when there is none.
//!
//! The choice is a pure function of what the platform reports ([`rank`]), so the fallbacks are
//! tested without every kind of hardware: backends are tried in the order of the [`Policy`] (the
//! first one that has a usable adapter wins), within a backend discrete before integrated before
//! virtual GPUs, and a CPU rasterizer only when the policy allows it. Production refuses software
//! adapters because the rollout rule is "a device keeps xterm.js unless the native renderer
//! beats it" and a software rasterizer cannot; CI and tests allow them to exercise the real path.

use lazysh_terminal_runtime::RenderError;
use wgpu::rwh::{DisplayHandle, HandleError, HasDisplayHandle, RawDisplayHandle, RawWindowHandle};
use wgpu::{Backend, Backends, DeviceType};

/// What a renderer may run on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// Backends in order of preference: an adapter of an earlier backend beats any of a later one.
    pub backends: Vec<Backend>,
    /// Accept CPU adapters (lavapipe, llvmpipe, WARP) after every GPU.
    pub allow_software: bool,
}

impl Policy {
    /// The shipping policy of the platform this was compiled for. Vulkan, then OpenGL ES on
    /// Android and Linux; Metal on Apple; Direct3D 12, then Vulkan on Windows. No software.
    pub fn for_platform() -> Self {
        let backends = if cfg!(target_vendor = "apple") {
            vec![Backend::Metal]
        } else if cfg!(windows) {
            vec![Backend::Dx12, Backend::Vulkan]
        } else {
            vec![Backend::Vulkan, Backend::Gl]
        };
        Self {
            backends,
            allow_software: false,
        }
    }

    /// The platform's backends with software adapters allowed: what tests and CI use, where the
    /// only adapter may be a CPU rasterizer.
    pub fn with_software(mut self) -> Self {
        self.allow_software = true;
        self
    }

    fn mask(&self) -> Backends {
        self.backends
            .iter()
            .fold(Backends::empty(), |mask, &b| mask | Backends::from(b))
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self::for_platform()
    }
}

/// The adapter a renderer ended up on, for the environment block of a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterInfo {
    pub name: String,
    pub backend: Backend,
    pub device_type: DeviceType,
    pub driver: String,
}

impl From<&wgpu::AdapterInfo> for AdapterInfo {
    fn from(info: &wgpu::AdapterInfo) -> Self {
        Self {
            name: info.name.clone(),
            backend: info.backend,
            device_type: info.device_type,
            driver: format!("{} {}", info.driver, info.driver_info),
        }
    }
}

/// Lower is better; `None` means the policy refuses the adapter.
pub fn rank(policy: &Policy, info: &AdapterInfo) -> Option<(usize, u8)> {
    let backend = policy.backends.iter().position(|&b| b == info.backend)?;
    let kind = match info.device_type {
        DeviceType::DiscreteGpu => 0,
        DeviceType::IntegratedGpu => 1,
        DeviceType::VirtualGpu => 2,
        DeviceType::Other => 3,
        DeviceType::Cpu if policy.allow_software => 4,
        DeviceType::Cpu => return None,
    };
    Some((backend, kind))
}

/// The indexes of the adapters the policy accepts, best first; equal ranks keep their order.
pub fn ranked(policy: &Policy, adapters: &[AdapterInfo]) -> Vec<usize> {
    let mut accepted: Vec<_> = adapters
        .iter()
        .enumerate()
        .filter_map(|(i, info)| Some((rank(policy, info)?, i)))
        .collect();
    accepted.sort();
    accepted.into_iter().map(|(_, i)| i).collect()
}

/// A platform window to present on, as the raw handles of `raw-window-handle` 0.6 (`wgpu::rwh`): an
/// `ANativeWindow`, a `CAMetalLayer`'s view, an `HWND`, a Wayland or X11 surface. The renderer only
/// hands them to wgpu, which creates the swapchain; nothing here is platform code.
#[derive(Debug, Clone, Copy)]
pub struct Window {
    display: RawDisplayHandle,
    window: RawWindowHandle,
}

// SAFETY: the handles are ids and pointers this crate never dereferences; `Window::new`'s caller
// promises they may be used from the thread that drives the renderer.
unsafe impl Send for Window {}
unsafe impl Sync for Window {}

impl Window {
    /// # Safety
    ///
    /// Both handles must be valid, usable from the thread that drives the renderer, and stay valid
    /// until every renderer created on them was destroyed or dropped: a host destroys the renderer
    /// before it lets the platform take the surface back.
    pub unsafe fn new(display: RawDisplayHandle, window: RawWindowHandle) -> Self {
        Self { display, window }
    }
}

impl HasDisplayHandle for Window {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        // SAFETY: `Window::new`'s caller keeps the display alive.
        Ok(unsafe { DisplayHandle::borrow_raw(self.display) })
    }
}

/// An adapter with a device, in the order the policy ranks them. Creating the device is part of
/// the check: an adapter that lists but cannot create a device is skipped, not fatal.
pub(crate) struct Selected {
    pub info: AdapterInfo,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    /// The window's surface and the configuration to present with, for a target with a window.
    pub screen: Option<(wgpu::Surface<'static>, wgpu::SurfaceConfiguration)>,
}

/// With a `window`, only an adapter that can present on it is chosen, at `size` device pixels.
pub(crate) fn select(
    policy: &Policy,
    window: Option<Window>,
    size: (u32, u32),
) -> Result<Selected, RenderError> {
    let backends = policy.mask();
    if backends.is_empty() {
        return Err(RenderError::Unsupported("the policy allows no backend"));
    }
    let mut descriptor = wgpu::InstanceDescriptor {
        backends,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    };
    if let Some(window) = window {
        // OpenGL ES picks its display when the instance is made.
        descriptor = descriptor.with_display_handle(Box::new(window));
    }
    let instance = wgpu::Instance::new(descriptor);
    let surface = window
        .map(|w| {
            // SAFETY: `Window::new`'s caller keeps both handles valid for as long as the renderer,
            // which owns this surface, lives.
            unsafe {
                instance.create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: Some(w.display),
                    raw_window_handle: w.window,
                })
            }
        })
        .transpose()
        .map_err(|_| RenderError::Unsupported("no backend of the policy can draw on the window"))?;
    let adapters = pollster::block_on(instance.enumerate_adapters(backends));
    let infos: Vec<_> = adapters
        .iter()
        .map(|a| AdapterInfo::from(&a.get_info()))
        .collect();
    for i in ranked(policy, &infos) {
        let adapter = adapters[i].clone();
        let config = match &surface {
            Some(surface) => match present_config(surface, &adapter, size) {
                Some(config) => Some(config),
                None => continue,
            },
            None => None,
        };
        // Every pipeline the renderer needs runs on the downlevel baseline (OpenGL ES 3.0), at the
        // largest texture size this adapter offers.
        let limits = wgpu::Limits::downlevel_defaults().using_resolution(adapter.limits());
        let request = adapter.request_device(&wgpu::DeviceDescriptor {
            required_limits: limits,
            ..Default::default()
        });
        if let Ok((device, queue)) = pollster::block_on(request) {
            return Ok(Selected {
                info: infos[i].clone(),
                device,
                queue,
                screen: surface.zip(config),
            });
        }
    }
    Err(RenderError::Unsupported(
        "no adapter the policy accepts could create a device",
    ))
}

/// How to present on `surface` with `adapter` (vsync, opaque); `None` when the adapter cannot.
/// The target holds the theme's colours as they are, so the swapchain must not encode them again:
/// a format without sRGB encoding is taken when the surface offers one.
// shortcut: a surface that offers only sRGB formats shows colours brighter than the theme's;
// upgrade to a non-sRGB view format when a platform reports such a surface.
fn present_config(
    surface: &wgpu::Surface<'_>,
    adapter: &wgpu::Adapter,
    (width, height): (u32, u32),
) -> Option<wgpu::SurfaceConfiguration> {
    let mut config = surface.get_default_config(adapter, width, height)?;
    let formats = surface.get_capabilities(adapter).formats;
    if let Some(&plain) = formats.iter().find(|format| !format.is_srgb()) {
        config.format = plain;
    }
    Some(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn adapter(backend: Backend, device_type: DeviceType) -> AdapterInfo {
        AdapterInfo {
            name: format!("{backend:?} {device_type:?}"),
            backend,
            device_type,
            driver: String::new(),
        }
    }

    fn picks(policy: &Policy, adapters: &[AdapterInfo]) -> Vec<String> {
        ranked(policy, adapters)
            .into_iter()
            .map(|i| adapters[i].name.clone())
            .collect()
    }

    #[test]
    fn the_first_backend_of_the_policy_wins_over_a_better_gpu_on_a_later_one() {
        let policy = Policy {
            backends: vec![Backend::Vulkan, Backend::Gl],
            allow_software: false,
        };
        let all = [
            adapter(Backend::Gl, DeviceType::DiscreteGpu),
            adapter(Backend::Vulkan, DeviceType::IntegratedGpu),
        ];
        assert_eq!(
            picks(&policy, &all),
            ["Vulkan IntegratedGpu", "Gl DiscreteGpu"]
        );
    }

    #[test]
    fn opengl_es_serves_a_device_without_vulkan() {
        let policy = Policy::for_platform();
        if policy.backends != [Backend::Vulkan, Backend::Gl] {
            return;
        }
        let all = [adapter(Backend::Gl, DeviceType::IntegratedGpu)];
        assert_eq!(picks(&policy, &all), ["Gl IntegratedGpu"]);
    }

    #[test]
    fn within_a_backend_discrete_beats_integrated_beats_virtual() {
        let policy = Policy {
            backends: vec![Backend::Vulkan],
            allow_software: false,
        };
        let all = [
            adapter(Backend::Vulkan, DeviceType::VirtualGpu),
            adapter(Backend::Vulkan, DeviceType::IntegratedGpu),
            adapter(Backend::Vulkan, DeviceType::DiscreteGpu),
        ];
        assert_eq!(
            picks(&policy, &all),
            [
                "Vulkan DiscreteGpu",
                "Vulkan IntegratedGpu",
                "Vulkan VirtualGpu"
            ]
        );
    }

    #[test]
    fn software_adapters_are_refused_unless_allowed_and_then_come_last() {
        let strict = Policy::for_platform();
        // The platform's own first backend: Vulkan is not on the Apple policy, which lists Metal alone.
        let backend = strict.backends[0];
        let all = [
            adapter(backend, DeviceType::Cpu),
            adapter(backend, DeviceType::IntegratedGpu),
        ];
        let mut lenient = strict.clone();
        lenient.allow_software = true;
        let only_cpu = [adapter(backend, DeviceType::Cpu)];
        assert!(!ranked(&strict, &only_cpu).contains(&0));
        assert_eq!(ranked(&lenient, &only_cpu), [0]);
        assert_eq!(picks(&strict, &all), [format!("{backend:?} IntegratedGpu")]);
        assert_eq!(
            picks(&lenient, &all),
            [
                format!("{backend:?} IntegratedGpu"),
                format!("{backend:?} Cpu")
            ]
        );
    }

    #[test]
    fn a_backend_outside_the_policy_is_never_chosen() {
        let policy = Policy {
            backends: vec![Backend::Metal],
            allow_software: true,
        };
        let all = [
            adapter(Backend::Vulkan, DeviceType::DiscreteGpu),
            adapter(Backend::Gl, DeviceType::Cpu),
        ];
        assert!(ranked(&policy, &all).is_empty());
    }

    #[test]
    fn a_policy_without_backends_is_unsupported_not_a_panic() {
        let none = Policy {
            backends: Vec::new(),
            allow_software: true,
        };
        assert!(matches!(
            select(&none, None, (1, 1)),
            Err(RenderError::Unsupported(why)) if why.contains("no backend")
        ));
    }
}

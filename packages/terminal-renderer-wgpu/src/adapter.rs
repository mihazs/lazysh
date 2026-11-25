//! Which GPU the renderer runs on, and what happens when there is none.
//!
//! The choice is a pure function of what the platform reports ([`rank`]), so the fallbacks are
//! tested without every kind of hardware: backends are tried in the order of the [`Policy`] (the
//! first one that has a usable adapter wins), within a backend discrete before integrated before
//! virtual GPUs, and a CPU rasterizer only when the policy allows it. Production refuses software
//! adapters because the rollout rule is "a device keeps xterm.js unless the native renderer
//! beats it" and a software rasterizer cannot; CI and tests allow them to exercise the real path.

use lazysh_terminal_runtime::RenderError;
use std::ffi::c_void;
use std::ptr::NonNull;
use wgpu::rwh::{
    DisplayHandle, HandleError, HasDisplayHandle, RawDisplayHandle, RawWindowHandle,
    WaylandDisplayHandle, WaylandWindowHandle,
};
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
pub struct Window(WindowTarget);

#[derive(Debug, Clone, Copy)]
enum WindowTarget {
    Raw {
        display: RawDisplayHandle,
        window: RawWindowHandle,
    },
    #[cfg(target_vendor = "apple")]
    MetalLayer(NonNull<c_void>),
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
        Self(WindowTarget::Raw { display, window })
    }

    /// A `wl_surface` on the connection of `display` (a `wl_display`).
    ///
    /// # Safety
    ///
    /// The same as [`Window::new`]: both pointers are live Wayland objects of one connection.
    pub unsafe fn wayland(display: NonNull<c_void>, surface: NonNull<c_void>) -> Self {
        Self(WindowTarget::Raw {
            display: RawDisplayHandle::Wayland(WaylandDisplayHandle::new(display)),
            window: RawWindowHandle::Wayland(WaylandWindowHandle::new(surface)),
        })
    }

    /// A layer installed by the AppKit or UIKit host before the renderer thread starts.
    ///
    /// # Safety
    ///
    /// The pointer must identify a live CAMetalLayer and remain valid until the
    /// renderer is destroyed. The owning view is accessed only on the main thread.
    #[cfg(target_vendor = "apple")]
    pub unsafe fn metal_layer(layer: NonNull<c_void>) -> Self {
        Self(WindowTarget::MetalLayer(layer))
    }
}

impl HasDisplayHandle for Window {
    fn display_handle(&self) -> Result<DisplayHandle<'_>, HandleError> {
        match self.0 {
            // SAFETY: `Window::new`'s caller keeps the display alive.
            WindowTarget::Raw { display, .. } => Ok(unsafe { DisplayHandle::borrow_raw(display) }),
            #[cfg(target_vendor = "apple")]
            WindowTarget::MetalLayer(_) => Err(HandleError::Unavailable),
        }
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
    select_seen(policy, window, size).0
}

/// [`select`], and every adapter the policy's backends listed whether or not one was chosen: what a probe
/// reports when a device is refused.
pub(crate) fn select_seen(
    policy: &Policy,
    window: Option<Window>,
    size: (u32, u32),
) -> (Result<Selected, RenderError>, Vec<AdapterInfo>) {
    let backends = policy.mask();
    if backends.is_empty() {
        return (
            Err(RenderError::Unsupported("the policy allows no backend")),
            Vec::new(),
        );
    }
    let mut descriptor = wgpu::InstanceDescriptor {
        backends,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    };
    // A debug build asks Vulkan to name its objects (`InstanceFlags::DEBUG`, VK_EXT_debug_utils), and the Android emulator's
    // gfxstream driver (vulkan.ranchu) crashes the process in `vkSetDebugUtilsObjectNameEXT` (the first probe on the CI emulator,
    // SIGSEGV on the probe's thread). A release build never names objects, so this makes a debug build draw as a release one does.
    #[cfg(target_os = "android")]
    descriptor.flags.remove(wgpu::InstanceFlags::DEBUG);
    if let Some(window @ Window(WindowTarget::Raw { .. })) = window {
        // OpenGL ES picks its display when the instance is made.
        descriptor = descriptor.with_display_handle(Box::new(window));
    }
    let instance = wgpu::Instance::new(descriptor);
    let surface = window
        .map(|w| {
            let target = match w.0 {
                WindowTarget::Raw { display, window } => wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: Some(display),
                    raw_window_handle: window,
                },
                #[cfg(target_vendor = "apple")]
                WindowTarget::MetalLayer(layer) => {
                    wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer.as_ptr())
                }
            };
            // SAFETY: Each Window constructor requires its target to outlive this surface.
            unsafe { instance.create_surface_unsafe(target) }
        })
        .transpose();
    let surface = match surface {
        Ok(surface) => surface,
        Err(_) => {
            let why = RenderError::Unsupported("no backend of the policy can draw on the window");
            return (Err(why), Vec::new());
        }
    };
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
            let selected = Selected {
                info: infos[i].clone(),
                device,
                queue,
                screen: surface.zip(config),
            };
            return (Ok(selected), infos);
        }
    }
    let why = RenderError::Unsupported(refusal(policy, &infos));
    (Err(why), infos)
}

/// Why the policy ends up with no adapter. A machine whose only adapters are CPU rasterizers the
/// policy refuses is named apart: that is a device without a GPU, not a broken driver.
pub fn refusal(policy: &Policy, adapters: &[AdapterInfo]) -> &'static str {
    let software_only = ranked(policy, adapters).is_empty()
        && adapters.iter().any(|info| {
            info.device_type == DeviceType::Cpu && policy.backends.contains(&info.backend)
        });
    if software_only {
        "no hardware GPU, only a software rasterizer"
    } else {
        "no adapter the policy accepts could create a device"
    }
}

/// The check before a native terminal is offered (#1336): the adapter a renderer of this policy
/// would run on, with its device created and dropped again, or why there is none.
pub fn probe(policy: &Policy) -> Result<AdapterInfo, RenderError> {
    probe_seen(policy).0
}

/// [`probe`], and every adapter the policy's backends listed, chosen or not (a device with only a CPU
/// rasterizer lists it and is refused): the evidence of what a device offers.
pub fn probe_seen(policy: &Policy) -> (Result<AdapterInfo, RenderError>, Vec<AdapterInfo>) {
    let (selected, seen) = select_seen(policy, None, (1, 1));
    (selected.map(|selected| selected.info), seen)
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
    fn a_machine_with_only_a_refused_software_rasterizer_is_told_it_has_no_hardware_gpu() {
        let strict = Policy {
            backends: vec![Backend::Vulkan],
            allow_software: false,
        };
        let cpu = adapter(Backend::Vulkan, DeviceType::Cpu);
        let gpu = adapter(Backend::Vulkan, DeviceType::IntegratedGpu);
        assert!(refusal(&strict, std::slice::from_ref(&cpu)).contains("no hardware GPU"));
        // A GPU that failed to create a device, no adapter at all, a rasterizer of a backend the
        // policy does not list and an allowed rasterizer that failed are not "no hardware GPU".
        let other = [adapter(Backend::Gl, DeviceType::Cpu)];
        for (policy, adapters) in [
            (&strict, &[cpu.clone(), gpu][..]),
            (&strict, &[][..]),
            (&strict, &other[..]),
            (&strict.clone().with_software(), std::slice::from_ref(&cpu)),
        ] {
            assert!(refusal(policy, adapters).contains("could create a device"));
        }
    }

    /// On this machine's real adapters: the CI runner has only Mesa's CPU rasterizers, a desktop a GPU.
    #[test]
    fn the_probe_refuses_a_machine_without_a_hardware_gpu_and_names_the_adapter_of_one_with() {
        let strict = Policy::for_platform();
        match probe(&strict.clone().with_software()) {
            Ok(info) if info.device_type == DeviceType::Cpu => assert!(matches!(
                probe(&strict),
                Err(RenderError::Unsupported(why)) if why.contains("no hardware GPU")
            )),
            Ok(info) => assert_eq!(probe(&strict), Ok(info)),
            Err(_) => assert!(probe(&strict).is_err()),
        }
    }

    /// On this machine's real adapters, so it holds for a GPU and for a CI runner with only a rasterizer.
    #[test]
    fn the_probe_lists_every_adapter_of_the_policys_backends_chosen_or_not() {
        let strict = Policy::for_platform();
        let (chosen, seen) = probe_seen(&strict);
        assert_eq!(seen, probe_seen(&strict.clone().with_software()).1);
        assert_eq!(chosen, probe(&strict));
        if let Ok(info) = chosen {
            assert!(seen.contains(&info));
        }
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

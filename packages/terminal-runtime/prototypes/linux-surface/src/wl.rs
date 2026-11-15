use glib::translate::ToGlibPtr;
use std::os::fd::{AsFd, FromRawFd};
use wayland_backend::client::{Backend, ObjectId};
use wayland_client::{
    delegate_noop,
    globals::{registry_queue_init, GlobalListContents},
    protocol::{
        wl_buffer::WlBuffer,
        wl_compositor::WlCompositor,
        wl_region::WlRegion,
        wl_registry::WlRegistry,
        wl_shm::{Format, WlShm},
        wl_shm_pool::WlShmPool,
        wl_subcompositor::WlSubcompositor,
        wl_subsurface::WlSubsurface,
        wl_surface::WlSurface,
    },
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
};

extern "C" {
    fn gdk_wayland_window_get_wl_surface(w: *mut gdk::ffi::GdkWindow) -> *mut std::ffi::c_void;
    fn gdk_wayland_display_get_wl_display(d: *mut gdk::ffi::GdkDisplay) -> *mut std::ffi::c_void;
}

struct State;
impl Dispatch<WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &WlRegistry,
        _: wayland_client::protocol::wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
delegate_noop!(State: WlCompositor);
delegate_noop!(State: WlSubcompositor);
delegate_noop!(State: ignore WlShm);
delegate_noop!(State: WlShmPool);
delegate_noop!(State: WlRegion);
delegate_noop!(State: ignore WlSurface);
delegate_noop!(State: WlSubsurface);
delegate_noop!(State: ignore WlBuffer);

pub struct WlSurfaceChild {
    _conn: Connection,
    queue: EventQueue<State>,
    qh: QueueHandle<State>,
    shm: WlShm,
    surface: WlSurface,
    sub: WlSubsurface,
    color: u32,
    live: Vec<(WlBuffer, WlShmPool)>,
    parent: gdk::Window,
    /// Set by `POC_RENDER=vulkan`: a wgpu swapchain presents on the subsurface instead of `wl_shm` buffers.
    vulkan: Option<crate::gpu::VulkanTarget>,
}

impl WlSurfaceChild {
    pub fn new(gdk: &gdk::Window, color: u32, below: bool) -> Self {
        let display = gdk.display();
        let wl_display = unsafe { gdk_wayland_display_get_wl_display(display.to_glib_none().0) };
        let parent_ptr = unsafe { gdk_wayland_window_get_wl_surface(gdk.to_glib_none().0) };
        assert!(
            !parent_ptr.is_null() && !wl_display.is_null(),
            "no wayland handles"
        );
        let backend = unsafe { Backend::from_foreign_display(wl_display.cast()) };
        let conn = Connection::from_backend(backend);
        let parent = WlSurface::from_id(
            &conn,
            unsafe { ObjectId::from_ptr(WlSurface::interface(), parent_ptr.cast()) }.unwrap(),
        )
        .unwrap();
        let (globals, queue) = registry_queue_init::<State>(&conn).unwrap();
        let qh = queue.handle();
        let compositor: WlCompositor = globals.bind(&qh, 1..=6, ()).unwrap();
        let subcompositor: WlSubcompositor = globals.bind(&qh, 1..=1, ()).unwrap();
        let shm: WlShm = globals.bind(&qh, 1..=1, ()).unwrap();
        let surface = compositor.create_surface(&qh, ());
        let sub = subcompositor.get_subsurface(&surface, &parent, &qh, ());
        sub.set_desync();
        if below {
            sub.place_below(&parent);
        } else {
            sub.place_above(&parent);
        }
        // no input region: pointer and touch go to the web view, as a DOM-driven terminal needs
        surface.set_input_region(Some(&compositor.create_region(&qh, ())));
        let vulkan = (std::env::var("POC_RENDER").as_deref() == Ok("vulkan"))
            .then(|| crate::gpu::VulkanTarget::new(wl_display, surface.id().as_ptr().cast()));
        if let Some(v) = &vulkan {
            eprintln!("vulkan target on the subsurface: {}", v.adapter);
        }
        let mut me = Self {
            _conn: conn,
            queue,
            qh,
            shm,
            surface,
            sub,
            color,
            live: vec![],
            parent: gdk.clone(),
            vulkan,
        };
        me.flush();
        me
    }
    fn flush(&mut self) {
        let _ = self._conn.flush();
        let _ = self.queue.dispatch_pending(&mut State);
    }
}

impl super::Surface for WlSurfaceChild {
    fn place(&mut self, x: i32, y: i32, w: i32, h: i32) {
        // The anchor is in logical (CSS) pixels; the buffer is in device pixels and says by how much (an integer scale).
        let scale = self.parent.scale_factor().max(1);
        let (w, h) = (w.max(1), h.max(1));
        self.surface.set_buffer_scale(scale);
        if let Some(v) = self.vulkan.as_mut() {
            self.sub.set_position(x, y);
            v.present((w * scale) as u32, (h * scale) as u32, self.color);
            self.parent.invalidate_rect(None, true); // a subsurface position takes effect with the parent's next commit
            self.flush();
            return;
        }
        let (w, h) = (w * scale, h * scale);
        let size = (w * h * 4) as usize;
        let fd = unsafe { libc::memfd_create(c"surface-poc".as_ptr(), 0) };
        assert!(fd >= 0);
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        file.set_len(size as u64).unwrap();
        let map = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_SHARED,
                fd,
                0,
            )
        };
        let px = unsafe { std::slice::from_raw_parts_mut(map.cast::<u32>(), (w * h) as usize) };
        px.fill(self.color);
        unsafe { libc::munmap(map, size) };
        let pool = self
            .shm
            .create_pool(file.as_fd(), size as i32, &self.qh, ());
        let buf = pool.create_buffer(0, w, h, w * 4, Format::Argb8888, &self.qh, ());
        self.sub.set_position(x, y);
        self.surface.attach(Some(&buf), 0, 0);
        self.surface.damage_buffer(0, 0, w, h);
        self.surface.commit();
        self.parent.invalidate_rect(None, true);
        self.live.push((buf, pool));
        if self.live.len() > 4 {
            let (b, p) = self.live.remove(0);
            b.destroy();
            p.destroy();
        }
        self.flush();
    }
}
impl Drop for WlSurfaceChild {
    fn drop(&mut self) {
        self.sub.destroy();
        self.surface.destroy();
        self.flush();
    }
}

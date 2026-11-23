//! The JNI half of the Android native surface (#1327): `JniSurface.kt` hands each `Surface` of a session here, and the
//! renderer host draws the session's core on it with wgpu (Vulkan, then GLES, per the renderer's policy). Every
//! entry point answers false instead of failing: Kotlin then keeps painting the pane background, so a device with no
//! usable GPU, a session with no native core or a lost core shows the fallback and never a crash. Called on the UI
//! thread, in the order of `SurfaceLifecycle`: ready, any number of changed, lost.
use super::panes::{look, Panes};
use jni::objects::{JClass, JObject, JString};
use jni::sys::{jboolean, jfloat, jint, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;
use lazysh_terminal_renderer_wgpu::{Target, Window};
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::{Mutex, PoisonError};

#[link(name = "android")]
extern "C" {
    fn ANativeWindow_fromSurface(
        env: *mut jni::sys::JNIEnv,
        surface: jni::sys::jobject,
    ) -> *mut c_void;
    fn ANativeWindow_release(window: *mut c_void);
}

/// A reference to the surface's `ANativeWindow`, released when the renderer that drew on it is gone.
struct NativeWindow(NonNull<c_void>);

// SAFETY: an `ANativeWindow` reference may be released from any thread.
unsafe impl Send for NativeWindow {}

impl Drop for NativeWindow {
    fn drop(&mut self) {
        // SAFETY: the reference `ANativeWindow_fromSurface` acquired, released once.
        unsafe { ANativeWindow_release(self.0.as_ptr()) }
    }
}

static PANES: Mutex<Option<Panes>> = Mutex::new(None);

fn panes<R>(call: impl FnOnce(&mut Panes) -> R) -> R {
    let mut panes = PANES.lock().unwrap_or_else(PoisonError::into_inner);
    call(panes.get_or_insert_with(Panes::default))
}

fn text(env: &mut JNIEnv, id: &JString) -> Option<String> {
    env.get_string(id).ok().map(String::from)
}

/// Runs `call`, and answers false when it fails or panics: a panic must not unwind into the JVM.
fn answer(call: impl FnOnce() -> Result<(), String>) -> jboolean {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)) {
        Ok(Ok(())) => JNI_TRUE,
        _ => JNI_FALSE,
    }
}

#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_JniSurface_nativeReady(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
    surface: JObject,
    generation: jint,
    width: jint,
    height: jint,
    density: jfloat,
    background: jint,
) -> jboolean {
    let Some(id) = text(&mut env, &id) else {
        return JNI_FALSE;
    };
    // SAFETY: `env` and `surface` are live references of this call.
    let raw = unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) };
    let Some(raw) = NonNull::new(raw) else {
        return JNI_FALSE;
    };
    let holder = NativeWindow(raw);
    answer(|| {
        // SAFETY: the window is held by `holder` until the renderer on it is destroyed (`Panes::lost`, `ready`).
        let window = unsafe {
            Window::new(
                RawDisplayHandle::Android(AndroidDisplayHandle::new()),
                RawWindowHandle::AndroidNdk(AndroidNdkWindowHandle::new(raw)),
            )
        };
        let target = Target::on_window(window, width.max(1) as u32, height.max(1) as u32)
            .with_policy(crate::native_renderer::policy());
        panes(|panes| {
            panes.ready(
                &id,
                || crate::terminal_core::live(&id).ok()?.drawing(),
                target,
                Box::new(holder),
                generation.max(0) as u32,
                look(&id, density, background as u32 & 0xff_ffff),
            )
        })
    })
}

/// The session's preferences changed: the surface that draws it takes them (none is not an error).
pub(super) fn relook(id: &str) -> Result<(), String> {
    panes(|panes| panes.relook(id))
}

#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_JniSurface_nativeChanged(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
    width: jint,
    height: jint,
    density: jfloat,
    background: jint,
) -> jboolean {
    let Some(id) = text(&mut env, &id) else {
        return JNI_FALSE;
    };
    answer(|| {
        panes(|panes| {
            panes.changed(
                &id,
                width.max(1) as u32,
                height.max(1) as u32,
                look(&id, density, background as u32 & 0xff_ffff),
            )
        })
    })
}

#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_JniSurface_nativeLost(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
    generation: jint,
) {
    if let Some(id) = text(&mut env, &id) {
        let _ =
            std::panic::catch_unwind(|| panes(|panes| panes.lost(&id, generation.max(0) as u32)));
    }
}

#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_JniSurface_nativeRemove(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
) {
    if let Some(id) = text(&mut env, &id) {
        let _ = std::panic::catch_unwind(|| panes(|panes| panes.remove(&id)));
    }
}

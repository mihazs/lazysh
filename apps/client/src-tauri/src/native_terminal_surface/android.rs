//! The JNI half of the Android native surface (#1327): `JniSurface.kt` hands each `Surface` of a session here, and the
//! renderer host draws the session's core on it with wgpu (Vulkan, then GLES, per the renderer's policy). Every
//! entry point answers false instead of failing: Kotlin then keeps painting the pane background, so a device with no
//! usable GPU, a session with no native core or a lost core shows the fallback and never a crash. Called on the UI
//! thread, in the order of `SurfaceLifecycle`: ready, any number of changed, lost.
use super::panes::{look, Panes};
use jni::objects::{JClass, JObject, JString};
use jni::sys::{jboolean, jfloat, jint, jstring, JNI_FALSE, JNI_TRUE};
use jni::JNIEnv;
use lazysh_terminal_renderer_wgpu::{Target, Window};
use raw_window_handle::{
    AndroidDisplayHandle, AndroidNdkWindowHandle, RawDisplayHandle, RawWindowHandle,
};
use std::collections::HashMap;
use std::ffi::{c_char, c_int, c_void, CString};
use std::ptr::NonNull;
use std::sync::{Mutex, PoisonError};

#[link(name = "log")]
extern "C" {
    fn __android_log_write(priority: c_int, tag: *const c_char, text: *const c_char) -> c_int;
}

/// One stage of the renderer's way to a first frame, in logcat under the tag `lazysh-native` (`adb logcat -s lazysh-native`):
/// a pane that stays blank on a device says where it stopped.
fn trace(priority: c_int, message: &str) {
    if let Ok(text) = CString::new(message.replace('\0', " ")) {
        // SAFETY: both strings are NUL-terminated and live for the call.
        unsafe { __android_log_write(priority, c"lazysh-native".as_ptr(), text.as_ptr()) };
    }
}
const INFO: c_int = 4;
const ERROR: c_int = 6;

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

/// Why the renderer host last refused a session's surface, until it draws on one: what the page shows instead of a blank pane.
static REFUSALS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn refusals<R>(call: impl FnOnce(&mut HashMap<String, String>) -> R) -> R {
    let mut refusals = REFUSALS.lock().unwrap_or_else(PoisonError::into_inner);
    call(refusals.get_or_insert_with(HashMap::new))
}

fn panes<R>(call: impl FnOnce(&mut Panes) -> R) -> R {
    let mut panes = PANES.lock().unwrap_or_else(PoisonError::into_inner);
    call(panes.get_or_insert_with(Panes::default))
}

fn text(env: &mut JNIEnv, id: &JString) -> Option<String> {
    env.get_string(id).ok().map(String::from)
}

/// Runs `call` for `what` of session `id`, and answers false when it fails or panics: a panic must not unwind into the JVM.
/// A refusal is logged and kept, with its reason, for [`Java_app_lazysh_client_JniSurface_nativeReason`].
fn answer(id: &str, what: &str, call: impl FnOnce() -> Result<(), String>) -> jboolean {
    let failure = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(call)) {
        Ok(Ok(())) => {
            trace(INFO, &format!("{what} of {id}: the renderer draws"));
            refusals(|refusals| refusals.remove(id));
            return JNI_TRUE;
        }
        Ok(Err(why)) => why,
        Err(_) => "the renderer panicked".to_owned(),
    };
    trace(ERROR, &format!("{what} of {id}: refused: {failure}"));
    refusals(|refusals| refusals.insert(id.to_owned(), failure));
    JNI_FALSE
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
    trace(
        INFO,
        &format!(
            "ready of {id}: surface {width}x{height}, density {density}, generation {generation}"
        ),
    );
    // SAFETY: `env` and `surface` are live references of this call.
    let raw = unsafe { ANativeWindow_fromSurface(env.get_raw(), surface.as_raw()) };
    let Some(raw) = NonNull::new(raw) else {
        trace(
            ERROR,
            &format!("ready of {id}: the surface has no native window"),
        );
        refusals(|refusals| refusals.insert(id, "the surface has no native window".to_owned()));
        return JNI_FALSE;
    };
    let holder = NativeWindow(raw);
    answer(&id, "ready", || {
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
    answer(&id, "changed", || {
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

/// Why the renderer host refused the session's surface (the last time it was asked), or null when it draws or was never asked.
#[no_mangle]
pub extern "system" fn Java_app_lazysh_client_JniSurface_nativeReason(
    mut env: JNIEnv,
    _: JClass,
    id: JString,
) -> jstring {
    let reason = text(&mut env, &id).and_then(|id| refusals(|refusals| refusals.get(&id).cloned()));
    match reason.and_then(|reason| env.new_string(reason).ok()) {
        Some(reason) => reason.into_raw(),
        None => std::ptr::null_mut(),
    }
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
        refusals(|refusals| refusals.remove(&id));
        let _ = std::panic::catch_unwind(|| panes(|panes| panes.remove(&id)));
    }
}

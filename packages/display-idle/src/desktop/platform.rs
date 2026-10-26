#[cfg(target_os = "macos")]
mod native {
    use core_foundation_sys::{
        base::{kCFAllocatorDefault, CFRelease},
        string::{kCFStringEncodingUTF8, CFStringCreateWithCString, CFStringRef},
    };
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: CFStringRef,
            level: u32,
            name: CFStringRef,
            assertion: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(assertion: u32) -> i32;
    }
    pub struct Hold {
        assertion: Option<u32>,
    }
    pub fn description() -> &'static str {
        "Native display-idle assertion; manual sleep and system policies still apply."
    }
    pub fn supported() -> bool {
        true
    }
    impl Hold {
        pub(super) fn request() -> Result<Self, String> {
            let mut assertion = 0;
            unsafe {
                let reason = CFStringCreateWithCString(
                    kCFAllocatorDefault,
                    c"Supervising agents in lazysh".as_ptr(),
                    kCFStringEncodingUTF8,
                );
                if reason.is_null() {
                    return Err("Cannot create the display-idle reason.".into());
                }
                let kind = CFStringCreateWithCString(
                    kCFAllocatorDefault,
                    c"PreventUserIdleDisplaySleep".as_ptr(),
                    kCFStringEncodingUTF8,
                );
                if kind.is_null() {
                    CFRelease(reason.cast());
                    return Err("Cannot create the display-idle type.".into());
                }
                let result = IOPMAssertionCreateWithName(kind, 255, reason, &mut assertion);
                CFRelease(kind.cast());
                CFRelease(reason.cast());
                if result != 0 {
                    return Err("macOS refused the display-idle assertion.".into());
                }
            }
            Ok(Self {
                assertion: Some(assertion),
            })
        }
        pub fn release(&mut self) -> Result<(), String> {
            if let Some(id) = self.assertion {
                if unsafe { IOPMAssertionRelease(id) } != 0 {
                    return Err("macOS could not release the display-idle assertion.".into());
                }
                self.assertion = None;
            }
            Ok(())
        }
    }
}
#[cfg(target_os = "windows")]
mod native {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{
            Power::{
                PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerSetRequest,
            },
            Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
        },
    };
    pub struct Hold {
        handle: HANDLE,
        display_required: bool,
    }
    pub fn description() -> &'static str {
        "Native display power request; manual sleep and system policies still apply."
    }
    pub fn supported() -> bool {
        true
    }
    impl Hold {
        pub(super) fn request() -> Result<Self, String> {
            let mut reason: Vec<u16> = "Supervising agents in lazysh\0".encode_utf16().collect();
            let context = REASON_CONTEXT {
                Version: 0,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: reason.as_mut_ptr(),
                },
            };
            let handle = unsafe { PowerCreateRequest(&context) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err("Windows could not create a display power request.".into());
            }
            if unsafe { PowerSetRequest(handle, PowerRequestDisplayRequired) } == 0 {
                unsafe {
                    CloseHandle(handle);
                }
                return Err("Windows refused the display power request.".into());
            }
            Ok(Self {
                handle,
                display_required: true,
            })
        }
        pub fn release(&mut self) -> Result<(), String> {
            if !self.handle.is_null() {
                if self.display_required
                    && unsafe { PowerClearRequest(self.handle, PowerRequestDisplayRequired) } == 0
                {
                    return Err("Windows could not release the display power request.".into());
                }
                self.display_required = false;
                if unsafe { CloseHandle(self.handle) } == 0 {
                    return Err("Windows could not close the display power request.".into());
                }
                self.handle = std::ptr::null_mut();
            }
            Ok(())
        }
    }
}
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod native {
    pub struct Hold;
    pub fn description() -> &'static str {
        if cfg!(target_os = "linux") {
            "Native Linux keep-awake is unavailable until bounded asynchronous desktop-portal ownership is implemented."
        } else {
            "Native display-idle inhibition is unavailable on this platform."
        }
    }
    pub fn supported() -> bool {
        false
    }
    impl Hold {
        pub fn acquire<R: tauri::Runtime>(_: &tauri::WebviewWindow<R>) -> Result<Self, String> {
            Err(description().into())
        }
        pub fn release(&mut self) -> Result<(), String> {
            Ok(())
        }
    }
}
pub(super) use native::*;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl Hold {
    pub(super) fn acquire<R: tauri::Runtime>(_: &tauri::WebviewWindow<R>) -> Result<Self, String> {
        Self::request()
    }
}
impl Drop for Hold {
    fn drop(&mut self) {
        let _ = self.release();
    }
}
#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    #[test]
    fn native_display_request_acquires_and_releases() {
        let mut hold = super::Hold::request().unwrap();
        hold.release().unwrap();
        hold.release().unwrap();
    }
}

//! macOS: the window-server session dictionary of the session this process belongs to
//! (`CGSessionCopyCurrentDictionary`). A process outside any window-server session, such as one started
//! over SSH or by a daemon, has none, and reads as unknown.
use super::Desktop;

/// One value of the session dictionary.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Entry {
    Missing,
    Boolean(bool),
    /// Present, but not the boolean the key is documented to hold.
    Other,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Session {
    /// `kCGSSessionOnConsoleKey`: the session owns the physical display and keyboard.
    pub on_console: Entry,
    /// `kCGSSessionLoginDoneKey`: the user is past the login window.
    pub login_done: Entry,
    /// `CGSSessionScreenIsLocked`: set to true while the lock screen is up and absent otherwise.
    pub screen_locked: Entry,
}

/// Unlocked only for a console session past login whose lock key is absent or false. The lock key is not
/// public API, so a missing one is trusted only beside the two documented keys, and a value of the wrong
/// type is never read as "not locked".
pub(super) fn desktop(read: impl FnOnce() -> Option<Session>) -> Desktop {
    let Some(session) = read() else {
        return Desktop::Unknown;
    };
    match (
        session.screen_locked,
        session.on_console,
        session.login_done,
    ) {
        (Entry::Boolean(true), ..) => Desktop::Locked,
        (Entry::Missing | Entry::Boolean(false), Entry::Boolean(true), Entry::Boolean(true)) => {
            Desktop::Unlocked
        }
        _ => Desktop::Unknown,
    }
}

#[cfg(target_os = "macos")]
pub(super) fn system() -> Desktop {
    desktop(coregraphics::session)
}

#[cfg(target_os = "macos")]
mod coregraphics {
    use super::{Entry, Session};
    use std::ffi::{c_char, c_void, CStr};

    type CFTypeRef = *const c_void;
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFRelease(object: CFTypeRef);
        fn CFGetTypeID(object: CFTypeRef) -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(boolean: CFTypeRef) -> u8;
        fn CFDictionaryGetValue(dictionary: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        fn CFStringCreateWithCString(
            allocator: CFTypeRef,
            bytes: *const c_char,
            encoding: u32,
        ) -> CFTypeRef;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    }

    pub(super) fn session() -> Option<Session> {
        // SAFETY: the dictionary is owned (a Copy function) and released once, after every read of it.
        unsafe {
            let dictionary = CGSessionCopyCurrentDictionary();
            if dictionary.is_null() {
                return None;
            }
            let session = Session {
                on_console: entry(dictionary, c"kCGSSessionOnConsoleKey"),
                login_done: entry(dictionary, c"kCGSSessionLoginDoneKey"),
                screen_locked: entry(dictionary, c"CGSSessionScreenIsLocked"),
            };
            CFRelease(dictionary);
            Some(session)
        }
    }

    /// # Safety
    /// `dictionary` is a live `CFDictionaryRef`.
    unsafe fn entry(dictionary: CFTypeRef, key: &CStr) -> Entry {
        let key = CFStringCreateWithCString(std::ptr::null(), key.as_ptr(), UTF8);
        if key.is_null() {
            return Entry::Other;
        }
        // A Get function: the value belongs to the dictionary and is not released here.
        let value = CFDictionaryGetValue(dictionary, key);
        let entry = if value.is_null() {
            Entry::Missing
        } else if CFGetTypeID(value) == CFBooleanGetTypeID() {
            Entry::Boolean(CFBooleanGetValue(value) != 0)
        } else {
            Entry::Other
        };
        CFRelease(key);
        entry
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const YES: Entry = Entry::Boolean(true);
    const NO: Entry = Entry::Boolean(false);
    fn read(on_console: Entry, login_done: Entry, screen_locked: Entry) -> Desktop {
        desktop(|| {
            Some(Session {
                on_console,
                login_done,
                screen_locked,
            })
        })
    }

    #[test]
    fn only_a_console_session_past_login_without_the_lock_flag_is_unlocked() {
        assert_eq!(read(YES, YES, Entry::Missing), Desktop::Unlocked);
        assert_eq!(read(YES, YES, NO), Desktop::Unlocked);
        assert_eq!(read(YES, YES, YES), Desktop::Locked);
        // The lock flag wins even when the other keys are odd.
        assert_eq!(read(NO, Entry::Missing, YES), Desktop::Locked);
        // A background fast-user-switch session, the login window and a dictionary without the documented
        // keys show no desktop to this user.
        assert_eq!(read(NO, YES, Entry::Missing), Desktop::Unknown);
        assert_eq!(read(YES, NO, Entry::Missing), Desktop::Unknown);
        assert_eq!(
            read(Entry::Missing, Entry::Missing, Entry::Missing),
            Desktop::Unknown
        );
        // A lock flag that is not the boolean it should be is never taken for "not locked".
        assert_eq!(read(YES, YES, Entry::Other), Desktop::Unknown);
        assert_eq!(read(Entry::Other, YES, Entry::Missing), Desktop::Unknown);
    }

    #[test]
    fn no_window_server_session_is_unknown_and_the_reader_runs_once() {
        let mut reads = 0;
        assert_eq!(
            desktop(|| {
                reads += 1;
                None
            }),
            Desktop::Unknown
        );
        assert_eq!(reads, 1);
    }

    /// The real reader on a macOS runner answers without crashing, and a dictionary it reads holds booleans
    /// under the two documented keys: anything else would make every answer unknown.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_real_window_server_dictionary_is_read_without_error() {
        let session = coregraphics::session();
        eprintln!("window-server session: {session:?}");
        match session {
            None => assert_eq!(desktop(|| session), Desktop::Unknown),
            Some(session) => {
                assert_ne!(session.on_console, Entry::Other, "{session:?}");
                assert_ne!(session.login_done, Entry::Other, "{session:?}");
                assert_ne!(session.screen_locked, Entry::Other, "{session:?}");
            }
        }
        let _ = system();
    }
}

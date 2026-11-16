//! Windows: the lock flag of the session this process runs in (`WTSQuerySessionInformationW` with
//! `WTSSessionInfoEx`), counted only when that session is the physical console. A process in the services
//! session (started by OpenSSH or a service), a Remote Desktop session or a disconnected one shows no
//! desktop to the user, and reads as unknown.
use super::Desktop;

// `WTSActive`, `WTS_SESSIONSTATE_LOCK` and `WTS_SESSIONSTATE_UNLOCK`; the Windows reader asserts they match windows-sys.
const ACTIVE: i32 = 0;
const LOCK: u32 = 0;
const UNLOCK: u32 = 1;

#[derive(Clone, Copy, Debug)]
pub(super) struct Session {
    pub id: u32,
    /// `WTSGetActiveConsoleSessionId`: the session at the physical keyboard, or `u32::MAX` for none.
    pub console: u32,
    /// `WTS_CONNECTSTATE_CLASS`: `WTSActive` is connected and in use.
    pub state: i32,
    /// `SessionFlags`: lock, unlock or `WTS_SESSIONSTATE_UNKNOWN` (`u32::MAX`).
    pub flags: u32,
}

/// Locked or unlocked only for the active console session itself, and only when Windows says which.
pub(super) fn desktop(read: impl FnOnce() -> Option<Session>) -> Desktop {
    match read() {
        Some(session) if session.id == session.console && session.state == ACTIVE => {
            match session.flags {
                UNLOCK => Desktop::Unlocked,
                LOCK => Desktop::Locked,
                _ => Desktop::Unknown,
            }
        }
        _ => Desktop::Unknown,
    }
}

#[cfg(windows)]
pub(super) fn system() -> Desktop {
    desktop(wts::session)
}

#[cfg(windows)]
mod wts {
    use super::{Session, ACTIVE, LOCK, UNLOCK};
    use windows_sys::Win32::System::RemoteDesktop::{
        WTSActive, WTSFreeMemory, WTSGetActiveConsoleSessionId, WTSQuerySessionInformationW,
        WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE, WTS_CURRENT_SESSION,
        WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNLOCK,
    };

    const _: () = assert!(
        ACTIVE == WTSActive && LOCK == WTS_SESSIONSTATE_LOCK && UNLOCK == WTS_SESSIONSTATE_UNLOCK
    );

    pub(super) fn session() -> Option<Session> {
        let mut buffer = std::ptr::null_mut();
        let mut bytes = 0;
        // SAFETY: WTS owns and sizes the buffer it returns on success; it is read once as the `WTSINFOEXW` it
        // holds, only when it is that large, and freed once after.
        unsafe {
            if WTSQuerySessionInformationW(
                WTS_CURRENT_SERVER_HANDLE,
                WTS_CURRENT_SESSION,
                WTSSessionInfoEx,
                &mut buffer,
                &mut bytes,
            ) == 0
            {
                return None;
            }
            let session = (!buffer.is_null()
                && bytes as usize >= std::mem::size_of::<WTSINFOEXW>())
            .then(|| buffer.cast::<WTSINFOEXW>().read_unaligned())
            // Level 1 is the only layout `WTSSessionInfoEx` defines.
            .filter(|info| info.Level == 1)
            .map(|info| {
                let level = info.Data.WTSInfoExLevel1;
                Session {
                    id: level.SessionId,
                    console: WTSGetActiveConsoleSessionId(),
                    state: level.SessionState,
                    flags: level.SessionFlags as u32,
                }
            });
            WTSFreeMemory(buffer.cast());
            session
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NONE: u32 = u32::MAX;
    fn read(id: u32, console: u32, state: i32, flags: u32) -> Desktop {
        desktop(|| {
            Some(Session {
                id,
                console,
                state,
                flags,
            })
        })
    }

    #[test]
    fn the_console_session_lock_flag_decides_and_anything_else_is_unknown() {
        assert_eq!(read(1, 1, ACTIVE, UNLOCK), Desktop::Unlocked);
        assert_eq!(read(1, 1, ACTIVE, LOCK), Desktop::Locked);
        // Windows does not know (`WTS_SESSIONSTATE_UNKNOWN`) or reports a value this does not know.
        assert_eq!(read(1, 1, ACTIVE, NONE), Desktop::Unknown);
        assert_eq!(read(1, 1, ACTIVE, 2), Desktop::Unknown);
        // A hook run by OpenSSH or a service (session 0), by Remote Desktop, or after a fast user switch
        // belongs to a session that is not the one at the keyboard.
        assert_eq!(read(0, 1, ACTIVE, UNLOCK), Desktop::Unknown);
        assert_eq!(read(3, 1, ACTIVE, UNLOCK), Desktop::Unknown);
        assert_eq!(read(1, NONE, ACTIVE, UNLOCK), Desktop::Unknown);
        // The console session is disconnected (`WTSDisconnected` = 4) or idle: nobody sits at it.
        assert_eq!(read(1, 1, 4, UNLOCK), Desktop::Unknown);
        assert_eq!(read(1, 1, 5, UNLOCK), Desktop::Unknown);
    }

    #[test]
    fn a_failed_query_is_unknown_and_the_reader_runs_once() {
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

    /// The real reader on a Windows runner: it names the session this process runs in (Windows' own
    /// `ProcessIdToSessionId` is the oracle), and only the console session can be anything but unknown.
    #[cfg(windows)]
    #[test]
    fn the_real_session_query_names_this_process_session() {
        use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
        let mut mine = u32::MAX;
        // SAFETY: the out pointer is a live u32.
        assert_ne!(
            unsafe { ProcessIdToSessionId(std::process::id(), &mut mine) },
            0
        );
        let session = wts::session().expect("every process has a session to query");
        assert_eq!(session.id, mine, "{session:?}");
        if session.id != session.console || session.state != ACTIVE {
            assert_eq!(desktop(|| Some(session)), Desktop::Unknown, "{session:?}");
        }
        let _ = system();
    }
}

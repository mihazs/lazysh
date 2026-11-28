//! Shared by test targets that write a script and run it at once.
use std::time::{Duration, Instant};

/// Runs `launch` again while the kernel refuses to exec a file a sibling fork still holds open for
/// writing (ETXTBSY). A shell reports that as exit 126 and does not try the next `PATH` entry.
pub fn with_executable_retry<T>(
    mut launch: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    // A sibling fork can briefly hold an inherited write descriptor until exec; a loaded runner can
    // delay that exec, and the wait costs nothing when the file is not busy.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match launch() {
            Err(error)
                if error.kind() == std::io::ErrorKind::ExecutableFileBusy
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            result => return result,
        }
    }
}

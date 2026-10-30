use crate::{normalize, Response, OUTPUT_LIMIT};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};
const CLI_DEADLINE: Duration = Duration::from_secs(6);
const BUILTIN_DEADLINE: Duration = Duration::from_secs(18);
const COLLECTION_DEADLINE: Duration = Duration::from_secs(16);
const WORKER_FLAG: &str = "--account-usage-worker";
// Both executable paths and argument lists are selected by native code.
pub async fn read() -> Response {
    if let Some(path) = config_path().filter(|path| crate::collector::external_compatible(path)) {
        let mut command = Command::new("ai-usagebar");
        command.arg("--config").arg(path);
        if let Some(report) = external(command, CLI_DEADLINE).await {
            return report;
        }
    }
    let executable = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return builtin_unavailable(),
    };
    match bounded_output(Command::new(executable), &[WORKER_FLAG], BUILTIN_DEADLINE).await {
        Some(bytes) => crate::from_wire(&bytes),
        None => builtin_unavailable(),
    }
}
/// Called before either CLI parsing or desktop initialization, for the exact private mode only.
pub fn worker_main() -> Option<std::process::ExitCode> {
    let mut arguments = std::env::args_os();
    arguments.next();
    if arguments.next().as_deref() != Some(std::ffi::OsStr::new(WORKER_FLAG))
        || arguments.next().is_some()
    {
        return None;
    }
    let response = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => {
            let response = runtime.block_on(builtin());
            runtime.shutdown_background();
            response
        }
        Err(_) => builtin_unavailable(),
    };
    use std::io::Write;
    let success = serde_json::to_writer(std::io::stdout().lock(), &response).is_ok()
        && std::io::stdout().lock().write_all(b"\n").is_ok();
    Some(if success {
        std::process::ExitCode::SUCCESS
    } else {
        std::process::ExitCode::FAILURE
    })
}
async fn builtin() -> Response {
    let path = config_path();
    let config = match crate::collector::load_config(path.as_deref()) {
        Ok(config) => config,
        Err(_) => return builtin_unavailable(),
    };
    match crate::collector::collect_json(&config, COLLECTION_DEADLINE).await {
        Ok(json) => normalize(json.as_bytes(), "builtin"),
        Err(_) => builtin_unavailable(),
    }
}

fn builtin_unavailable() -> Response {
    let mut response = Response::unavailable("unavailable");
    response.source = Some("builtin".into());
    response
}
fn config_path() -> Option<PathBuf> {
    let own = directories::ProjectDirs::from("", "", "lazysh")?
        .config_dir()
        .join("account-usage.toml");
    if own.exists() {
        return Some(own);
    }
    ai_usagebar_core::resolved_config_path().filter(|path| path.exists())
}
struct ProcessTree {
    id: u32,
    #[cfg(windows)]
    job: isize,
}
impl ProcessTree {
    fn own(child: &tokio::process::Child) -> Option<Self> {
        let id = child.id()?;
        #[cfg(not(windows))]
        {
            Some(Self { id })
        }
        #[cfg(windows)]
        unsafe {
            use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                admission_failure("create_job");
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let configured = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) != 0;
            if !configured {
                admission_failure("configure_job");
            }
            let attached = configured
                && child
                    .raw_handle()
                    .is_some_and(|process| AssignProcessToJobObject(job, process.cast()) != 0);
            if configured && !attached {
                admission_failure("assign_job");
            }
            if !attached || !resume_suspended(id) {
                CloseHandle(job);
                return None;
            }
            Some(Self {
                id,
                job: job as isize,
            })
        }
    }
}
#[cfg(windows)]
fn admission_failure(stage: &'static str) {
    #[cfg(test)]
    eprintln!("owned quota admission stage={stage} error={}", unsafe {
        windows_sys::Win32::Foundation::GetLastError()
    });
    #[cfg(not(test))]
    let _ = stage;
}
// Follows the repository's Herdr suspended-start/job-admission pattern; resume only after ownership.
#[cfg(windows)]
fn resume_suspended(pid: u32) -> bool {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::*,
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            admission_failure("thread_snapshot");
            return false;
        }
        let admitted = (|| {
            let mut entry: THREADENTRY32 = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            if Thread32First(snapshot, &mut entry) == 0 {
                admission_failure("first_thread");
                return false;
            }
            loop {
                if entry.th32OwnerProcessID == pid {
                    let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if thread.is_null() {
                        admission_failure("open_thread");
                        return false;
                    }
                    let previous = ResumeThread(thread);
                    if previous != 1 {
                        admission_failure("resume_thread");
                        #[cfg(test)]
                        eprintln!("owned quota admission suspend_count={previous}");
                    }
                    CloseHandle(thread);
                    return previous == 1;
                }
                if Thread32Next(snapshot, &mut entry) == 0 {
                    admission_failure("next_thread");
                    return false;
                }
            }
        })();
        CloseHandle(snapshot);
        admitted
    }
}
impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(-(self.id as i32), libc::SIGKILL);
        }
        #[cfg(windows)]
        unsafe {
            let _ = self.id;
            windows_sys::Win32::Foundation::CloseHandle(
                self.job as windows_sys::Win32::Foundation::HANDLE,
            );
        }
    }
}

async fn external(command: Command, deadline: Duration) -> Option<Response> {
    let bytes = bounded_output(command, &["usage", "--json"], deadline).await?;
    let response = normalize(&bytes, "external_cli");
    (response.state == "ready").then_some(response)
}
async fn bounded_output(
    mut command: Command,
    arguments: &[&str],
    deadline: Duration,
) -> Option<Vec<u8>> {
    command
        .args(arguments)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(
            windows_sys::Win32::System::Threading::CREATE_NO_WINDOW
                | windows_sys::Win32::System::Threading::CREATE_SUSPENDED,
        );
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            #[cfg(all(windows, test))]
            eprintln!(
                "owned quota admission stage=spawn error={:?}",
                error.raw_os_error()
            );
            let _ = error;
            return None;
        }
    };
    let _tree = match ProcessTree::own(&child) {
        Some(tree) => tree,
        None => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return None;
        }
    };
    let stdout = child.stdout.take()?;
    let result = tokio::time::timeout(deadline, async {
        let mut bytes = Vec::new();
        stdout
            .take(OUTPUT_LIMIT as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        if bytes.len() > OUTPUT_LIMIT {
            return None;
        }
        let status = child.wait().await.ok()?;
        if !status.success() {
            #[cfg(all(windows, test))]
            eprintln!("owned quota fixture exit={}", status.code().unwrap_or(-1));
            return None;
        }
        Some(bytes)
    })
    .await;
    match result {
        Ok(Some(bytes)) => Some(bytes),
        _ => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            None
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(windows)]
    const WINDOWS_HELPER_ARGS: &[&str] = &[
        "--ignored",
        "--exact",
        "collect::tests::owned_windows_process_fixture",
        "--nocapture",
    ];
    #[cfg(windows)]
    #[test]
    #[ignore = "private child mode for the owned Windows process assertion"]
    fn owned_windows_process_fixture() {
        assert_eq!(
            std::env::args().skip(1).collect::<Vec<_>>(),
            WINDOWS_HELPER_ARGS
        );
        match std::env::var("OWNED_USAGE_MODE").as_deref() {
            Ok("parent") => {
                let mut child = std::process::Command::new(std::env::current_exe().unwrap())
                    .args(WINDOWS_HELPER_ARGS)
                    .env("OWNED_USAGE_MODE", "descendant")
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .expect("owned Rust descendant starts");
                std::fs::write(
                    std::env::var_os("OWNED_USAGE_PID").expect("owned PID destination"),
                    child.id().to_string(),
                )
                .expect("owned descendant PID publishes");
                let _ = child.wait();
            }
            Ok("descendant") => std::thread::sleep(Duration::from_secs(120)),
            _ => panic!("private owned fixture mode required"),
        }
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn suspended_job_admission_owns_descendants_before_the_collector_runs() {
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        let directory = tempfile::tempdir().unwrap();
        let pid_file = directory.path().join("child.pid");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(WINDOWS_HELPER_ARGS)
            .env("OWNED_USAGE_MODE", "parent")
            .env("OWNED_USAGE_PID", &pid_file);
        let query =
            tokio::spawn(
                async move { bounded_output(command, &[], Duration::from_secs(10)).await },
            );
        let stop = std::time::Instant::now() + Duration::from_secs(5);
        let pid = loop {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.parse::<u32>() {
                    break pid;
                }
            }
            if query.is_finished() {
                panic!(
                    "owned collector terminated before fixture admission: ready={}",
                    query.await.unwrap().is_some()
                );
            }
            if std::time::Instant::now() >= stop {
                query.abort();
                let _ = query.await;
                panic!("owned Rust fixture did not publish descendant within admission deadline");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        assert!(!process.is_null());
        query.abort();
        let _ = query.await;
        loop {
            let mut code = 259;
            let read = unsafe { GetExitCodeProcess(process, &mut code) };
            if read != 0 && code != 259 {
                break;
            }
            assert!(
                std::time::Instant::now() < stop,
                "owned descendant survived job close"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        unsafe {
            CloseHandle(process);
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_or_timing_out_a_read_kills_and_reaps_owned_processes() {
        for cancel in [true, false] {
            let directory = tempfile::tempdir().unwrap();
            let pid_file = directory.path().join("owned.pid");
            let mut command = Command::new("sh");
            command
                .args([
                    "-c",
                    "sleep 120 & printf '%s %s' \"$$\" \"$!\" > \"$OWNED_USAGE_PID\"; wait",
                ])
                .env("OWNED_USAGE_PID", &pid_file);
            let deadline = if cancel {
                Duration::from_secs(5)
            } else {
                Duration::from_millis(100)
            };
            let query = tokio::spawn(async move { external(command, deadline).await });
            let stop = std::time::Instant::now() + Duration::from_secs(2);
            let pids = loop {
                if let Ok(text) = std::fs::read_to_string(&pid_file) {
                    let parsed = text
                        .split_whitespace()
                        .filter_map(|s| s.parse::<i32>().ok())
                        .collect::<Vec<_>>();
                    if parsed.len() == 2 {
                        break parsed;
                    }
                }
                assert!(std::time::Instant::now() < stop);
                tokio::time::sleep(Duration::from_millis(10)).await;
            };
            if cancel {
                query.abort();
                let _ = query.await;
            } else {
                assert!(query.await.unwrap().is_none());
            }
            loop {
                if pids.iter().all(|pid| unsafe { libc::kill(*pid, 0) } == -1) {
                    break;
                }
                assert!(
                    std::time::Instant::now() < stop,
                    "owned process survived cancellation/timeout"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn external_adapter_is_bounded_and_passes_only_fixed_usage_arguments() {
        let mut valid = Command::new("sh");
        valid.args(["-c",r#"test "$0" = usage && test "$1" = --json && printf '%s' '{"schema_version":1,"entries":[]}'"#]);
        let result = external(valid, Duration::from_secs(1)).await.unwrap();
        assert_eq!(result.source.as_deref(), Some("external_cli"));
        let mut unsupported = Command::new("sh");
        unsupported.args(["-c", "printf '%s' '{}' "]);
        assert!(external(unsupported, Duration::from_secs(1))
            .await
            .is_none());
        let mut large = Command::new("sh");
        large.args(["-c", "head -c 1048577 /dev/zero"]);
        assert!(external(large, Duration::from_secs(1)).await.is_none());
        let mut slow = Command::new("sh");
        slow.args(["-c", "sleep 20"]);
        let start = std::time::Instant::now();
        assert!(external(slow, Duration::from_millis(30)).await.is_none());
        assert!(start.elapsed() < Duration::from_secs(1));
    }
}

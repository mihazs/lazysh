//! What each operating system's timer is told: fixed text around the absolute path of the running
//! executable and nothing else, so no setting or user text reaches a unit, a plist or a task. Plain text
//! that compiles everywhere, so every host can test every format.

use crate::timer_templates;

/// Written into every artifact; one without it is not ours and is never changed or removed.
pub const MARKER: &str = "lazysh-agent-managed: usage-collector";
/// The systemd unit base name and the Windows task name.
pub const NAME: &str = "lazysh-usage-collector";
pub const LAUNCHD_LABEL: &str = "app.lazysh.usage-collector";
/// The timer only wakes `usage-collector run`; the run enforces the interval the user chose.
pub const TICK_MINUTES: u32 = 5;

/// A path a unit file can carry without escaping: systemd treats `"`, `\` and `%` specially and the
/// templates refuse to guess, so such a path is rejected instead of rewritten.
pub fn systemd_path_ok(exe: &str) -> bool {
    exe.starts_with('/')
        && !exe
            .chars()
            .any(|c| c.is_control() || matches!(c, '"' | '\\' | '%'))
}

pub fn systemd_service(exe: &str) -> String {
    format!(
        "# {MARKER}\n\
         # Written by `lazysh-agent usage-collector enable`; `lazysh-agent usage-collector disable` removes it.\n\
         [Unit]\n\
         Description=lazysh usage collector run\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         ExecStart=\"{exe}\" usage-collector run\n\
         Nice=10\n\
         TimeoutStartSec=2min\n"
    )
}

/// Every five minutes on the wall clock, and once after a resume or a boot that missed one.
pub fn systemd_timer() -> String {
    format!(
        "# {MARKER}\n\
         # Written by `lazysh-agent usage-collector enable`; `lazysh-agent usage-collector disable` removes it.\n\
         [Unit]\n\
         Description=lazysh usage collector schedule\n\
         \n\
         [Timer]\n\
         OnCalendar=*:0/{TICK_MINUTES}\n\
         Persistent=true\n\
         Unit={NAME}.service\n\
         \n\
         [Install]\n\
         WantedBy=timers.target\n"
    )
}

pub fn launchd_plist(exe: &str) -> String {
    timer_templates::launchd_plist(
        exe,
        &timer_templates::Launchd {
            marker: MARKER,
            label: LAUNCHD_LABEL,
            arguments: &["usage-collector", "run"],
            run_at_load: false,
            seconds: TICK_MINUTES * 60,
        },
    )
}

pub fn task_xml(exe: &str) -> String {
    timer_templates::task_xml(
        exe,
        &timer_templates::Task {
            marker: MARKER,
            enable: "lazysh-agent usage-collector enable",
            disable: "lazysh-agent usage-collector disable",
            arguments: "usage-collector run",
            logon_trigger: false,
            minutes: TICK_MINUTES,
            limit_minutes: 2,
        },
    )
}

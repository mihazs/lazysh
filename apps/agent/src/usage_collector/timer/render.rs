//! What each operating system's timer is told: fixed text around the absolute path of the running
//! executable and nothing else, so no setting or user text reaches a unit, a plist or a task. Plain text
//! that compiles everywhere, so every host can test every format.

/// Written into every artifact; one without it is not ours and is never changed or removed.
pub const MARKER: &str = "lazysh-agent-managed: usage-collector";
/// The systemd unit base name and the Windows task name.
pub const NAME: &str = "lazysh-usage-collector";
pub const LAUNCHD_LABEL: &str = "app.lazysh.usage-collector";
/// The timer only wakes `usage-collector run`; the run enforces the interval the user chose.
pub const TICK_MINUTES: u32 = 5;

fn xml(text: &str) -> String {
    text.chars()
        .map(|character| match character {
            '&' => "&amp;".to_owned(),
            '<' => "&lt;".to_owned(),
            '>' => "&gt;".to_owned(),
            '"' => "&quot;".to_owned(),
            '\'' => "&apos;".to_owned(),
            other => other.to_string(),
        })
        .collect()
}

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
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- {MARKER} -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{LAUNCHD_LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{exe}</string>
		<string>usage-collector</string>
		<string>run</string>
	</array>
	<key>StartInterval</key>
	<integer>{seconds}</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>Nice</key>
	<integer>10</integer>
</dict>
</plist>
"#,
        exe = xml(exe),
        seconds = TICK_MINUTES * 60
    )
}

/// The current user's task, no elevation, one instance at a time, also on battery and after a missed start.
pub fn task_xml(exe: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{MARKER}. Written by lazysh-agent usage-collector enable; lazysh-agent usage-collector disable removes it.</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <Repetition>
        <Interval>PT{TICK_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>usage-collector run</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        exe = xml(exe)
    )
}

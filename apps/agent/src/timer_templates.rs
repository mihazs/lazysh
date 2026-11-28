//! The parts of the operating-system timer artifacts that `usage-collector` and `auto-update` share:
//! XML escaping and the launchd agent and Scheduled Task documents, which differ only in what they run
//! and how often. Plain text that compiles everywhere, so every host can test every format.

pub(crate) fn xml(text: &str) -> String {
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

pub(crate) struct Launchd<'a> {
    pub marker: &'a str,
    pub label: &'a str,
    pub arguments: &'a [&'a str],
    pub run_at_load: bool,
    pub seconds: u32,
}

/// A launchd agent that runs `exe` with `arguments` every `seconds`.
pub(crate) fn launchd_plist(exe: &str, agent: &Launchd) -> String {
    let arguments: String = std::iter::once(exe)
        .chain(agent.arguments.iter().copied())
        .map(|argument| format!("\t\t<string>{}</string>\n", xml(argument)))
        .collect();
    let run_at_load = if agent.run_at_load {
        "\t<key>RunAtLoad</key>\n\t<true/>\n"
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- {marker} -->
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
{arguments}	</array>
{run_at_load}	<key>StartInterval</key>
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
        marker = agent.marker,
        label = agent.label,
        seconds = agent.seconds,
    )
}

pub(crate) struct Task<'a> {
    pub marker: &'a str,
    /// What the user types to enable and to disable it, for the task's description.
    pub enable: &'a str,
    pub disable: &'a str,
    pub arguments: &'a str,
    pub logon_trigger: bool,
    pub minutes: u32,
    pub limit_minutes: u32,
}

/// The current user's task, no elevation, one instance at a time, also on battery and after a missed start.
pub(crate) fn task_xml(exe: &str, task: &Task) -> String {
    let logon = if task.logon_trigger {
        "    <LogonTrigger>\n      <Enabled>true</Enabled>\n    </LogonTrigger>\n"
    } else {
        ""
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{marker}. Written by {enable}; {disable} removes it.</Description>
  </RegistrationInfo>
  <Triggers>
{logon}    <TimeTrigger>
      <Repetition>
        <Interval>PT{minutes}M</Interval>
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
    <ExecutionTimeLimit>PT{limit}M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>{arguments}</Arguments>
    </Exec>
  </Actions>
</Task>
"#,
        marker = task.marker,
        enable = task.enable,
        disable = task.disable,
        minutes = task.minutes,
        limit = task.limit_minutes,
        exe = xml(exe),
        arguments = task.arguments,
    )
}

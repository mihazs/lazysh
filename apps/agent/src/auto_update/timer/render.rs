//! What each operating system's timer is told: fixed templates around the absolute path of the
//! managed companion and nothing else, so no user text and no setting reaches a unit, a plist or a
//! task. Rendering is plain text and compiles everywhere, so every host can test every format.
//!
//! Every artifact says it is ours in a way `disable` can check before it removes anything.
// The templates of the other platforms are built everywhere so that every host can test every format.
#![cfg_attr(not(test), allow(dead_code))]

/// Written into every artifact; a file without it is not ours and is never changed or removed.
pub const MARKER: &str = "lazysh-agent-managed: auto-update";
pub const SYSTEMD_SERVICE: &str = "lazysh-agent-update.service";
pub const SYSTEMD_TIMER: &str = "lazysh-agent-update.timer";
pub const LAUNCHD_LABEL: &str = "app.lazysh.agent-update";
#[cfg_attr(not(windows), allow(dead_code))]
pub const TASK_NAME: &str = "lazysh-agent-update";
/// The timer only wakes the companion; `auto-update run` enforces the configured interval itself.
pub const WAKE_MINUTES: u32 = 60;

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

/// `systemd --user`: runs `exe auto-update run` once, hourly, with a little spread so that a fleet of
/// hosts does not ask GitHub in the same second, and catches up after the host was off.
pub fn systemd_service(exe: &str) -> String {
    // A `%` starts a specifier in a unit, so it is doubled to stay literal. A `$` needs nothing:
    // systemd does not substitute variables in the program path (checked by `systemd-analyze`).
    let exe = exe.replace('%', "%%");
    format!(
        "# {MARKER}\n\
         # Written by `lazysh-agent auto-update enable`; `lazysh-agent auto-update disable` removes it.\n\
         [Unit]\n\
         Description=lazysh companion update check\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         ExecStart=\"{exe}\" auto-update run\n\
         Nice=10\n\
         TimeoutStartSec=15min\n"
    )
}
pub fn systemd_timer() -> String {
    format!(
        "# {MARKER}\n\
         # Written by `lazysh-agent auto-update enable`; `lazysh-agent auto-update disable` removes it.\n\
         [Unit]\n\
         Description=lazysh companion update check schedule\n\
         \n\
         [Timer]\n\
         OnCalendar=hourly\n\
         RandomizedDelaySec=5min\n\
         Persistent=true\n\
         Unit={SYSTEMD_SERVICE}\n\
         \n\
         [Install]\n\
         WantedBy=timers.target\n"
    )
}

/// launchd agent of the user's login session: at load, then every hour.
pub fn launchd_plist(exe: &str) -> String {
    let exe = xml(exe);
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
		<string>auto-update</string>
		<string>run</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
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
        seconds = WAKE_MINUTES * 60
    )
}

/// Task Scheduler: for the user who enabled it, without elevation, at logon and then every hour, one
/// instance at a time, whether or not on battery.
pub fn task_xml(exe: &str) -> String {
    let exe = xml(exe);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>{MARKER}. Written by lazysh-agent auto-update enable; lazysh-agent auto-update disable removes it.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT{WAKE_MINUTES}M</Interval>
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
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{exe}</Command>
      <Arguments>auto-update run</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

/// Can `exe` be written into this platform's artifact as it is. Never a control character; on Linux
/// also none of the characters systemd refuses in a program path (a quote, a backslash). A path the
/// app or the installer creates never has one; anything else is refused rather than escaped.
pub fn path_is_representable(exe: &str, systemd: bool) -> bool {
    !exe.chars().any(|character| {
        character.is_control() || (systemd && matches!(character, '"' | '\'' | '\\'))
    })
}

/// What `schtasks /XML` reads: UTF-16 little endian with a byte order mark.
pub fn utf16le_with_bom(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    for unit in text.encode_utf16() {
        bytes.extend(unit.to_le_bytes());
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::Path, process::Command};

    /// Run a validator of the system; `None` (and a note) when this host does not have it.
    fn validator(program: &str, args: &[&str]) -> Option<(bool, String)> {
        match Command::new(program).args(args).output() {
            Ok(output) => Some((
                output.status.success(),
                format!(
                    "{}{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ),
            )),
            Err(_) => {
                eprintln!("skipped: {program} is not installed on this host");
                None
            }
        }
    }
    /// Paths no sensible install has, to show that nothing in them is read as markup or as a specifier.
    const AWKWARD: &str = "lazysh d&r <x> 'q' \"p\" %x $HOME";
    const AWKWARD_FOR_SYSTEMD: &str = "lazysh d&r <x> %x $HOME";
    /// `xmllint --xpath string(...)` of the document: what a parser reads out of it.
    fn xpath(file: &Path, expression: &str) -> Option<String> {
        let (ok, text) = validator(
            "xmllint",
            &["--noout", "--xpath", expression, file.to_str().unwrap()],
        )?;
        assert!(ok, "{text}");
        Some(text.trim_end_matches('\n').to_owned())
    }

    #[test]
    fn the_systemd_units_are_accepted_by_systemd_for_a_path_with_specifier_characters() {
        let home = tempfile::tempdir().unwrap();
        let program = home.path().join(AWKWARD_FOR_SYSTEMD).join("lazysh-agent");
        fs::create_dir_all(program.parent().unwrap()).unwrap();
        fs::copy(std::env::current_exe().unwrap(), &program).unwrap();
        let service = home.path().join(SYSTEMD_SERVICE);
        let timer = home.path().join(SYSTEMD_TIMER);
        fs::write(&service, systemd_service(program.to_str().unwrap())).unwrap();
        fs::write(&timer, systemd_timer()).unwrap();
        let Some((ok, text)) = validator(
            "systemd-analyze",
            &[
                "--user",
                "verify",
                service.to_str().unwrap(),
                timer.to_str().unwrap(),
            ],
        ) else {
            return;
        };
        // `%x` read as a specifier or `$HOME` expanded would make systemd look for another file.
        assert!(ok, "{text}");
        // And the timer is the schedule the docs promise: hourly, with a catch-up after downtime.
        let (_, calendar) = validator("systemd-analyze", &["calendar", "hourly"]).unwrap();
        assert!(calendar.contains("*-*-* *:00:00"), "{calendar}");
    }

    #[test]
    fn only_paths_the_target_can_carry_are_accepted() {
        assert!(path_is_representable("/home/a b/%x$y/lazysh-agent", true));
        for bad in ["/a\"b", "/a'b", "/a\\b", "/a\nb", "/a\u{7f}b"] {
            assert!(!path_is_representable(bad, true), "{bad:?}");
        }
        assert!(path_is_representable("C:\\Users\\O'Brien\\x", false));
        assert!(!path_is_representable("/a\nb", false));
    }

    #[test]
    fn the_launchd_plist_is_a_valid_property_list_that_runs_the_path_it_was_given() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("agent.plist");
        fs::write(
            &file,
            launchd_plist(&format!("/Users/{AWKWARD}/lazysh-agent")),
        )
        .unwrap();
        // Apple's own linter where there is one (macOS), a parser everywhere else.
        if let Some((ok, text)) = validator("plutil", &["-lint", file.to_str().unwrap()]) {
            assert!(ok, "{text}");
        }
        let Some(program) = xpath(&file, "string(/plist/dict/array/string[1])") else {
            return;
        };
        assert_eq!(program, format!("/Users/{AWKWARD}/lazysh-agent"));
        let arguments = xpath(&file, "string(/plist/dict/array/string[2])").unwrap();
        let last = xpath(&file, "string(/plist/dict/array/string[3])").unwrap();
        assert_eq!((arguments.as_str(), last.as_str()), ("auto-update", "run"));
        assert_eq!(
            xpath(
                &file,
                "string(/plist/dict/key[1]/following-sibling::string[1])"
            )
            .unwrap(),
            LAUNCHD_LABEL
        );
        assert_eq!(
            xpath(
                &file,
                "string(/plist/dict/key[.='StartInterval']/following-sibling::integer[1])"
            )
            .unwrap(),
            "3600"
        );
    }

    #[test]
    fn the_task_definition_is_utf16_xml_that_runs_the_path_it_was_given_without_elevation() {
        let home = tempfile::tempdir().unwrap();
        let file = home.path().join("task.xml");
        let program = format!("C:\\Users\\{AWKWARD}\\lazysh-agent.exe");
        fs::write(&file, utf16le_with_bom(&task_xml(&program))).unwrap();
        let Some(command) = xpath(
            &file,
            "string(//*[local-name()='Exec']/*[local-name()='Command'])",
        ) else {
            return;
        };
        assert_eq!(command, program);
        let arguments = xpath(&file, "string(//*[local-name()='Arguments'])").unwrap();
        assert_eq!(arguments, "auto-update run");
        // Least privilege, one instance, and a repeat that never stops by itself.
        let level = xpath(&file, "string(//*[local-name()='RunLevel'])").unwrap();
        assert_eq!(level, "LeastPrivilege");
        let policy = xpath(&file, "string(//*[local-name()='MultipleInstancesPolicy'])").unwrap();
        assert_eq!(policy, "IgnoreNew");
        let interval = xpath(
            &file,
            "string(//*[local-name()='Repetition']/*[local-name()='Interval'])",
        )
        .unwrap();
        assert_eq!(interval, "PT60M");
        // Our marker is how `disable` knows the task is ours.
        let description = xpath(&file, "string(//*[local-name()='Description'])").unwrap();
        assert!(description.contains(MARKER), "{description}");
    }
}

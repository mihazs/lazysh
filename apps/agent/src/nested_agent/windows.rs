//! Windows process ancestry from a Toolhelp snapshot. It holds parent ids and image names, never a
//! command line, so an agent is recognized only when its executable carries its name (`claude.exe`): a
//! `.cmd` shim or an interpreter running a script (`node.exe cli.js`) shows only the interpreter.
//! shortcut: a parent id outlives its process, so an exited parent whose id was reused by another agent's
//! executable would count as nested; confirm with the process creation times if that is ever reported.
use super::{names, Process, Table};
use std::collections::HashMap;

pub(super) struct Processes(HashMap<u32, Process>);

impl Processes {
    /// `(process id, parent id, image name)` per process.
    pub(super) fn from_entries(entries: impl IntoIterator<Item = (u32, u32, String)>) -> Self {
        Self(
            entries
                .into_iter()
                .map(|(pid, parent, image)| {
                    (
                        pid,
                        Process {
                            parent,
                            names: names(&image, &[]),
                        },
                    )
                })
                .collect(),
        )
    }
}

impl Table for Processes {
    fn process(&self, pid: u32) -> Option<Process> {
        self.0.get(&pid).cloned()
    }
}

/// A NUL-terminated UTF-16 image name, the way `szExeFile` holds it.
fn image(units: &[u16]) -> String {
    let end = units
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

#[cfg(windows)]
impl Processes {
    /// Every process of the machine at this moment; `None` when Windows refuses the snapshot.
    pub(super) fn snapshot() -> Option<Self> {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
            System::Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
        };
        // SAFETY: the snapshot handle is checked and closed once; `entry` is a zeroed, correctly sized
        // `PROCESSENTRY32W` that the two Process32 calls fill before it is read.
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            let mut entries = Vec::new();
            let mut more = Process32FirstW(snapshot, &mut entry) != 0;
            while more {
                entries.push((
                    entry.th32ProcessID,
                    entry.th32ParentProcessID,
                    image(&entry.szExeFile),
                ));
                more = Process32NextW(snapshot, &mut entry) != 0;
            }
            CloseHandle(snapshot);
            Some(Self::from_entries(entries))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{nested_agent::in_process_tree, Agent};

    fn utf16(name: &str) -> Vec<u16> {
        name.encode_utf16().collect()
    }

    #[test]
    fn image_names_are_cut_at_the_terminator_and_matched_without_case_or_extension() {
        let mut field = [0u16; 260];
        field[..10].copy_from_slice(&utf16("Claude.EXE"));
        field[11] = u16::from(b'x'); // after the terminator: ignored
        assert_eq!(image(&field), "Claude.EXE");
        assert_eq!(image(&utf16("codex.exe")), "codex.exe");
        assert_eq!(image(&[]), "");
        assert!(names("Claude.EXE", &[]).contains(&"claude".to_owned()));
    }

    #[test]
    fn a_windows_process_chain_names_the_agent_that_started_the_reporting_one() {
        // lazysh-agent.exe <- cmd.exe <- codex.exe <- powershell.exe <- claude.exe <- explorer.exe
        let table = Processes::from_entries([
            (100, 90, "lazysh-agent.exe".to_owned()),
            (90, 80, "cmd.exe".to_owned()),
            (80, 70, "codex.exe".to_owned()),
            (70, 60, "powershell.exe".to_owned()),
            (60, 50, "Claude.exe".to_owned()),
            (50, 4, "explorer.exe".to_owned()),
        ]);
        assert!(in_process_tree(Agent::Codex, &table, 100));
        // Without the outer agent the same chain is the user's own session.
        let alone = Processes::from_entries([
            (100, 90, "lazysh-agent.exe".to_owned()),
            (90, 80, "cmd.exe".to_owned()),
            (80, 70, "codex.exe".to_owned()),
            (70, 4, "explorer.exe".to_owned()),
        ]);
        assert!(!in_process_tree(Agent::Codex, &alone, 100));
        // An agent running as an interpreter shows no name from an image alone, so it is not claimed.
        let interpreted = Processes::from_entries([
            (100, 90, "lazysh-agent.exe".to_owned()),
            (90, 80, "node.exe".to_owned()),
            (80, 70, "node.exe".to_owned()),
            (70, 4, "explorer.exe".to_owned()),
        ]);
        assert!(!in_process_tree(Agent::Gemini, &interpreted, 100));
    }

    /// The real snapshot on a Windows runner reports a child this process started, under its image name.
    #[cfg(windows)]
    #[test]
    fn the_real_snapshot_reports_a_child_of_this_process_by_parent_id_and_image_name() {
        let mut child = std::process::Command::new("cmd")
            .args(["/c", "ping -n 6 127.0.0.1 > nul"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .spawn()
            .expect("cmd.exe starts");
        let table = Processes::snapshot();
        let found = table.as_ref().and_then(|table| table.process(child.id()));
        let _ = child.kill();
        let _ = child.wait();
        let found = found.expect("the snapshot lists the running child");
        assert_eq!(found.parent, std::process::id());
        assert!(found.names.contains(&"cmd".to_owned()), "{:?}", found.names);
        assert!(table.unwrap().process(std::process::id()).is_some());
    }
}

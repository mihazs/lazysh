//! Read-only inventory of recognizable agent processes owned by this user.

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgent {
    pub agent: String,
    pub pid: u32,
    pub start_time: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveAgents {
    pub status: String,
    pub processes: Vec<LiveAgent>,
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{LiveAgent, LiveAgents};
    use std::{fs, io::Read, os::unix::fs::MetadataExt, path::Path};

    // Exact executable names only. Arguments and environment are never returned.
    const PROVIDERS: &[(&str, &str)] = &[
        ("claude", "Claude Code"),
        ("codex", "Codex"),
        ("gemini", "Gemini CLI"),
        ("copilot", "GitHub Copilot CLI"),
        ("opencode", "OpenCode"),
        ("qwen", "Qwen Code"),
        ("grok", "Grok Build"),
        ("agy", "Antigravity CLI"),
        ("senpi", "Senpi"),
        ("crush", "Crush"),
        ("hermes", "Hermes Agent"),
        ("omp", "Oh My Pi"),
        ("pi", "Pi"),
    ];

    fn identity(path: &Path) -> Option<(char, u64)> {
        let stat = fs::read_to_string(path.join("stat")).ok()?;
        let mut fields = stat.rsplit_once(") ")?.1.split_whitespace();
        let state = fields.next()?.chars().next()?;
        let start = fields.nth(18)?.parse().ok()?;
        Some((state, start))
    }

    fn provider(command: &[u8]) -> Option<&'static str> {
        let mut args = command.split(|byte| *byte == 0);
        let executable = std::str::from_utf8(args.next()?).ok()?;
        let basename = Path::new(executable).file_name()?.to_str()?;
        let name = if matches!(basename, "node" | "nodejs" | "bun") {
            let script = std::str::from_utf8(args.next()?).ok()?;
            for (path, agent) in [
                ("/@google/gemini-cli/dist/index.js", "Gemini CLI"),
                ("/@qwen-code/qwen-code/dist/index.js", "Qwen Code"),
                ("/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "Pi"),
                ("/@mariozechner/pi-coding-agent/dist/cli.js", "Pi"),
                ("/@code-yeongyu/senpi/dist/bundle/cli.js", "Senpi"),
                ("/@oh-my-pi/pi-coding-agent/src/cli.ts", "Oh My Pi"),
            ] {
                if script.ends_with(path) {
                    return Some(agent);
                }
            }
            Path::new(script).file_name()?.to_str()?
        } else {
            basename
        };
        PROVIDERS
            .iter()
            .find_map(|(binary, label)| (*binary == name).then_some(*label))
    }

    pub fn scan(root: &Path, uid: u32) -> LiveAgents {
        let Ok(entries) = fs::read_dir(root) else {
            return LiveAgents {
                status: "unavailable".into(),
                processes: Vec::new(),
            };
        };
        let mut processes = Vec::new();
        let mut scanned = 0;
        let mut truncated = false;
        for entry in entries.flatten() {
            scanned += 1;
            if scanned > 100_000 {
                truncated = true;
                break;
            }
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            let path = entry.path();
            if entry
                .metadata()
                .ok()
                .is_none_or(|metadata| metadata.uid() != uid)
            {
                continue;
            }
            let Some((state, start_time)) = identity(&path) else {
                continue;
            };
            if matches!(state, 'Z' | 'X') {
                continue;
            }
            let mut command = Vec::new();
            let Ok(file) = fs::File::open(path.join("cmdline")) else {
                continue;
            };
            if file.take(16_385).read_to_end(&mut command).is_err() || command.len() > 16_384 {
                continue;
            }
            let Some(agent) = provider(&command) else {
                continue;
            };
            if !identity(&path)
                .is_some_and(|(state, start)| !matches!(state, 'Z' | 'X') && start == start_time)
            {
                continue;
            }
            if processes.len() == 100 {
                truncated = true;
                break;
            }
            processes.push(LiveAgent {
                agent: agent.into(),
                pid,
                start_time,
            });
        }
        processes.sort_by_key(|process| process.pid);
        let status = if truncated { "truncated" } else { "available" };
        LiveAgents {
            status: status.into(),
            processes,
        }
    }
}

pub fn discover() -> LiveAgents {
    #[cfg(target_os = "linux")]
    {
        linux::scan(std::path::Path::new("/proc"), unsafe { libc::geteuid() })
    }
    #[cfg(not(target_os = "linux"))]
    {
        LiveAgents {
            status: "unsupported".into(),
            processes: Vec::new(),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux::scan;
    use std::{fs, os::unix::fs::MetadataExt};

    #[test]
    fn an_owned_agent_process_appears_and_disappears() {
        use std::{os::unix::fs::symlink, process::Command};
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("codex");
        symlink("/bin/sleep", &binary).unwrap();
        let mut child = Command::new(binary).arg("60").spawn().unwrap();
        let pid = child.id();
        let uid = unsafe { libc::geteuid() };
        let seen = scan(std::path::Path::new("/proc"), uid);
        assert!(seen
            .processes
            .iter()
            .any(|process| process.pid == pid && process.agent == "Codex"));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!scan(std::path::Path::new("/proc"), uid)
            .processes
            .iter()
            .any(|process| process.pid == pid));
    }

    #[test]
    fn only_live_exact_process_names_are_reported_without_arguments() {
        let root = tempfile::tempdir().unwrap();
        for (pid, command, state) in [
            (101, b"/bin/codex\0secret-token\0".as_slice(), 'S'),
            (102, b"node\0/usr/bin/gemini\0secret\0", 'S'),
            (103, b"/bin/codex-helper\0", 'S'),
            (104, b"/bin/claude\0", 'Z'),
            (
                105,
                b"node\0/opt/node_modules/@code-yeongyu/senpi/dist/bundle/cli.js\0",
                'S',
            ),
            (
                106,
                b"bun\0/opt/node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts\0",
                'S',
            ),
            (107, b"/usr/bin/agy\0", 'S'),
        ] {
            let path = root.path().join(pid.to_string());
            fs::create_dir(&path).unwrap();
            fs::write(path.join("cmdline"), command).unwrap();
            fs::write(
                path.join("stat"),
                format!("{pid} (a name) {state} {} 987", vec!["0"; 18].join(" ")),
            )
            .unwrap();
        }
        let uid = fs::metadata(root.path()).unwrap().uid();
        let result = scan(root.path(), uid);
        assert_eq!(result.status, "available");
        assert_eq!(
            result
                .processes
                .iter()
                .map(|p| (p.pid, p.agent.as_str(), p.start_time))
                .collect::<Vec<_>>(),
            vec![
                (101, "Codex", 987),
                (102, "Gemini CLI", 987),
                (105, "Senpi", 987),
                (106, "Oh My Pi", 987),
                (107, "Antigravity CLI", 987)
            ]
        );
        assert!(!serde_json::to_string(&result).unwrap().contains("secret"));
        assert!(scan(root.path(), uid.wrapping_add(1)).processes.is_empty());
    }
}

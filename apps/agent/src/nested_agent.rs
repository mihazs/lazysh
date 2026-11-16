//! Whether another supported agent started the agent that is reporting. Detection only ever claims
//! a nesting it saw: an agent whose process is not recognized, and any host where the process table
//! cannot be read, count as not nested.
use crate::Agent;
use std::collections::HashSet;

/// A launcher that starts an agent on purpose sets this to its own session id, on any platform.
pub const PARENT_SESSION_VARIABLE: &str = "LAZYSH_PARENT_SESSION_ID";
const MAX_DEPTH: usize = 64;
const AGENTS: [(&str, Agent); 10] = [
    ("claude", Agent::Claude),
    ("codex", Agent::Codex),
    ("opencode", Agent::Opencode),
    ("gemini", Agent::Gemini),
    ("droid", Agent::Droid),
    ("kimi", Agent::Kimi),
    ("copilot", Agent::Copilot),
    ("cursor-agent", Agent::Cursor),
    ("amp", Agent::Amp),
    ("cline", Agent::Cline),
];
/// A program that names an agent only through its first argument: `node /…/opencode.js`, `bash claude`.
const LAUNCHERS: [&str; 8] = [
    "node", "nodejs", "bun", "deno", "python", "python3", "sh", "bash",
];

#[derive(Clone)]
pub(crate) struct Process {
    pub parent: u32,
    /// Normalized names this process answers to: its command name and the program or script it runs.
    pub names: Vec<String>,
}
pub(crate) trait Table {
    fn process(&self, pid: u32) -> Option<Process>;
}

fn normalize(name: &str) -> String {
    let base = name
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .trim_start_matches('-')
        .to_ascii_lowercase();
    for extension in [".js", ".mjs", ".cjs", ".py", ".sh", ".exe"] {
        if let Some(stem) = base.strip_suffix(extension) {
            return stem.to_owned();
        }
    }
    base
}
pub(crate) fn names(command: &str, argv: &[&str]) -> Vec<String> {
    let mut names = vec![normalize(command)];
    if let Some(program) = argv.first().map(|program| normalize(program)) {
        if LAUNCHERS.contains(&program.as_str()) {
            // `sh -c 'script text'` starts with an option, so a command line is never taken for a name.
            names.extend(
                argv.get(1)
                    .filter(|a| !a.starts_with('-'))
                    .map(|a| normalize(a)),
            );
        }
        names.push(program);
    }
    names
}
fn agent_of(process: &Process) -> Option<Agent> {
    AGENTS
        .iter()
        .find(|(name, _)| process.names.iter().any(|candidate| candidate == name))
        .map(|(_, agent)| *agent)
}

/// The agents above `start`, nearest first. Processes of one agent that follow each other directly
/// are one run: that is a launcher script and the program it starts, not a second agent.
fn runs(table: &dyn Table, start: u32) -> Vec<Agent> {
    let mut runs = Vec::new();
    let mut previous = None;
    let mut seen = HashSet::from([start]);
    let mut pid = table.process(start).map_or(0, |process| process.parent);
    for _ in 0..MAX_DEPTH {
        if pid <= 1 || !seen.insert(pid) {
            break;
        }
        let Some(process) = table.process(pid) else {
            break;
        };
        let agent = agent_of(&process);
        if let Some(agent) = agent.filter(|agent| previous != Some(*agent)) {
            runs.push(agent);
        }
        previous = agent;
        pid = process.parent;
    }
    runs
}

/// `owner` reports from `start`. Its own run is nearest; any run beyond it, or a nearest run that is
/// not the owner's, is an agent that started it. A generic reporter has no process to recognize, so
/// its nearest run is taken as its own.
pub(crate) fn in_process_tree(owner: Agent, table: &dyn Table, start: u32) -> bool {
    // Kimi Code reports as its own agent but runs as the `kimi` process.
    let owner = if owner == Agent::KimiCode {
        Agent::Kimi
    } else {
        owner
    };
    match runs(table, start).split_first() {
        None => false,
        Some((own, rest)) => !rest.is_empty() || (owner != Agent::Generic && *own != owner),
    }
}

pub(crate) fn system(owner: Agent) -> bool {
    let declared = std::env::var(PARENT_SESSION_VARIABLE)
        .is_ok_and(|session| crate::text(&session, 256).is_ok());
    if declared {
        return true;
    }
    #[cfg(unix)]
    {
        in_process_tree(owner, &unix::Processes::detect(), std::process::id())
    }
    #[cfg(windows)]
    {
        windows::Processes::snapshot()
            .is_some_and(|table| in_process_tree(owner, &table, std::process::id()))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = owner;
        false
    }
}

// The table builder compiles on every host under test, so Linux CI runs it; the snapshot reader only on Windows.
#[cfg(any(windows, test))]
mod windows;

#[cfg(unix)]
mod unix {
    use super::{names, Process, Table};
    use std::{
        fs::File,
        io::Read,
        path::Path,
        process::Command,
        sync::{atomic::AtomicBool, Arc},
        time::Duration,
    };

    /// `/proc` where the host has it, else the `ps` every Unix ships.
    pub(super) struct Processes {
        proc: bool,
    }
    impl Processes {
        pub(super) fn detect() -> Self {
            Self {
                proc: Path::new("/proc/self/stat").exists(),
            }
        }
    }
    impl Table for Processes {
        fn process(&self, pid: u32) -> Option<Process> {
            if self.proc {
                procfs(pid)
            } else {
                ps(pid)
            }
        }
    }

    pub(super) fn parent_of_stat(stat: &str) -> Option<u32> {
        // The command name may hold spaces and parentheses; the fields after it do not.
        stat.rsplit_once(')')?
            .1
            .split_whitespace()
            .nth(1)?
            .parse()
            .ok()
    }
    pub(super) fn procfs(pid: u32) -> Option<Process> {
        let parent = parent_of_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)?;
        let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
        let mut cmdline = Vec::new();
        let _ = File::open(format!("/proc/{pid}/cmdline"))
            .ok()?
            .take(4096)
            .read_to_end(&mut cmdline);
        let argv: Vec<&str> = cmdline
            .split(|byte| *byte == 0)
            .filter_map(|argument| std::str::from_utf8(argument).ok())
            .collect();
        Some(Process {
            parent,
            names: names(comm.trim_end(), &argv),
        })
    }

    pub(super) fn parse_ps(line: &str) -> Option<Process> {
        let (parent, command) = line.trim_start().split_once(char::is_whitespace)?;
        let argv: Vec<&str> = command.split_whitespace().collect();
        Some(Process {
            parent: parent.parse().ok()?,
            names: names("", &argv),
        })
    }
    pub(super) fn ps(pid: u32) -> Option<Process> {
        let mut command = Command::new("ps");
        command.args(["-o", "ppid=,command=", "-p", &pid.to_string()]);
        let bytes = crate::devices::bounded_command(
            command,
            8192,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(2),
        )
        .ok()?;
        parse_ps(std::str::from_utf8(&bytes).ok()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A process table written down: (pid, parent, command name).
    struct Tree(&'static [(u32, u32, &'static str)]);
    impl Table for Tree {
        fn process(&self, pid: u32) -> Option<Process> {
            self.0
                .iter()
                .find(|(id, ..)| *id == pid)
                .map(|(_, parent, name)| Process {
                    parent: *parent,
                    names: names(name, &[]),
                })
        }
    }
    fn nested(owner: Agent, tree: &'static [(u32, u32, &'static str)]) -> bool {
        in_process_tree(owner, &Tree(tree), 100)
    }

    #[test]
    fn an_agent_started_by_another_agent_is_nested_and_a_top_level_one_is_not() {
        // lazysh-agent <- sh <- codex <- bash <- claude <- zsh
        let tree = &[
            (100, 90, "lazysh-agent"),
            (90, 80, "sh"),
            (80, 70, "codex"),
            (70, 60, "bash"),
            (60, 50, "claude"),
            (50, 2, "zsh"),
        ];
        assert!(nested(Agent::Codex, tree));
        // The same chain without the outer agent is the user's own session.
        let alone = &[
            (100, 90, "lazysh-agent"),
            (90, 80, "sh"),
            (80, 70, "codex"),
            (70, 60, "bash"),
            (60, 50, "zsh"),
            (50, 2, "tmux: server"),
        ];
        assert!(!nested(Agent::Codex, alone));
        assert!(!nested(
            Agent::Claude,
            &[(100, 60, "sh"), (60, 50, "claude"), (50, 2, "zsh")]
        ));
        assert!(!nested(Agent::Claude, &[(100, 2, "zsh")]));
    }

    #[test]
    fn a_launcher_and_its_program_are_one_agent_but_a_second_session_of_it_is_nested() {
        let wrapped = &[
            (100, 90, "sh"),
            (90, 80, "claude"),
            (80, 70, "claude"),
            (70, 2, "zsh"),
        ];
        assert!(!nested(Agent::Claude, wrapped));
        let headless = &[
            (100, 90, "sh"),
            (90, 80, "claude"),
            (80, 70, "bash"),
            (70, 60, "claude"),
            (60, 2, "zsh"),
        ];
        assert!(nested(Agent::Claude, headless));
    }

    #[test]
    fn an_unrecognized_owner_still_sees_the_agent_that_started_it_but_a_generic_reporter_does_not()
    {
        // The reporting `codex` runs under a name nothing recognizes, below a Claude Code session.
        let tree = &[
            (100, 90, "sh"),
            (90, 80, "node"),
            (80, 70, "bash"),
            (70, 60, "claude"),
            (60, 2, "zsh"),
        ];
        assert!(nested(Agent::Codex, tree));
        assert!(!nested(Agent::Generic, tree));
        let two = &[
            (100, 90, "sh"),
            (90, 80, "codex"),
            (80, 70, "bash"),
            (70, 60, "claude"),
        ];
        assert!(nested(Agent::Generic, two));
    }

    #[test]
    fn kimi_code_runs_as_the_kimi_process_so_its_own_run_is_not_a_nesting() {
        let tree = &[(100, 90, "sh"), (90, 80, "kimi"), (80, 2, "zsh")];
        assert!(!nested(Agent::KimiCode, tree));
        assert!(nested(Agent::Claude, tree));
    }

    #[test]
    fn a_loop_in_the_table_and_a_missing_process_end_the_walk() {
        assert!(!nested(
            Agent::Claude,
            &[(100, 90, "sh"), (90, 100, "claude")]
        ));
        assert!(!nested(Agent::Claude, &[(100, 90, "sh")]));
        assert!(!nested(Agent::Claude, &[]));
    }

    #[test]
    fn names_come_from_the_command_and_from_the_script_a_launcher_runs() {
        assert!(names("node", &["node", "/opt/x/opencode.js", "serve"])
            .contains(&"opencode".to_owned()));
        assert!(names("bash", &["-bash", "/home/u/bin/claude.sh"]).contains(&"claude".to_owned()));
        assert!(names("claude", &[]).contains(&"claude".to_owned()));
        let shell = names("sh", &["sh", "-c", "claude -p hello"]);
        assert!(
            !shell.iter().any(|name| name.contains("claude")),
            "{shell:?}"
        );
        assert!(!names("python3", &["python3", "-m", "claude"]).contains(&"claude".to_owned()));
    }

    #[cfg(unix)]
    #[test]
    fn the_real_process_table_reports_this_process_parent_by_proc_and_by_ps() {
        use std::os::unix::process::parent_id;
        let me = std::process::id();
        let ps = unix::ps(me).expect("ps answers for a live process");
        assert_eq!(ps.parent, parent_id());
        assert!(!ps.names.is_empty());
        #[cfg(target_os = "linux")]
        {
            let proc = unix::procfs(me).expect("/proc answers for a live process");
            assert_eq!(proc.parent, parent_id());
            assert!(!proc.names.is_empty());
        }
        assert_eq!(unix::parent_of_stat("12 (a b) c) S 77 1 1"), Some(77));
        assert_eq!(
            unix::parse_ps("  412 /bin/sh /x/claude -p\n")
                .unwrap()
                .parent,
            412
        );
        assert!(unix::parse_ps("").is_none());
    }
}

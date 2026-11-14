//! Explicit agent launch and Git worktree creation in a Herdr, tmux or Zellij session.
//!
//! Every remote step is an exact argv run by `sh` as `"$@"`; the SSH login
//! shell parses each element as one quoted word and nothing else (see
//! [`script`]), and nothing is typed into an existing pane. An agent starts
//! only after the renderer showed this plan and the user confirmed it: through
//! `herdr agent start` in a new workspace's root pane, as the argv of a new tmux
//! window (`new-window`) or as the argv of a new Zellij pane (`run`).
use crate::app_lock::AccessLease;
use crate::multiplexer::{tmux_word, Entry, MultiplexerKind};
use crate::ssh::{quote, AppState, Result, Session, SshError};
use crate::tmux_server::TmuxServer;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

const STATUS_MARK: &str = "lazysh-status:";
const OUTPUT_LIMIT: usize = 256 * 1024;
const MESSAGE_LIMIT: usize = 2000;
const AGENT_START_MS: u64 = 60_000;
/// Shown in a plan in place of the root pane ID that only exists after creation.
pub(crate) const NEW_PANE: &str = "<new-workspace-pane>";

/// Herdr 0.9.3 to 0.9.5 `agent start --kind` labels and their canonical executables.
/// `prompt` marks CLIs whose first positional argument is an initial prompt.
const AGENTS: &[(&str, &str, &str, bool)] = &[
    ("codex", "codex", "Codex", true),
    ("claude", "claude", "Claude Code", true),
    ("opencode", "opencode", "OpenCode", false),
    ("gemini", "gemini", "Gemini CLI", false),
    ("cursor", "cursor-agent", "Cursor Agent", false),
    ("copilot", "copilot", "GitHub Copilot CLI", false),
    ("droid", "droid", "Factory Droid", false),
    ("amp", "amp", "Amp", false),
    ("cline", "cline", "Cline", false),
    ("kimi", "kimi", "Kimi CLI", false),
    ("kiro", "kiro-cli", "Kiro CLI", false),
    ("qwen", "qwen", "Qwen Code", false),
    ("grok", "grok", "Grok", false),
    ("pi", "pi", "Pi", false),
    ("devin", "devin", "Devin", false),
    ("agy", "agy", "Antigravity", false),
    ("hermes", "hermes", "Hermes", false),
    ("kilo", "kilo", "Kilo Code", false),
    ("qodercli", "qodercli", "Qoder CLI", false),
    ("letta", "letta", "Letta Code", false),
    ("omp", "omp", "OmP", false),
    ("mastracode", "mastracode", "Mastra Code", false),
    ("maki", "maki", "Maki", false),
    ("muse", "muse", "Muse", false),
];

fn invalid(message: &str) -> SshError {
    SshError::new("invalid_target", message)
}
fn agent(kind: &str) -> Result<(&'static str, &'static str, bool)> {
    AGENTS
        .iter()
        .find(|row| row.0 == kind)
        .map(|row| (row.0, row.1, row.3))
        .ok_or_else(|| invalid("Unsupported agent kind"))
}

/// Free text is single-line, bounded and free of backslashes, so the plan's
/// POSIX-quoted command stays a faithful copy-paste of what runs.
fn text(value: &str, max: usize, message: &str) -> Result<()> {
    if value.trim().is_empty()
        || value.len() > max
        || value.chars().any(char::is_control)
        || value.contains('\\')
    {
        return Err(invalid(message));
    }
    Ok(())
}
pub(crate) fn absolute_path(value: &str) -> Result<()> {
    text(value, 4096, "Enter an absolute directory path")?;
    if !value.starts_with('/')
        || value
            .split('/')
            .skip(1)
            .any(|part| matches!(part, "." | ".."))
    {
        return Err(invalid("Enter an absolute directory path without . or .."));
    }
    Ok(())
}
/// `git check-ref-format --branch` rules, without consulting the repository.
pub(crate) fn branch(value: &str) -> Result<()> {
    let bad = || invalid("Enter a valid Git branch name");
    if value.is_empty() || value.len() > 200 || value == "HEAD" || value == "@" {
        return Err(bad());
    }
    if value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("//")
        || value.contains("@{")
        || value
            .chars()
            .any(|c| c.is_control() || " ~^:?*[\\".contains(c))
        || value
            .split('/')
            .any(|part| part.starts_with('.') || part.ends_with(".lock"))
    {
        return Err(bad());
    }
    Ok(())
}
pub(crate) fn base(value: &str) -> Result<()> {
    text(value, 256, "Enter a valid base revision")?;
    if value.starts_with('-') || value.chars().any(char::is_whitespace) {
        return Err(invalid("Enter a valid base revision"));
    }
    Ok(())
}
fn agent_name(value: &str) -> Result<()> {
    let mut bytes = value.bytes();
    if value.len() > 32
        || !bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        || !bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
    {
        return Err(invalid("Invalid Herdr agent name"));
    }
    Ok(())
}
fn server(value: &str) -> Result<()> {
    crate::multiplexer::validate_text(value, 200, "Invalid Herdr name or path")
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    Directory {
        label: String,
        directory: String,
    },
    Worktree {
        repository: String,
        branch: String,
        base: String,
        path: String,
    },
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentRequest {
    kind: String,
    name: String,
    #[serde(default)]
    prompt: Option<String>,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRequest {
    target: Target,
    #[serde(default)]
    agent: Option<AgentRequest>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    stage: &'static str,
    argv: Vec<String>,
    command: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    steps: Vec<Step>,
}
fn step(stage: &'static str, argv: Vec<String>) -> Step {
    let command = argv.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
    Step {
        stage,
        argv,
        command,
    }
}
fn args(values: &[&str]) -> Vec<String> {
    values.iter().map(|v| (*v).to_owned()).collect()
}

/// The multiplexer session a launch runs in.
pub(crate) enum Host<'a> {
    Herdr(&'a str),
    Tmux(&'a str, TmuxServer),
    Zellij(&'a str),
}
impl<'a> Host<'a> {
    /// A launch needs the session a terminal is attached to, so it never creates
    /// one. Given the SSH session, tmux uses the server that terminal is bound to.
    pub(crate) fn of(entry: &'a Entry, session: Option<&Session>) -> Result<Self> {
        entry.validate()?;
        if entry.create_if_missing {
            return Err(invalid("Start agents in an existing multiplexer session"));
        }
        Ok(match entry.kind {
            MultiplexerKind::Herdr => Self::Herdr(&entry.name),
            MultiplexerKind::Tmux => Self::Tmux(
                &entry.name,
                match session {
                    Some(session) => {
                        TmuxServer::for_session(session, entry.tmux_server.as_deref())?
                    }
                    None => entry.server()?,
                },
            ),
            MultiplexerKind::Zellij => Self::Zellij(&entry.name),
        })
    }
}
/// tmux expands formats in window names and start directories; `##` is a literal `#`.
fn literal_format(value: &str) -> String {
    tmux_word(&value.replace('#', "##"))
}

struct Validated<'a> {
    label: &'a str,
    directory: &'a str,
    worktree: Option<[&'a str; 4]>,
    agent: Option<(&'static str, &'static str, &'a str, Option<&'a str>)>,
}
/// `multiline` lets a prompt hold line breaks and tabs: only an argv word of a
/// tmux or Zellij launch carries them verbatim; Herdr's `agent start` takes one line.
fn validate(request: &CreateRequest, multiline: bool) -> Result<Validated<'_>> {
    let (label, directory, worktree) = match &request.target {
        Target::Directory { label, directory } => {
            text(label, 200, "Enter a workspace label")?;
            absolute_path(directory)?;
            (label.as_str(), directory.as_str(), None)
        }
        Target::Worktree {
            repository,
            branch: name,
            base: revision,
            path,
        } => {
            absolute_path(repository)?;
            branch(name)?;
            base(revision)?;
            absolute_path(path)?;
            (
                name.as_str(),
                path.as_str(),
                Some([
                    repository.as_str(),
                    name.as_str(),
                    path.as_str(),
                    revision.as_str(),
                ]),
            )
        }
    };
    let agent = match &request.agent {
        None => None,
        Some(value) => {
            let (kind, executable, prompts) = agent(&value.kind)?;
            agent_name(&value.name)?;
            let prompt = value.prompt.as_deref().filter(|p| !p.trim().is_empty());
            if let Some(prompt) = prompt {
                if !prompts {
                    return Err(invalid("This agent does not accept an initial prompt"));
                }
                let (checked, message) = if multiline {
                    (
                        prompt.replace(['\n', '\t'], " "),
                        "Enter a prompt without control characters or backslashes",
                    )
                } else {
                    (
                        prompt.to_owned(),
                        "Enter a single-line prompt without backslashes",
                    )
                };
                text(&checked, 2000, message)?;
                if prompt.starts_with('-') {
                    return Err(invalid("A prompt cannot start with -"));
                }
            }
            Some((kind, executable, value.name.as_str(), prompt))
        }
    };
    Ok(Validated {
        label,
        directory,
        worktree,
        agent,
    })
}
fn plan_steps(host: &Host, request: &CreateRequest, pane: &str) -> Result<Vec<Step>> {
    let valid = validate(request, !matches!(host, Host::Herdr(_)))?;
    if let Host::Herdr(name) = host {
        server(name)?;
    }
    // A tmux or Zellij launch is the agent's own argv: `executable [prompt]`.
    let launch = match (host, valid.agent) {
        (Host::Herdr(_), _) => vec![],
        (_, None) => return Err(invalid("Choose an agent to start")),
        (_, Some((_, executable, _, prompt))) => {
            let mut argv = vec![executable];
            argv.extend(prompt);
            argv.into_iter().map(str::to_owned).collect()
        }
    };
    let mut steps = vec![];
    // A missing agent fails before anything exists on the host.
    if let Some((_, executable, _, _)) = valid.agent {
        steps.push(step(
            "agentCheck",
            args(&["command", "-v", "--", executable]),
        ));
    }
    if let Some([repository, branch, path, base]) = valid.worktree {
        steps.push(step(
            "worktree",
            args(&[
                "git", "-C", repository, "worktree", "add", "-b", branch, "--", path, base,
            ]),
        ));
    }
    let name = match host {
        Host::Herdr(name) => name,
        Host::Tmux(session, server) => {
            let mut argv = server.argv();
            argv.extend(args(&[
                "new-window",
                "-d",
                "-P",
                "-F",
                "#{pane_id}",
                "-t",
                &tmux_word(&format!("={session}:")),
                "-n",
                &literal_format(valid.label),
                "-c",
                &literal_format(valid.directory),
                "--",
            ]));
            argv.extend(launch.iter().map(|word| tmux_word(word)));
            steps.push(step("window", argv));
            return Ok(steps);
        }
        Host::Zellij(session) => {
            let mut argv = args(&[
                "zellij",
                &format!("--session={session}"),
                "run",
                &format!("--cwd={}", valid.directory),
                &format!("--name={}", valid.label),
                "--",
            ]);
            argv.extend(launch);
            steps.push(step("pane", argv));
            return Ok(steps);
        }
    };
    steps.push(step(
        "workspace",
        args(&[
            "herdr",
            "--session",
            name,
            "workspace",
            "create",
            "--no-focus",
            "--label",
            valid.label,
            "--cwd",
            valid.directory,
        ]),
    ));
    if let Some((kind, _, agent, prompt)) = valid.agent {
        let timeout = AGENT_START_MS.to_string();
        let mut argv = args(&[
            "herdr",
            "--session",
            name,
            "agent",
            "start",
            agent,
            "--kind",
            kind,
            "--pane",
            pane,
            "--timeout",
            &timeout,
        ]);
        if let Some(prompt) = prompt {
            argv.extend(args(&["--", prompt]));
        }
        steps.push(step("agent", argv));
    }
    Ok(steps)
}

/// One completed remote step: combined output and exit status.
pub(crate) struct Output {
    status: i32,
    text: String,
}
pub(crate) trait Remote {
    async fn run(&mut self, argv: &[String], timeout: Duration) -> Result<Output>;
}
/// One word that POSIX shells (sh, dash, bash, zsh, ksh) and fish all read as
/// exactly `value`: single quotes hold everything except `'` and `\`, which go
/// in double quotes (`"'"`, `"\\"`), the only forms both families parse alike.
/// Fish treats `\'` and `\\` inside single quotes as escapes, so POSIX `'\''`
/// quoting is not exact there.
pub(crate) fn login_word(value: &str) -> String {
    let mut word = String::from("'");
    for c in value.chars() {
        match c {
            '\'' => word.push_str("'\"'\"'"),
            '\\' => word.push_str("'\"\\\\\"'"),
            c => word.push(c),
        }
    }
    word.push('\'');
    word
}
/// The SSH exec channel hands this string to the user's login shell, which
/// parses it exactly once: a fixed wrapper and each argv element as its own
/// [`login_word`]. `sh` then runs the argv as `"$@"`, so no element is ever
/// parsed as shell syntax, and appends the exit status.
pub(crate) fn script(argv: &[String]) -> String {
    let wrapper = format!("\"$@\" 2>&1; s=$?; echo; echo {STATUS_MARK}$s");
    let mut command = format!("sh -c {} sh", login_word(&wrapper));
    for arg in argv {
        command.push(' ');
        command.push_str(&login_word(arg));
    }
    command
}
fn parse_status(raw: &str) -> Result<Output> {
    let invalid = || SshError::new("invalid_output", "Remote command status is missing");
    let body = raw.strip_suffix('\n').ok_or_else(invalid)?;
    let (text, status) = body
        .rsplit_once(&format!("\n{STATUS_MARK}"))
        .ok_or_else(invalid)?;
    Ok(Output {
        status: status.parse().map_err(|_| invalid())?,
        text: text.to_owned(),
    })
}
/// Host output stays verbatim but bounded and free of terminal controls.
pub(crate) fn bounded(message: &str) -> String {
    let clean: String = message
        .trim()
        .chars()
        .map(|c| if c.is_control() && c != '\n' { ' ' } else { c })
        .collect();
    if clean.chars().count() <= MESSAGE_LIMIT {
        return clean;
    }
    let mut short: String = clean.chars().take(MESSAGE_LIMIT).collect();
    short.push('…');
    short
}
fn failed(output: &Output) -> String {
    let message = herdr_error(&output.text).unwrap_or_else(|| bounded(&output.text));
    if message.is_empty() {
        format!("Exited with status {}", output.status)
    } else {
        message
    }
}
fn json(text: &str) -> Option<serde_json::Value> {
    let text = text.trim();
    serde_json::from_str(text).ok().or_else(|| {
        text.lines()
            .rev()
            .find_map(|line| serde_json::from_str(line.trim()).ok())
    })
}
fn herdr_error(text: &str) -> Option<String> {
    let value = json(text)?;
    let error = value.get("error")?;
    let code = error
        .get("code")
        .and_then(|v| v.as_str())
        .unwrap_or("error");
    let message = error.get("message").and_then(|v| v.as_str()).unwrap_or("");
    Some(bounded(&format!("{code}: {message}")))
}

#[derive(Debug, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    stage: &'static str,
    message: String,
}
#[derive(Debug, Serialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    #[serde(skip_serializing_if = "Option::is_none")]
    worktree: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pane_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    failure: Option<Failure>,
}
fn created(text: &str) -> Option<(String, String)> {
    let value = json(text)?;
    let result = value.get("result")?;
    if result.get("type")?.as_str()? != "workspace_created" {
        return None;
    }
    let workspace = result.pointer("/workspace/workspace_id")?.as_str()?;
    let pane = result.pointer("/root_pane/pane_id")?.as_str()?;
    (lazysh_common::valid_herdr_id(workspace, None)
        && lazysh_common::valid_herdr_id(pane, Some('p'))
        && pane.split(':').next() == Some(workspace))
    .then(|| (workspace.to_owned(), pane.to_owned()))
}
fn started(text: &str, name: &str) -> bool {
    json(text).is_some_and(|value| {
        value.pointer("/result/type").and_then(|v| v.as_str()) == Some("agent_started")
            && value.pointer("/result/agent/name").and_then(|v| v.as_str()) == Some(name)
    })
}

/// The new tmux (`%<n>`) or Zellij (`terminal_<n>`) pane as the last line of a
/// launch reply, which merges stderr into stdout.
fn new_pane(text: &str, prefix: &str) -> Option<String> {
    let line = text
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())?
        .trim();
    let number = line.strip_prefix(prefix)?;
    (!number.is_empty() && number.len() < 20 && number.bytes().all(|b| b.is_ascii_digit()))
        .then(|| line.to_owned())
}

/// Runs the confirmed plan. A failure before the worktree, workspace, window or
/// pane exists is an error (nothing was created); later failures are reported
/// with what already exists, which is kept as-is: no worktree, branch or
/// workspace is removed automatically.
pub(crate) async fn execute(
    remote: &mut impl Remote,
    host: &Host<'_>,
    request: &CreateRequest,
) -> Result<Outcome> {
    let mut steps = plan_steps(host, request, NEW_PANE)?;
    let mut outcome = Outcome::default();
    let fail = |stage, message: String, outcome: Outcome, first: bool| {
        if first {
            Err(SshError::new("remote_command_failed", message))
        } else {
            Ok(Outcome {
                failure: Some(Failure { stage, message }),
                ..outcome
            })
        }
    };
    for index in 0..steps.len() {
        let first = outcome.worktree.is_none() && outcome.workspace_id.is_none();
        let stage = steps[index].stage;
        let timeout = match stage {
            "worktree" => Duration::from_secs(120),
            "agent" => Duration::from_millis(AGENT_START_MS + 15_000),
            _ => Duration::from_secs(20),
        };
        let output = match remote.run(&steps[index].argv, timeout).await {
            Ok(output) => output,
            // A lost transport after the first step must not hide what already exists.
            Err(error) if !first => return fail(stage, bounded(error.message()), outcome, first),
            Err(error) => return Err(error),
        };
        match stage {
            "worktree" if output.status == 0 => {
                outcome.worktree = Some(steps[index].argv[8].clone());
            }
            "workspace" if output.status == 0 => match created(&output.text) {
                Some((workspace, pane)) => {
                    if let Some(last) = steps.last_mut().filter(|s| s.stage == "agent") {
                        last.argv[9].clone_from(&pane);
                    }
                    outcome.workspace_id = Some(workspace);
                    outcome.pane_id = Some(pane);
                }
                None => {
                    let message = bounded(&format!(
                        "Unrecognized Herdr workspace reply: {}",
                        output.text
                    ));
                    return fail(stage, message, outcome, first);
                }
            },
            "window" | "pane" if output.status == 0 => {
                let prefix = if stage == "window" { "%" } else { "terminal_" };
                match new_pane(&output.text, prefix) {
                    Some(pane) => {
                        outcome.pane_id = Some(pane);
                        outcome.agent = request.agent.as_ref().map(|agent| agent.name.clone());
                    }
                    None => {
                        let message =
                            bounded(&format!("Unrecognized {stage} reply: {}", output.text));
                        return fail(stage, message, outcome, first);
                    }
                }
            }
            "agentCheck" if output.status == 0 => {}
            "agentCheck" => {
                let executable = steps[index].argv[3].clone();
                let message = format!("{executable} was not found on the host PATH (command -v)");
                return fail(stage, message, outcome, first);
            }
            "agent" if output.status == 0 && started(&output.text, &steps[index].argv[5]) => {
                outcome.agent = Some(steps[index].argv[5].clone());
            }
            _ => return fail(stage, failed(&output), outcome, first),
        }
    }
    Ok(outcome)
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentKind {
    kind: &'static str,
    label: &'static str,
    executable: &'static str,
    prompt: bool,
}
/// Lists supported agents whose canonical executable `command -v` resolves to an
/// executable file (dash's `command -v` also reports non-executable files).
pub(crate) async fn agent_kinds(remote: &mut impl Remote) -> Result<Vec<AgentKind>> {
    // Executable names are positional parameters, so the probe has no quotes.
    let mut argv = args(&[
        "sh",
        "-c",
        r#"for e in "$@"; do if p=$(command -v -- "$e" 2>/dev/null) && [ -x "$p" ]; then echo "$e"; fi; done"#,
        "sh",
    ]);
    argv.extend(AGENTS.iter().map(|row| row.1.to_owned()));
    let output = remote.run(&argv, Duration::from_secs(15)).await?;
    if output.status != 0 {
        return Err(SshError::new("remote_command_failed", failed(&output)));
    }
    let found: Vec<&str> = output.text.lines().collect();
    Ok(AGENTS
        .iter()
        .filter(|row| found.contains(&row.1))
        .map(|&(kind, executable, label, prompt)| AgentKind {
            kind,
            label,
            executable,
            prompt,
        })
        .collect())
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Repository {
    root: String,
    main: String,
    head: String,
    detached: bool,
    worktrees: Vec<String>,
}
fn git_path(text: &str) -> Result<String> {
    let path = text.strip_suffix('\n').unwrap_or(text);
    absolute_path(path).map_err(|_| SshError::new("invalid_output", "Unsupported Git path"))?;
    Ok(path.to_owned())
}
/// Reads the Git repository containing `directory`: its top level, current
/// HEAD and the worktree paths Git already tracks (main worktree first).
pub(crate) async fn repository(remote: &mut impl Remote, directory: &str) -> Result<Repository> {
    absolute_path(directory)?;
    let git = |rest: &[&str], dir: &str| {
        let mut argv = args(&["git", "-C", dir]);
        argv.extend(args(rest));
        argv
    };
    let check = |output: Output| {
        if output.status == 0 {
            Ok(output.text)
        } else {
            Err(SshError::new("not_a_repository", failed(&output)))
        }
    };
    let timeout = Duration::from_secs(15);
    let root = git_path(&check(
        remote
            .run(&git(&["rev-parse", "--show-toplevel"], directory), timeout)
            .await?,
    )?)?;
    let symbolic = remote
        .run(
            &git(&["symbolic-ref", "--quiet", "--short", "HEAD"], &root),
            timeout,
        )
        .await?;
    let (head, detached) = if symbolic.status == 0 {
        (symbolic.text.trim().to_owned(), false)
    } else {
        let commit = check(
            remote
                .run(&git(&["rev-parse", "--short", "HEAD"], &root), timeout)
                .await?,
        )?;
        (commit.trim().to_owned(), true)
    };
    if base(&head).is_err() {
        return Err(SshError::new("invalid_output", "Unsupported Git HEAD"));
    }
    let list = check(
        remote
            .run(
                &git(&["worktree", "list", "--porcelain", "-z"], &root),
                timeout,
            )
            .await?,
    )?;
    let mut worktrees = vec![];
    for field in list.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if worktrees.len() >= 1000 {
                return Err(SshError::new("output_too_large", "Too many Git worktrees"));
            }
            if let Ok(path) = git_path(path) {
                worktrees.push(path);
            }
        }
    }
    let main = worktrees.first().cloned().unwrap_or_else(|| root.clone());
    Ok(Repository {
        root,
        main,
        head,
        detached,
        worktrees,
    })
}

struct Ssh<'a> {
    session: &'a crate::ssh::Session,
    access: &'a AccessLease,
}
impl Remote for Ssh<'_> {
    async fn run(&mut self, argv: &[String], timeout: Duration) -> Result<Output> {
        let raw = crate::ssh::exec_bounded(
            self.session,
            script(argv),
            self.access,
            timeout,
            OUTPUT_LIMIT,
            None,
        )
        .await?;
        parse_status(&raw)
    }
}

#[tauri::command]
pub fn herdr_workspace_plan(name: String, request: CreateRequest) -> Result<Plan> {
    Ok(Plan {
        steps: plan_steps(&Host::Herdr(&name), &request, NEW_PANE)?,
    })
}
/// The plan [`multiplexer_launch`] runs in the session's multiplexer.
#[tauri::command]
pub fn multiplexer_launch_plan(multiplexer: Entry, request: CreateRequest) -> Result<Plan> {
    Ok(Plan {
        steps: plan_steps(&Host::of(&multiplexer, None)?, &request, NEW_PANE)?,
    })
}
async fn run_plan(
    session: &Session,
    access: &AccessLease,
    host: &Host<'_>,
    request: &CreateRequest,
) -> Result<Outcome> {
    execute(&mut Ssh { session, access }, host, request).await
}
#[tauri::command]
pub async fn herdr_workspace_create(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    request: CreateRequest,
    access: AccessLease,
) -> crate::ssh::AccessResult<Outcome> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            run_plan(&session, &access, &Host::Herdr(&name), &request).await
        })
        .await
}
/// Prepares the worktree (if asked) and starts the agent in the multiplexer
/// session the terminal is attached to.
#[tauri::command]
pub async fn multiplexer_launch(
    state: State<'_, AppState>,
    session_id: String,
    multiplexer: Entry,
    request: CreateRequest,
    access: AccessLease,
) -> crate::ssh::AccessResult<Outcome> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let host = Host::of(&multiplexer, Some(&session))?;
            run_plan(&session, &access, &host, &request).await
        })
        .await
}
#[tauri::command]
pub async fn herdr_agent_kinds(
    state: State<'_, AppState>,
    session_id: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<Vec<AgentKind>> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            agent_kinds(&mut Ssh {
                session: &session,
                access: &access,
            })
            .await
        })
        .await
}
#[tauri::command]
pub async fn herdr_repository(
    state: State<'_, AppState>,
    session_id: String,
    directory: String,
    access: AccessLease,
) -> crate::ssh::AccessResult<Repository> {
    access
        .run(async {
            absolute_path(&directory)?;
            let session = state.session(&session_id).await?;
            repository(
                &mut Ssh {
                    session: &session,
                    access: &access,
                },
                &directory,
            )
            .await
        })
        .await
}

#[cfg(test)]
#[path = "herdr_create_tests.rs"]
pub(crate) mod tests;

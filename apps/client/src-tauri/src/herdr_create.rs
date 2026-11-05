//! Explicit Herdr workspace, Git worktree and agent creation.
//!
//! Every remote step is an exact argv: each element is POSIX-quoted, the
//! script runs under `sh -c`, and nothing is typed into an existing pane. An
//! agent starts only through `herdr agent start` in the new workspace's root
//! pane after the renderer showed this plan and the user confirmed it.
use crate::app_lock::AccessLease;
use crate::ssh::{quote, AppState, Result, SshError};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

const STATUS_MARK: &str = "lazysh-status:";
const OUTPUT_LIMIT: usize = 256 * 1024;
const MESSAGE_LIMIT: usize = 2000;
const AGENT_START_MS: u64 = 60_000;
/// Shown in a plan in place of the root pane ID that only exists after creation.
pub(crate) const NEW_PANE: &str = "<new-workspace-pane>";

/// Herdr 0.9.3 `agent start --kind` labels and their canonical executables.
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

/// Free text is single-line, bounded and free of backslashes, so one quoting
/// layer is exact for POSIX shells and for login shells such as fish.
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

struct Validated<'a> {
    label: &'a str,
    directory: &'a str,
    worktree: Option<[&'a str; 4]>,
    agent: Option<(&'static str, &'static str, &'a str, Option<&'a str>)>,
}
fn validate<'a>(name: &str, request: &'a CreateRequest) -> Result<Validated<'a>> {
    server(name)?;
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
                text(
                    prompt,
                    2000,
                    "Enter a single-line prompt without backslashes",
                )?;
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
fn plan_steps(name: &str, request: &CreateRequest, pane: &str) -> Result<Vec<Step>> {
    let valid = validate(name, request)?;
    let mut steps = vec![];
    if let Some([repository, branch, path, base]) = valid.worktree {
        steps.push(step(
            "worktree",
            args(&[
                "git", "-C", repository, "worktree", "add", "-b", branch, "--", path, base,
            ]),
        ));
    }
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
    if let Some((kind, executable, agent, prompt)) = valid.agent {
        steps.push(step(
            "agentCheck",
            args(&["command", "-v", "--", executable]),
        ));
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
fn script(argv: &[String]) -> String {
    let command = argv.iter().map(|a| quote(a)).collect::<Vec<_>>().join(" ");
    let script = format!("{command} 2>&1; printf '\\n{STATUS_MARK}%s\\n' \"$?\"");
    format!("sh -c {}", quote(&script))
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

/// Runs the confirmed plan. The first step's failure is an error (nothing was
/// created); later failures are reported with what already exists, which is
/// kept as-is: no worktree, branch or workspace is removed automatically.
pub(crate) async fn execute(
    remote: &mut impl Remote,
    name: &str,
    request: &CreateRequest,
) -> Result<Outcome> {
    let mut steps = plan_steps(name, request, NEW_PANE)?;
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
        let first = index == 0;
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
    let mut probe = String::new();
    for (_, executable, _, _) in AGENTS {
        probe.push_str(&format!(
            "if p=$(command -v -- {0} 2>/dev/null) && [ -x \"$p\" ]; then printf '%s\\n' {0}; fi; ",
            quote(executable)
        ));
    }
    let argv = args(&["sh", "-c", probe.trim_end()]);
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
        steps: plan_steps(&name, &request, NEW_PANE)?,
    })
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
            validate(&name, &request)?;
            let session = state.session(&session_id).await?;
            execute(
                &mut Ssh {
                    session: &session,
                    access: &access,
                },
                &name,
                &request,
            )
            .await
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

#[cfg(all(test, unix))]
#[path = "herdr_create_tests.rs"]
mod tests;

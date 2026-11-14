//! Agent input for a Zellij session.
//!
//! Zellij can write to one named pane (`--pane-id terminal_N`) whatever is focused, so the pane of the followed agent takes
//! the message through Zellij's own `action` commands. There is no guard on the host: this side re-reads the pane list and
//! sends only to a live terminal pane of that session whose foreground process is the agent, then types the text and
//! presses Enter as two separate calls. The check and the write are different host calls, so a pane replaced between them
//! is the one window left open, as for stock Herdr. A failure of the first write proves nothing was typed; a failure after
//! it is reported as unconfirmed.
use crate::herdr_stock_input::{agent_input_command, run_agent_input};
use crate::ssh::{self, quote, Result, Session, SshError};
use crate::{app_lock::AccessLease, tmux_jump::chat::Input};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    zellij_session: String,
    /// The terminal pane number, as Zellij exports it to the pane's processes in `ZELLIJ_PANE_ID`.
    pane: u32,
    /// The agent the pane must be running: a prompt typed at a shell would run as a command.
    agent: String,
}
impl Target {
    pub(crate) fn valid(&self) -> bool {
        crate::multiplexer::validate_text(&self.zellij_session, 200, "").is_ok()
            && !self.zellij_session.starts_with('-')
            && matches!(self.agent.as_str(), "claude" | "codex")
    }
    fn action(&self, verb: &str) -> String {
        format!(
            "zellij --session={} action {verb}",
            quote(&self.zellij_session)
        )
    }
    fn pane_arg(&self) -> String {
        format!("--pane-id terminal_{}", self.pane)
    }
}

fn invalid() -> SshError {
    SshError::new(
        "zellij_chat_invalid",
        "Unsupported Zellij terminal input or target",
    )
}
fn stale(message: impl ToString) -> SshError {
    SshError::new("zellij_chat_stale", message)
}
fn unconfirmed() -> SshError {
    SshError::new(
        "zellij_chat_uncertain",
        "Zellij delivery could not be confirmed; it was not resent",
    )
}

/// The host call that lists the session's panes as JSON.
fn list_command(target: &Target) -> String {
    target.action("list-panes --json --command")
}
/// Whether a foreground command line is the agent: its program or the script it runs (`node …/codex.js`) is named for it.
/// shortcut: only the first two words are read and a file of that name opened in another program passes; upgrade when a
/// host reports the process id of a pane.
fn runs_agent(command: &str, agent: &str) -> bool {
    command.split_whitespace().take(2).any(|word| {
        word.split('/').any(|part| {
            let part = part
                .strip_suffix(".js")
                .or(part.strip_suffix(".mjs"))
                .unwrap_or(part);
            part == agent || (agent == "claude" && part == "claude-code")
        })
    })
}
/// Zellij numbers terminal and plugin panes separately; only a live terminal pane running the agent takes input.
fn ready(listing: &str, target: &Target) -> Result<()> {
    let panes: serde_json::Value = serde_json::from_str(listing).map_err(|_| invalid())?;
    let pane = panes
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|row| row["id"] == target.pane && row["is_plugin"] == false);
    match pane {
        Some(row) if row["exited"] != false || row["is_held"] == true => {
            Err(stale("The Zellij pane of this agent has exited"))
        }
        Some(row)
            if row["pane_command"]
                .as_str()
                .is_some_and(|c| runs_agent(c, &target.agent)) =>
        {
            Ok(())
        }
        Some(_) => Err(stale("The Zellij pane no longer runs this agent")),
        None => Err(stale("The Zellij pane of this agent is gone")),
    }
}
/// The one or two host calls of an input, in order. Escape is the byte 27, Enter the byte 13. Dialog answers, long pastes
/// and mode keys have no Zellij profile and stay in the terminal.
fn steps(target: &Target, input: &Input) -> Option<Vec<String>> {
    let pane = target.pane_arg();
    let enter = target.action(&format!("write {pane} 13"));
    match input {
        Input::Send { text } => {
            // A multi-line prompt goes in as one bracketed paste, so its newlines are not Enter; a line is typed.
            let verb = if text.contains(['\n', '\t']) {
                "paste"
            } else {
                "write-chars"
            };
            Some(vec![
                target.action(&format!("{verb} {pane} -- {}", quote(text))),
                enter,
            ])
        }
        Input::RequestStop => Some(vec![target.action(&format!("write {pane} 27"))]),
        _ => None,
    }
}

pub(crate) async fn deliver(
    session: &Session,
    lease: &AccessLease,
    target: &Target,
    input: &Input,
) -> Result<()> {
    let steps = steps(target, input)
        .filter(|_| target.valid() && input.validate().is_ok())
        .ok_or_else(invalid)?;
    // Nothing is written yet: a host that does not answer, or a session that is gone, is a plain refusal.
    let listing = ssh::exec_for_access(session, list_command(target), lease)
        .await
        .map_err(|error| match error.kind() {
            "remote_command_failed" => stale(error.message()),
            _ => error,
        })?;
    ready(&listing, target)?;
    for (index, step) in steps.into_iter().enumerate() {
        ssh::exec_for_access(session, step, lease)
            .await
            .map_err(|error| match (index, error.kind()) {
                // Zellij's own refusal of the first write, before the text left this host call.
                (0, "remote_command_failed") => {
                    SshError::new("zellij_chat_rejected", error.message())
                }
                _ => unconfirmed(),
            })?;
    }
    Ok(())
}

agent_input_command!(
    /// Delivers one message (or Escape) to the pane of the followed agent in a Zellij session.
    zellij_agent_input,
    Target,
    deliver
);

#[cfg(test)]
mod tests {
    use super::*;

    fn target() -> Target {
        Target {
            zellij_session: "it's".into(),
            pane: 7,
            agent: "claude".into(),
        }
    }
    #[test]
    fn builds_zellijs_own_pane_commands_with_every_value_quoted() {
        let line = "a line 'quoted' $(not run) -x";
        assert_eq!(
            steps(&target(), &Input::Send { text: line.into() }).unwrap(),
            [
                "zellij --session='it'\\''s' action write-chars --pane-id terminal_7 -- 'a line '\\''quoted'\\'' $(not run) -x'",
                "zellij --session='it'\\''s' action write --pane-id terminal_7 13"
            ]
        );
        assert_eq!(
            steps(
                &target(),
                &Input::Send {
                    text: "two\nlines".into()
                }
            )
            .unwrap()[0],
            "zellij --session='it'\\''s' action paste --pane-id terminal_7 -- 'two\nlines'"
        );
        assert_eq!(
            steps(&target(), &Input::RequestStop).unwrap(),
            ["zellij --session='it'\\''s' action write --pane-id terminal_7 27"]
        );
        // Dialog keys, long pastes and any later key kind have no Zellij profile and never reach the host.
        for input in [
            Input::Select { option: 1, of: 3 },
            Input::Submit { of: 3 },
            Input::SendLong { text: "x".into() },
        ] {
            assert_eq!(steps(&target(), &input), None);
        }
    }
    #[test]
    fn accepts_only_a_named_session_that_cannot_pass_as_an_option() {
        assert!(target().valid());
        for name in ["", "--help", "bad\nname"] {
            let broken = Target {
                zellij_session: name.into(),
                ..target()
            };
            assert!(!broken.valid(), "{name:?}");
        }
        assert!(
            serde_json::from_str::<Target>(r#"{"zellijSession":"a","pane":1,"extra":1}"#).is_err()
        );
        assert!(serde_json::from_str::<Target>(r#"{"zellijSession":"a","pane":-1}"#).is_err());
    }
    #[test]
    fn sends_only_to_a_live_terminal_pane_that_runs_the_agent() {
        let listing = r#"[
            {"id":3,"is_plugin":true,"exited":false,"is_held":false,"pane_command":"claude"},
            {"id":7,"is_plugin":false,"exited":false,"is_held":false,"pane_command":"/opt/claude-code/bin/claude --resume abc"},
            {"id":8,"is_plugin":false,"exited":true,"is_held":true,"pane_command":"claude"},
            {"id":9,"is_plugin":false,"exited":false,"is_held":true,"pane_command":"claude"},
            {"id":11,"is_plugin":false,"exited":false,"is_held":false,"pane_command":"/usr/bin/zsh"},
            {"id":12,"is_plugin":false,"exited":false,"is_held":false}
        ]"#;
        let at = |pane| Target { pane, ..target() };
        assert!(ready(listing, &at(7)).is_ok());
        // A plugin pane, an exited or held pane, a shell and a missing one all fail closed as stale.
        for pane in [3, 8, 9, 10, 11, 12] {
            assert_eq!(
                ready(listing, &at(pane)).unwrap_err().kind(),
                "zellij_chat_stale",
                "{pane}"
            );
        }
        for broken in ["", "{}", "not json"] {
            assert_eq!(
                ready(broken, &at(7)).unwrap_err().kind(),
                "zellij_chat_invalid"
            );
        }
    }
    #[test]
    fn names_the_agent_by_its_program_or_script_and_nothing_else() {
        for (command, agent, expected) in [
            ("claude", "claude", true),
            ("/opt/claude-code/bin/claude --resume x", "claude", true),
            (
                "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js",
                "claude",
                true,
            ),
            (
                "node /usr/lib/node_modules/@openai/codex/bin/codex.js",
                "codex",
                true,
            ),
            ("codex --model gpt", "codex", true),
            ("/usr/bin/zsh", "claude", false),
            ("vim notes.md", "claude", false),
            ("codex", "claude", false),
            ("less a b claude", "claude", false),
            ("", "claude", false),
        ] {
            assert_eq!(runs_agent(command, agent), expected, "{command}");
        }
    }
    #[cfg(unix)]
    #[test]
    #[ignore = "requires zellij on PATH; runs an isolated background session with a fixture agent"]
    fn real_zellij_pane_takes_one_delivery_of_a_prompt_and_of_stop_and_refuses_a_shell_or_missing_pane(
    ) {
        use std::process::Command;
        let temp = tempfile::tempdir().unwrap();
        let name = format!("ls-{}", uuid::Uuid::new_v4().simple());
        let config = temp.path().join("config.kdl");
        std::fs::write(
            &config,
            "show_release_notes false\nshow_startup_tips false\n",
        )
        .unwrap();
        let run = |text: &str| {
            let mut command = Command::new("sh");
            command
                .arg("-c")
                .arg(text)
                .current_dir(temp.path())
                .env("TERM", "xterm-256color");
            for key in [
                "XDG_RUNTIME_DIR",
                "XDG_CACHE_HOME",
                "XDG_CONFIG_HOME",
                "HOME",
            ] {
                command.env(key, temp.path());
            }
            command
                .env_remove("ZELLIJ")
                .env_remove("ZELLIJ_SESSION_NAME")
                .env_remove("ZELLIJ_PANE_ID");
            command.output().unwrap()
        };
        struct Server<'a>(String, &'a dyn Fn(&str) -> std::process::Output);
        impl Drop for Server<'_> {
            fn drop(&mut self) {
                (self.1)(&format!("zellij kill-session -- {}", quote(&self.0)));
            }
        }
        let _server = Server(name.clone(), &run);
        let started = run(&format!(
            "zellij --config {} attach --create-background {}",
            quote(config.to_str().unwrap()),
            quote(&name)
        ));
        assert!(
            started.status.success(),
            "{}",
            String::from_utf8_lossy(&started.stderr)
        );
        // The fixture agent is a script named for it that copies what its terminal receives to a file.
        let out = temp.path().join("received");
        let script = temp.path().join("claude");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\nstty -echo\ncat > {}\n",
                quote(out.to_str().unwrap())
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let pane = String::from_utf8(
            run(&format!(
                "zellij --session={} run --name agent -- {}",
                quote(&name),
                quote(script.to_str().unwrap())
            ))
            .stdout,
        )
        .unwrap();
        let agent: u32 = pane
            .trim()
            .strip_prefix("terminal_")
            .unwrap()
            .parse()
            .unwrap();
        let target = |pane| Target {
            zellij_session: name.clone(),
            pane,
            agent: "claude".into(),
        };
        let listing = || String::from_utf8(run(&list_command(&target(agent))).stdout).unwrap();
        let mut verdict = Err(invalid());
        for _ in 0..250 {
            verdict = ready(&listing(), &target(agent));
            if verdict.is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        verdict.unwrap();
        let deliver = |input: Input| {
            for step in steps(&target(agent), &input).unwrap() {
                let output = run(&step);
                assert!(
                    output.status.success(),
                    "{step}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        };
        let received = |expected: &[u8]| {
            for _ in 0..250 {
                if std::fs::read(&out).unwrap_or_default() == expected {
                    return;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            panic!(
                "pane received {:?}, wanted {:?}",
                std::fs::read(&out),
                expected
            );
        };
        deliver(Input::Send {
            text: "it's $(not run) -x".into(),
        });
        received(b"it's $(not run) -x\n");
        // Text that looks like an option is still text.
        deliver(Input::Send {
            text: "--help".into(),
        });
        received(b"it's $(not run) -x\n--help\n");
        deliver(Input::RequestStop);
        deliver(Input::Send {
            text: "two\nlines".into(),
        });
        // Escape stays in the line the agent has not finished reading; a bracketed paste keeps its newline as text.
        received(b"it's $(not run) -x\n--help\n\x1btwo\nlines\n");
        // A pane running something else (a shell would take the prompt as a command) and a missing pane are refused.
        let other = String::from_utf8(
            run(&format!(
                "zellij --session={} run --name other -- sleep 600",
                quote(&name)
            ))
            .stdout,
        )
        .unwrap();
        let other: u32 = other
            .trim()
            .strip_prefix("terminal_")
            .unwrap()
            .parse()
            .unwrap();
        for pane in [other, agent + 50] {
            let mut kind = String::new();
            for _ in 0..250 {
                kind = ready(&listing(), &target(pane))
                    .unwrap_err()
                    .kind()
                    .to_string();
                if pane != other || kind == "zellij_chat_stale" {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert_eq!(kind, "zellij_chat_stale", "{pane}");
        }
    }
}

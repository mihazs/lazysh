//! Durable scrollback of the pane the attached multiplexer shows, read on the host rather than from the client's own buffer.
use crate::app_lock::AccessLease;
use crate::multiplexer::MultiplexerKind;
use crate::ssh::AppState;
use serde::Serialize;
use tauri::State;

/// The newest lines and the bytes the view keeps; older output is cut and the view says so.
pub(crate) const MAX_LINES: usize = 20_000;
const MAX_BYTES: usize = 2 * 1024 * 1024;
/// What a host command may print: above the shown bounds so the cut is lazysh's, not a transport failure.
const HOST_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
/// What the host keeps of a read: twice the shown bytes, so a cut it makes is dropped again by `shape`, which reports it.
const HOST_TAIL_BYTES: usize = 2 * MAX_BYTES;

/// `command` run by `sh` with only the newest `bytes` of its stdout sent and its exit status kept, so a pane
/// larger than `HOST_OUTPUT_LIMIT` yields its tail instead of failing the transport bound.
fn newest_bytes(command: &str, bytes: usize) -> String {
    // The status travels on fd 4 because a pipeline reports `tail`'s status, not the multiplexer's.
    let script = format!(
        "exec 3>&1; s=$( {{ {{ {command}\n echo $? >&4; }} | tail -c {bytes} >&3; }} 4>&1 ); exit \"${{s:-1}}\""
    );
    format!("sh -c {}", crate::ssh::quote(&script))
}
/// `herdr pane read` serves at most this many of the newest lines and does not say when it cut.
pub(crate) const HERDR_LINES: usize = 1000;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct History {
    pub(crate) text: String,
    pub(crate) lines: usize,
    pub(crate) truncated: bool,
}

/// Plain text of at most `MAX_LINES` lines and `MAX_BYTES` bytes, newest end kept. `source_cap` is a
/// multiplexer's own line limit: a read that fills it may have been cut there.
pub(crate) fn shape(raw: &str, source_cap: Option<usize>) -> History {
    let text: String = raw
        .trim_end()
        .chars()
        .filter(|character| *character == '\n' || *character == '\t' || !character.is_control())
        .collect();
    let mut lines: Vec<&str> = text.lines().collect();
    let mut truncated = source_cap.is_some_and(|cap| lines.len() >= cap);
    if lines.len() > MAX_LINES {
        lines.drain(..lines.len() - MAX_LINES);
        truncated = true;
    }
    let mut bytes = 0;
    let mut first = lines.len();
    for (index, line) in lines.iter().enumerate().rev() {
        bytes += line.len() + 1;
        if bytes > MAX_BYTES {
            break;
        }
        first = index;
    }
    // shortcut: one line over MAX_BYTES is dropped whole; a terminal line that long is not history anyone reads.
    if first > 0 {
        lines.drain(..first);
        truncated = true;
    }
    History {
        lines: lines.len(),
        text: lines.join("\n"),
        truncated,
    }
}

#[tauri::command]
pub async fn multiplexer_history(
    state: State<'_, AppState>,
    session_id: String,
    kind: MultiplexerKind,
    name: String,
    tmux_server: Option<String>,
    access: AccessLease,
) -> crate::ssh::AccessResult<History> {
    access
        .run(async {
            let session = state.session(&session_id).await?;
            let (command, source_cap) = match kind {
                MultiplexerKind::Tmux => (
                    crate::multiplexer::history_command(
                        &name,
                        &crate::tmux_server::TmuxServer::for_session(
                            &session.bindings,
                            tmux_server.as_deref(),
                            Some(crate::tmux_server::Binary::Tmux),
                        )?,
                        MAX_LINES,
                    )?,
                    None,
                ),
                MultiplexerKind::Zellij => (crate::zellij::history_command(&name)?, None),
                // rmux discovery lists `history` as missing, so the panel never offers it; a direct call is refused.
                MultiplexerKind::Rmux => {
                    Err::<(String, Option<usize>), _>(crate::ssh::SshError::new(
                        "invalid_target",
                        "History is not available for rmux yet",
                    ))?
                }
                MultiplexerKind::Herdr => (
                    crate::herdr::focused_history_command(&session, &name, HERDR_LINES, &access)
                        .await?,
                    Some(HERDR_LINES),
                ),
            };
            let output = crate::ssh::exec_status(
                &session,
                newest_bytes(&command, HOST_TAIL_BYTES),
                &access,
                crate::ssh::OP_TIMEOUT,
                HOST_OUTPUT_LIMIT,
                None,
                &mut |_| {},
            )
            .await
            .and_then(|run| {
                crate::ssh::check_exit(run.status, &run.stderr)?;
                // The cut can split a character; that oldest line is dropped by `shape`.
                Ok(String::from_utf8_lossy(&run.stdout).into_owned())
            })
            .map_err(|error| match kind {
                MultiplexerKind::Herdr => crate::herdr::missing_target(error),
                _ => error,
            })?;
            Ok(shape(&output, source_cap))
        })
        .await
}

/// What a real multiplexer returns once its shell has printed `seq 1 5000`: polls `read` (the
/// product command's output) for line 5000, then shapes it as the app does.
#[cfg(test)]
pub(crate) fn read_numbered_5000(read: impl Fn() -> String, source_cap: Option<usize>) -> History {
    let mut last = String::new();
    for _ in 0..200 {
        last = read();
        if last.lines().any(|line| line == "5000") {
            return shape(&last, source_cap);
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    panic!(
        "the pane never showed line 5000: {:?}",
        &last[last.len().saturating_sub(200)..]
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    fn numbered(count: usize) -> String {
        (1..=count).map(|n| format!("{n}\n")).collect()
    }
    #[test]
    fn keeps_a_short_history_whole_and_drops_the_blank_rows_of_the_screen_below_it() {
        let history = shape("one\n  two\n\n\n   \n", None);
        assert_eq!(
            history,
            History {
                text: "one\n  two".into(),
                lines: 2,
                truncated: false
            }
        );
        assert_eq!(shape("", None).lines, 0);
    }
    #[test]
    fn shows_only_text_so_a_host_cannot_draw_on_the_view() {
        assert_eq!(
            shape("a\u{1b}[31mred\r\n\tb\u{7}\n", None).text,
            "a[31mred\n\tb"
        );
    }
    #[test]
    fn cuts_the_oldest_lines_beyond_the_line_bound_and_says_so() {
        let history = shape(&numbered(MAX_LINES + 5), None);
        assert!(history.truncated);
        assert_eq!(history.lines, MAX_LINES);
        assert!(history.text.starts_with("6\n"));
        assert!(history.text.ends_with(&format!("\n{}", MAX_LINES + 5)));
        let exact = shape(&numbered(MAX_LINES), None);
        assert!(!exact.truncated);
        assert!(exact.text.starts_with("1\n"));
    }
    #[test]
    fn cuts_the_oldest_lines_beyond_the_byte_bound_on_a_line_boundary() {
        let line = "x".repeat(1023);
        let history = shape(&format!("{line}\n").repeat(3000), None);
        assert!(history.truncated);
        assert!(history.text.len() < MAX_BYTES);
        assert_eq!(history.text.len(), history.lines * 1024 - 1);
        assert!(history.lines >= MAX_BYTES / 1024 - 1);
        assert!(shape(&"y".repeat(MAX_BYTES + 1), None).text.is_empty());
    }
    fn run_sh(script: &str) -> std::process::Output {
        std::process::Command::new("sh")
            .args(["-c", script])
            .output()
            .unwrap()
    }
    #[test]
    fn a_pane_over_the_transport_bound_yields_its_newest_tail_cut_and_reported() {
        // 1.5 million numbered lines are more than HOST_OUTPUT_LIMIT: the unbounded read could not be returned.
        let command = "seq 1 1500000";
        assert!(run_sh(command).stdout.len() > HOST_OUTPUT_LIMIT);
        let run = run_sh(&newest_bytes(command, HOST_TAIL_BYTES));
        assert!(run.status.success());
        assert_eq!(run.stdout.len(), HOST_TAIL_BYTES);
        let history = shape(&String::from_utf8_lossy(&run.stdout), None);
        assert!(history.truncated);
        assert!(history.text.ends_with("\n1500000"));
        assert!(history.text.len() <= MAX_BYTES);
        assert!(!history.text.starts_with("1\n"));
    }
    #[test]
    fn a_failing_read_keeps_its_status_and_message_and_a_short_one_stays_whole() {
        let failed = run_sh(&newest_bytes(
            "echo partial; echo \"can't find session\" >&2; (exit 3)",
            4,
        ));
        assert_eq!(failed.status.code(), Some(3));
        assert_eq!(
            String::from_utf8_lossy(&failed.stderr),
            "can't find session\n"
        );
        let whole = run_sh(&newest_bytes("printf 'a\\nb\\n'", HOST_TAIL_BYTES));
        assert_eq!(String::from_utf8_lossy(&whole.stdout), "a\nb\n");
    }
    #[test]
    fn a_read_that_fills_the_multiplexers_own_limit_is_marked_cut() {
        assert!(shape(&numbered(HERDR_LINES), Some(HERDR_LINES)).truncated);
        assert!(!shape(&numbered(HERDR_LINES - 1), Some(HERDR_LINES)).truncated);
        assert!(!shape(&numbered(HERDR_LINES), None).truncated);
    }
}

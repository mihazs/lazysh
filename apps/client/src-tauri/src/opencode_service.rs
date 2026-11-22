//! Answers OpenCode permission requests and question forms, and stops a turn, through the host companion's
//! `opencode-service` commands. The host reads the service's credentials; nothing here ever sees them.
use crate::app_lock::AccessLease;
use crate::approvals::{companion_json, Reply};
use crate::local::LocalState;
use crate::ssh::{quote, AppState, Result, SshError};
use tauri::State;

fn invalid() -> SshError {
    SshError::new("invalid_input", "Invalid OpenCode service request")
}

fn token(value: &str, prefix: &str) -> bool {
    let Some(rest) = value.strip_prefix(prefix) else {
        return false;
    };
    (1..=128 - prefix.len()).contains(&rest.len())
        && rest.chars().all(|c| c == '_' || c.is_ascii_alphanumeric())
}

/// The OpenCode session a command is about and the pane that must still show it.
fn target(agent_session_id: &str, pane_id: Option<&str>) -> Result<String> {
    if !token(agent_session_id, "ses")
        || pane_id.is_some_and(|pane| {
            pane.len() > 32
                || !pane.strip_prefix('%').is_some_and(|rest| {
                    !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_digit())
                })
        })
    {
        return Err(invalid());
    }
    Ok(format!(
        "--session-id={}{}",
        quote(agent_session_id),
        pane_id
            .map(|pane| format!(" --pane-id={}", quote(pane)))
            .unwrap_or_default()
    ))
}

/// How one listed request is answered.
pub enum Answer<'a> {
    /// `once`, `always` or `reject`, with the reason a rejection carries.
    Permission(&'a str, Option<&'a str>),
    /// A JSON object of field key to value.
    Form(&'a str),
}

fn reply_command(
    agent_session_id: &str,
    pane_id: Option<&str>,
    id: &str,
    expected_hash: &str,
    expires_at: &str,
    answer: &Answer,
) -> Result<String> {
    let prefix = if matches!(answer, Answer::Form(_)) {
        "frm_"
    } else {
        "per_"
    };
    if !token(id, prefix)
        || expected_hash.len() != 64
        || !expected_hash.bytes().all(|b| b.is_ascii_hexdigit())
        || !(20..=35).contains(&expires_at.len())
        || !expires_at
            .bytes()
            .all(|b| b.is_ascii_digit() || b"-:TZ+.".contains(&b))
    {
        return Err(invalid());
    }
    let tail = match answer {
        Answer::Permission(decision, message)
            if matches!(*decision, "once" | "always" | "reject")
                && message.is_none_or(|text| {
                    *decision == "reject"
                        && !text.trim().is_empty()
                        && text.chars().count() <= 500
                        && !text.chars().any(char::is_control)
                }) =>
        {
            format!(
                " --decision {decision}{}",
                message
                    .map(|text| format!(" --message={}", quote(text)))
                    .unwrap_or_default()
            )
        }
        Answer::Form(json)
            if json.len() <= 8192
                && serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(json)
                    .is_ok() =>
        {
            format!(" --answer={}", quote(json))
        }
        _ => return Err(invalid()),
    };
    Ok(format!(
        "lazysh-agent opencode-service reply {} --id {} --expected-hash {} --expires-at {}{tail}",
        target(agent_session_id, pane_id)?,
        quote(id),
        quote(expected_hash),
        quote(expires_at)
    ))
}

#[tauri::command]
pub async fn opencode_service_list(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    agent_session_id: String,
    access: AccessLease,
) -> Reply {
    let command = target(&agent_session_id, None)
        .map(|target| format!("lazysh-agent opencode-service list {target}"));
    companion_json(&state, &local, &session_id, command, &access).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn opencode_service_reply(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    agent_session_id: String,
    pane_id: String,
    id: String,
    expected_hash: String,
    expires_at: String,
    decision: Option<String>,
    message: Option<String>,
    answer: Option<String>,
    access: AccessLease,
) -> Reply {
    let command = match (decision.as_deref(), answer.as_deref()) {
        (Some(decision), None) => reply_command(
            &agent_session_id,
            Some(&pane_id),
            &id,
            &expected_hash,
            &expires_at,
            &Answer::Permission(decision, message.as_deref()),
        ),
        (None, Some(answer)) if message.is_none() => reply_command(
            &agent_session_id,
            Some(&pane_id),
            &id,
            &expected_hash,
            &expires_at,
            &Answer::Form(answer),
        ),
        _ => Err(invalid()),
    };
    companion_json(&state, &local, &session_id, command, &access).await
}

#[tauri::command]
pub async fn opencode_service_abort(
    state: State<'_, AppState>,
    local: State<'_, LocalState>,
    session_id: String,
    agent_session_id: String,
    pane_id: String,
    access: AccessLease,
) -> Reply {
    let command = target(&agent_session_id, Some(&pane_id))
        .map(|target| format!("lazysh-agent opencode-service abort {target}"));
    companion_json(&state, &local, &session_id, command, &access).await
}

#[cfg(test)]
mod tests {
    use super::*;
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const WHEN: &str = "2026-11-15T03:51:36Z";

    #[test]
    fn a_reply_names_the_exact_request_and_quotes_what_the_person_typed() {
        let command = reply_command(
            "ses_abc",
            Some("%7"),
            "per_one",
            HASH,
            WHEN,
            &Answer::Permission("reject", Some("it's $(bad)")),
        )
        .unwrap();
        assert_eq!(command, format!("lazysh-agent opencode-service reply --session-id='ses_abc' --pane-id='%7' --id 'per_one' --expected-hash '{HASH}' --expires-at '{WHEN}' --decision reject --message='it'\\''s $(bad)'"));
        assert!(reply_command(
            "ses_abc",
            Some("%7"),
            "frm_one",
            HASH,
            WHEN,
            &Answer::Form(r#"{"a":"'; rm -rf ~"}"#)
        )
        .unwrap()
        .ends_with(r#"--answer='{"a":"'\''; rm -rf ~"}'"#));
    }

    #[test]
    fn anything_that_could_reach_another_route_or_shell_word_is_refused() {
        let ask = Answer::Permission("once", None);
        for refused in [
            reply_command("ses_a b", Some("%7"), "per_one", HASH, WHEN, &ask),
            reply_command("other", Some("%7"), "per_one", HASH, WHEN, &ask),
            reply_command("ses_abc", Some("%7;x"), "per_one", HASH, WHEN, &ask),
            reply_command("ses_abc", Some("%7"), "per_one/reply", HASH, WHEN, &ask),
            reply_command("ses_abc", Some("%7"), "frm_one", HASH, WHEN, &ask),
            reply_command("ses_abc", Some("%7"), "per_one", "short", WHEN, &ask),
            reply_command("ses_abc", Some("%7"), "per_one", HASH, "now; id", &ask),
            reply_command(
                "ses_abc",
                Some("%7"),
                "per_one",
                HASH,
                WHEN,
                &Answer::Permission("once", Some("no")),
            ),
            reply_command(
                "ses_abc",
                Some("%7"),
                "per_one",
                HASH,
                WHEN,
                &Answer::Permission("reject", Some("two\nlines")),
            ),
            reply_command(
                "ses_abc",
                Some("%7"),
                "per_one",
                HASH,
                WHEN,
                &Answer::Permission("allow", None),
            ),
            reply_command(
                "ses_abc",
                Some("%7"),
                "frm_one",
                HASH,
                WHEN,
                &Answer::Form("[1]"),
            ),
            reply_command(
                "ses_abc",
                Some("%7"),
                "frm_one",
                HASH,
                WHEN,
                &Answer::Form(&format!(r#"{{"a":"{}"}}"#, "x".repeat(9000))),
            ),
        ] {
            assert!(refused.is_err());
        }
    }
}

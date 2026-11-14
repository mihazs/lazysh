/// A Herdr session name as Herdr itself accepts it: ASCII letters, digits, `.`, `_` and `-`, at most 64 bytes.
pub fn valid_herdr_session(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

/// The pane a companion hook reports, exactly as it is bound into an approval: tmux `%7`, Zellij
/// `zellij:<session>:<pane>` or Herdr `herdr:<session>:<pane id>` (the Herdr pane id carries a colon itself).
pub fn valid_pane_identity(value: &str) -> bool {
    let digits = |text: &str, max| {
        (1..=max).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
    };
    if let Some(pane) = value.strip_prefix('%') {
        return digits(pane, 31);
    }
    if let Some(rest) = value.strip_prefix("zellij:") {
        return rest.rsplit_once(':').is_some_and(|(session, pane)| {
            !session.is_empty()
                && session.len() <= 200
                && !session.chars().any(char::is_control)
                && digits(pane, 10)
        });
    }
    value
        .strip_prefix("herdr:")
        .and_then(|rest| rest.split_once(':'))
        .is_some_and(|(session, pane)| {
            valid_herdr_session(session) && crate::valid_herdr_id(pane, Some('p'))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_only_the_panes_a_hook_can_report() {
        for valid in [
            "%0",
            "%7",
            "zellij:work:2",
            "zellij:my:odd name:12",
            "herdr:default:w3V:p1",
            "herdr:work-2.a_b:w2E:pF",
        ] {
            assert!(valid_pane_identity(valid), "{valid}");
        }
        for invalid in [
            "",
            "%",
            "%x",
            "%7;cmd",
            "7",
            "zellij:work",
            "zellij::2",
            "zellij:work:",
            "zellij:work:terminal_2",
            "zellij:bad\nname:2",
            "zellij:work:12345678901",
            "herdr:default:p1",
            "herdr:default:w3V",
            "herdr:default:w3V:p1:extra",
            "herdr::w3V:p1",
            "herdr:a:b:w3V:p1",
            "herdr:default:w3v:p1",
            "tmux:%7",
        ] {
            assert!(!valid_pane_identity(invalid), "{invalid:?}");
        }
        assert!(!valid_pane_identity(&format!("%{}", "1".repeat(32))));
        assert!(!valid_pane_identity(&format!(
            "herdr:{}:w1:p1",
            "a".repeat(65)
        )));
        assert!(!valid_herdr_session(".."));
    }
}

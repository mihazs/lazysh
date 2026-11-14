//! The tmux-family server a hook's pane belongs to. A pane id such as `%7` is unique only inside one server, so a report from
//! `tmux -L work` and one from the default server can carry the same id; the server label tells them apart.

/// `tmux:<label>` or `rmux:<label>` for the server the pane's own environment names, else nothing.
pub fn pane_server() -> Option<String> {
    let var = |name| std::env::var(name).ok();
    server(
        var("TMUX_PANE").as_deref(),
        var("TMUX").as_deref(),
        var("RMUX_PANE").as_deref(),
        var("RMUX").as_deref(),
    )
}

/// Whether `value` is a server this module can name: `tmux:` or `rmux:` and a label as `tmux -L` accepts it.
pub(crate) fn valid(value: &str) -> bool {
    value
        .split_once(':')
        .is_some_and(|(kind, label)| matches!(kind, "tmux" | "rmux") && valid_label(label))
}

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 64
        && !matches!(label, "." | "..")
        && !label.contains('/')
        && !label.chars().any(char::is_control)
}

/// rmux exports `RMUX`, `RMUX_PANE`, `TMUX` and `TMUX_PANE` with the same values, so it is rmux only when both pairs agree; a tmux
/// started inside an rmux pane, or the reverse, rewrites `TMUX` and `TMUX_PANE` alone and stays tmux.
fn server(
    tmux_pane: Option<&str>,
    tmux: Option<&str>,
    rmux_pane: Option<&str>,
    rmux: Option<&str>,
) -> Option<String> {
    tmux_pane?;
    let (kind, env) = match (rmux_pane == tmux_pane, rmux.is_some() && rmux == tmux) {
        (true, true) => ("rmux", rmux?),
        _ => ("tmux", tmux?),
    };
    Some(format!("{kind}:{}", label(env, kind)?))
}

/// The `-L` label in `<socket path>,<server pid>,<session>` when the socket sits in the kind's own `<kind>-<uid>` directory.
/// A `-S` socket elsewhere has no label, and a Windows named pipe is not a path: both name no server.
fn label<'a>(env: &'a str, kind: &str) -> Option<&'a str> {
    let mut parts = env.rsplitn(3, ',');
    let (session, pid, path) = (parts.next()?, parts.next()?, parts.next()?);
    let number = |text: &str| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit());
    let (directory, label) = path.rsplit_once('/')?;
    let uid = directory
        .rsplit('/')
        .next()?
        .strip_prefix(kind)?
        .strip_prefix('-')?;
    (number(session) && number(pid) && number(uid) && valid_label(label)).then_some(label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_tmux_server_by_the_socket_label_and_nothing_else() {
        let tmux = |pane, env| server(pane, env, None, None);
        assert_eq!(
            tmux(Some("%4"), Some("/tmp/tmux-1000/default,812,0")),
            Some("tmux:default".into())
        );
        assert_eq!(
            tmux(Some("%4"), Some("/run/user/1000/tmux-1000/work,812,3")),
            Some("tmux:work".into())
        );
        assert_eq!(
            tmux(Some("%4"), Some("/tmp/tmux-1000/my,odd name,812,0")),
            Some("tmux:my,odd name".into())
        );
        for (pane, env) in [
            (None, Some("/tmp/tmux-1000/work,812,0")),
            (Some("%4"), None),
            (Some("%4"), Some("")),
            // -S: a socket outside tmux's own directory has no -L label.
            (Some("%4"), Some("/home/me/.sock/work,812,0")),
            (Some("%4"), Some("/tmp/tmux-1000/work")),
            (Some("%4"), Some("/tmp/tmux-1000/work,812")),
            (Some("%4"), Some("/tmp/tmux-1000/work,x,0")),
            (Some("%4"), Some("/tmp/tmux-1000/work,812,")),
            (Some("%4"), Some("/tmp/tmux-root/work,812,0")),
            (Some("%4"), Some("/tmp/rmux-1000/work,812,0")),
            (Some("%4"), Some("/tmp/tmux-1000/,812,0")),
            (Some("%4"), Some("/tmp/tmux-1000/..,812,0")),
            (Some("%4"), Some("/tmp/tmux-1000/bad\nname,812,0")),
            (Some("%4"), Some(r"\\.\pipe\rmux-work,812,0")),
        ] {
            assert_eq!(tmux(pane, env), None, "{pane:?} {env:?}");
        }
        let long = format!("/tmp/tmux-1000/{},812,0", "a".repeat(65));
        assert_eq!(tmux(Some("%4"), Some(&long)), None);
    }

    #[test]
    fn a_pane_is_rmux_only_when_rmux_and_tmux_agree() {
        let rmux = "/tmp/rmux-1000/native,123,0";
        assert_eq!(
            server(Some("%2"), Some(rmux), Some("%2"), Some(rmux)),
            Some("rmux:native".into())
        );
        // tmux inside an rmux pane: TMUX and TMUX_PANE are rewritten, RMUX and RMUX_PANE are inherited.
        let inner = "/tmp/tmux-1000/work,9,1";
        assert_eq!(
            server(Some("%5"), Some(inner), Some("%2"), Some(rmux)),
            Some("tmux:work".into())
        );
        assert_eq!(
            server(Some("%2"), Some(inner), Some("%2"), Some(rmux)),
            Some("tmux:work".into())
        );
        // An rmux socket always sits in rmux-<uid>, a tmux one in tmux-<uid>.
        assert_eq!(
            server(Some("%2"), Some(inner), Some("%2"), Some(inner)),
            None
        );
    }

    #[test]
    fn accepts_only_the_names_it_produces() {
        for value in ["tmux:default", "rmux:work", "tmux:odd name"] {
            assert!(valid(value), "{value}");
        }
        for value in [
            "",
            "tmux",
            "tmux:",
            "zellij:work",
            "tmux:..",
            "tmux:a/b",
            "tmux:\n",
            "TMUX:work",
        ] {
            assert!(!valid(value), "{value:?}");
        }
        assert!(!valid(&format!("tmux:{}", "a".repeat(65))));
    }
}

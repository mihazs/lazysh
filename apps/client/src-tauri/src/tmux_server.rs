//! Public tmux-family named-socket selection, never an arbitrary socket path.
use crate::{
    bindings::Bindings,
    ssh::{quote, AppState, Result, Session, SshError},
};
use std::sync::Arc;
/// The binary a tmux-family server is driven with; lazysh always names it, never a tmux shim.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Binary {
    #[default]
    Tmux,
    Rmux,
}
impl Binary {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Tmux => "tmux",
            Self::Rmux => "rmux",
        }
    }
    /// A session, window or pane name as a literal: tmux expands formats in it, so each `#` is doubled; rmux 0.10.0 stores a name as typed.
    pub(crate) fn literal_name(self, value: &str) -> String {
        match self {
            Self::Tmux => value.replace('#', "##"),
            Self::Rmux => value.to_owned(),
        }
    }
    /// A start directory (`-c`) as a literal: tmux doubles each `#`. rmux 0.10.0 does too in `new-session`, but `new-window` and
    /// `split-window` expand formats in a directory only when it holds `#{` (then `##` is `#`) and take any other as typed.
    /// shortcut: a `new-session` directory holding a style such as `#[b]` is not reached by doubling on rmux 0.10.0, upgrade with a measured escape for it.
    pub(crate) fn literal_directory(self, value: &str, new_session: bool) -> String {
        match self {
            Self::Rmux if !new_session && !value.contains("#{") => value.to_owned(),
            Self::Tmux | Self::Rmux => value.replace('#', "##"),
        }
    }
}
/// A `-L` label on one binary; `None` is the default server.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct TmuxServer {
    binary: Binary,
    label: Option<String>,
}
impl TmuxServer {
    #[cfg(test)]
    pub(crate) fn parse(name: Option<&str>) -> Result<Self> {
        Self::parse_for(Binary::Tmux, name)
    }
    pub(crate) fn parse_for(binary: Binary, name: Option<&str>) -> Result<Self> {
        match name {
            None | Some("default") => Ok(Self { binary, label: None }),
            Some(name) if !name.is_empty() && name.len() <= 64 && !matches!(name, "." | "..")
                && !name.contains('/') && !name.chars().any(char::is_control) => Ok(Self { binary, label: Some(name.into()) }),
            _ => Err(SshError::new("invalid_tmux_server", "tmux and rmux server names must be 1–64 UTF-8 bytes without slash/control characters, and not . or ..")),
        }
    }
    pub(crate) fn default_for(binary: Binary) -> Self {
        Self {
            binary,
            label: None,
        }
    }
    pub(crate) fn binary(&self) -> Binary {
        self.binary
    }
    pub(crate) fn label(&self) -> &str {
        self.label.as_deref().unwrap_or("default")
    }
    pub(crate) fn prefix(&self) -> String {
        format!("{} -u -L {}", self.binary.name(), quote(self.label()))
    }
    /// Read-only commands through this prefix never start a daemon (`-N`); discovery uses it for rmux.
    pub(crate) fn probe_prefix(&self) -> String {
        format!("{} -u -N -L {}", self.binary.name(), quote(self.label()))
    }
    /// The session an SSH id names and the server its commands address.
    pub(crate) async fn for_id(
        state: &AppState,
        id: &str,
        requested: Option<&str>,
        binary: Option<Binary>,
    ) -> Result<(Arc<Session>, Self)> {
        let session = state.session(id).await?;
        let server = Self::for_session(&session.bindings, requested, binary)?;
        Ok((session, server))
    }
    /// The server this terminal is bound to. `binary` names the family a caller expects; a different one never reuses the binding.
    pub(crate) fn for_session(
        bindings: &Bindings,
        requested: Option<&str>,
        binary: Option<Binary>,
    ) -> Result<Self> {
        let attached = bindings
            .tmux_server
            .lock()
            .map_err(|_| SshError::new("tmux_unavailable", "Cannot read tmux server context"))?;
        if let Some(bound) = attached.as_ref() {
            if (requested.is_some() && Self::parse_for(bound.binary, requested)? != *bound)
                || binary.is_some_and(|binary| binary != bound.binary)
            {
                return Err(SshError::new(
                    "tmux_server_mismatch",
                    "This terminal is attached to a different tmux or rmux server",
                ));
            }
            return Ok(bound.clone());
        }
        Self::parse_for(binary.unwrap_or_default(), requested)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn server_names_are_bounded_literal_basenames() {
        assert_eq!(
            TmuxServer::parse(None).unwrap(),
            TmuxServer::parse(Some("default")).unwrap()
        );
        for name in [
            "",
            ".",
            "..",
            "/tmp/socket",
            "a/b",
            "a\0b",
            "a\nb",
            &"世".repeat(22),
        ] {
            assert!(TmuxServer::parse(Some(name)).is_err());
        }
        for name in [
            "世界",
            "work space",
            "'$(touch NO);",
            "-option",
            &"a".repeat(64),
        ] {
            assert!(TmuxServer::parse(Some(name)).is_ok());
        }
        assert_eq!(
            TmuxServer::parse(Some("a'b")).unwrap().prefix(),
            "tmux -u -L 'a'\\''b'"
        );
    }
    #[test]
    fn rmux_doubles_the_hashes_of_a_window_directory_only_when_it_expands_formats() {
        for (typed, rmux) in [
            ("a#{x}b", "a##{x}b"),
            ("a##{x}b", "a####{x}b"),
            ("a#{x}##b", "a##{x}####b"),
            ("a##b", "a##b"),
            ("a#b", "a#b"),
            ("a#(echo hi)b", "a#(echo hi)b"),
        ] {
            assert_eq!(Binary::Rmux.literal_directory(typed, false), rmux);
            assert_eq!(Binary::Rmux.literal_name(typed), typed);
            for (binary, new_session) in [
                (Binary::Tmux, false),
                (Binary::Tmux, true),
                (Binary::Rmux, true),
            ] {
                assert_eq!(
                    binary.literal_directory(typed, new_session),
                    typed.replace('#', "##")
                );
            }
            assert_eq!(Binary::Tmux.literal_name(typed), typed.replace('#', "##"));
        }
    }
    #[test]
    fn rmux_servers_use_the_same_validated_labels_with_their_own_binary() {
        let rmux = |name| TmuxServer::parse_for(Binary::Rmux, name);
        assert_eq!(rmux(None).unwrap().prefix(), "rmux -u -L 'default'");
        assert_eq!(rmux(Some("a'b")).unwrap().prefix(), "rmux -u -L 'a'\\''b'");
        assert_ne!(rmux(None).unwrap(), TmuxServer::parse(None).unwrap());
        for name in ["", "..", "/tmp/rmux.sock", "a\nb"] {
            assert!(rmux(Some(name)).is_err());
        }
    }
}

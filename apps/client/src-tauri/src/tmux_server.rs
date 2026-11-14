//! Public tmux-family named-socket selection, never an arbitrary socket path.
use crate::ssh::{quote, Result, Session, SshError};
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
    /// The server this terminal is bound to. `binary` names the family a caller expects; a different one never reuses the binding.
    pub(crate) fn for_session(
        session: &Session,
        requested: Option<&str>,
        binary: Option<Binary>,
    ) -> Result<Self> {
        let attached = session
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

//! Public tmux named-socket selection, never an arbitrary socket path.
use crate::ssh::{quote, Result, Session, SshError};
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) enum TmuxServer {
    #[default]
    Default,
    Named(String),
}
impl TmuxServer {
    pub(crate) fn parse(name: Option<&str>) -> Result<Self> {
        match name {
            None | Some("default") => Ok(Self::Default),
            Some(name) if !name.is_empty() && name.len() <= 64 && !matches!(name, "." | "..")
                && !name.contains('/') && !name.chars().any(char::is_control) => Ok(Self::Named(name.into())),
            _ => Err(SshError::new("invalid_tmux_server", "tmux server names must be 1–64 UTF-8 bytes without slash/control characters, and not . or ..")),
        }
    }
    pub(crate) fn name(&self) -> &str {
        match self {
            Self::Default => "default",
            Self::Named(name) => name,
        }
    }
    pub(crate) fn prefix(&self) -> String {
        format!("tmux -u -L {}", quote(self.name()))
    }
    /// [`Self::prefix`] as exact argv words, for plans that quote each word itself.
    pub(crate) fn argv(&self) -> Vec<String> {
        ["tmux", "-u", "-L", self.name()]
            .map(str::to_owned)
            .to_vec()
    }
    pub(crate) fn for_session(session: &Session, requested: Option<&str>) -> Result<Self> {
        let attached = session
            .tmux_server
            .lock()
            .map_err(|_| SshError::new("tmux_unavailable", "Cannot read tmux server context"))?;
        if let Some(bound) = attached.as_ref() {
            if requested.is_some() && Self::parse(requested)? != *bound {
                return Err(SshError::new(
                    "tmux_server_mismatch",
                    "This terminal is attached to a different tmux server",
                ));
            }
            return Ok(bound.clone());
        }
        Self::parse(requested)
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
        assert_eq!(
            TmuxServer::parse(Some("a'b")).unwrap().argv(),
            ["tmux", "-u", "-L", "a'b"]
        );
    }
}

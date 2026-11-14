//! Public tmux named-socket selection, never an arbitrary socket path.
use crate::{
    bindings::Bindings,
    host::Cmd,
    ssh::{quote, Result, SshError},
};
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
    /// `tmux -u -L <server> <args>` as argv, for a local host to run and a remote one to quote.
    pub(crate) fn cmd(&self, args: &[&str]) -> Cmd {
        let mut argv = vec!["tmux", "-u", "-L", self.name()];
        argv.extend_from_slice(args);
        Cmd::new(&[], &argv)
    }
    /// The server a terminal is attached to, else the requested one.
    pub(crate) fn for_session(bindings: &Bindings, requested: Option<&str>) -> Result<Self> {
        let attached = bindings
            .tmux_server
            .lock()
            .map_err(|_| SshError::new("tmux_unavailable", "Cannot read tmux server context"))?
            .clone();
        Self::attached_or(attached, requested)
    }
    /// The attached server, which a request naming another one is refused for, else the requested one.
    pub(crate) fn attached_or(attached: Option<Self>, requested: Option<&str>) -> Result<Self> {
        if let Some(bound) = attached {
            if requested.is_some() && Self::parse(requested)? != bound {
                return Err(SshError::new(
                    "tmux_server_mismatch",
                    "This terminal is attached to a different tmux server",
                ));
            }
            return Ok(bound);
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
    }
    #[test]
    fn an_attached_server_wins_and_refuses_a_request_for_another() {
        let work = || Some(TmuxServer::Named("work".into()));
        let pick = TmuxServer::attached_or;
        assert_eq!(pick(work(), None).unwrap(), work().unwrap());
        assert_eq!(pick(work(), Some("work")).unwrap(), work().unwrap());
        assert_eq!(
            pick(work(), Some("other")).unwrap_err().kind(),
            "tmux_server_mismatch"
        );
        assert_eq!(pick(None, Some("other")).unwrap().name(), "other");
        assert_eq!(pick(None, None).unwrap(), TmuxServer::Default);
    }
}

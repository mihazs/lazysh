//! Public tmux-family named-socket selection, never an arbitrary socket path.
use crate::{
    bindings::Bindings,
    host::Cmd,
    ssh::{quote, Result, SshError},
};
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
    /// rmux interprets a `-c` path as a format differently per action; `l:` makes it literal,
    /// with its delimiter and escape character encoded so names cannot become formats or styles.
    pub(crate) fn literal_directory(self, value: &str) -> String {
        match self {
            // tmux (3.2a to 3.8) turns a doubled `#` before `[` into a style and starts in Home, and has no `l:` modifier
            // on every version: each `#` becomes a conditional that the format engine emits only after parsing.
            Self::Tmux if value.contains("#[") => value.replace('#', "#{?#{==:1,1},##,}"),
            Self::Tmux => value.replace('#', "##"),
            Self::Rmux => format!("#{{l:{}}}", value.replace('#', "##").replace('}', "#}")),
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
    /// [`Self::prefix`] as exact argv words, for plans that quote each word itself.
    pub(crate) fn argv(&self) -> Vec<String> {
        [self.binary.name(), "-u", "-L", self.label()]
            .map(str::to_owned)
            .to_vec()
    }
    /// `<binary> -u -L <server> <args>` as argv, for a local host to run and a remote one to quote.
    pub(crate) fn cmd(&self, args: &[&str]) -> Cmd {
        let argv = self.argv();
        let mut argv = argv.iter().map(String::as_str).collect::<Vec<_>>();
        argv.extend_from_slice(args);
        Cmd::new(&[], &argv)
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
            .map_err(|_| SshError::new("tmux_unavailable", "Cannot read tmux server context"))?
            .clone();
        Self::attached_or(attached, requested, binary)
    }
    /// The attached server, which a request naming another one (or another binary) is refused for, else the requested one.
    pub(crate) fn attached_or(
        attached: Option<Self>,
        requested: Option<&str>,
        binary: Option<Binary>,
    ) -> Result<Self> {
        if let Some(bound) = attached {
            if (requested.is_some() && Self::parse_for(bound.binary, requested)? != bound)
                || binary.is_some_and(|binary| binary != bound.binary)
            {
                return Err(SshError::new(
                    "tmux_server_mismatch",
                    "This terminal is attached to a different tmux or rmux server",
                ));
            }
            return Ok(bound);
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
        assert_eq!(
            TmuxServer::parse(Some("a'b")).unwrap().argv(),
            ["tmux", "-u", "-L", "a'b"]
        );
    }
    #[test]
    fn an_attached_server_wins_and_refuses_a_request_for_another() {
        let work = || Some(TmuxServer::parse(Some("work")).unwrap());
        let pick = |attached, requested| TmuxServer::attached_or(attached, requested, None);
        assert_eq!(pick(work(), None).unwrap(), work().unwrap());
        assert_eq!(pick(work(), Some("work")).unwrap(), work().unwrap());
        assert_eq!(
            pick(work(), Some("other")).unwrap_err().kind(),
            "tmux_server_mismatch"
        );
        assert_eq!(pick(None, Some("other")).unwrap().label(), "other");
        assert_eq!(pick(None, None).unwrap(), TmuxServer::default());
        // A binding never serves the other binary of the family.
        let rmux = Some(Binary::Rmux);
        assert_eq!(
            TmuxServer::attached_or(work(), None, rmux)
                .unwrap_err()
                .kind(),
            "tmux_server_mismatch"
        );
        let bound = TmuxServer::parse_for(Binary::Rmux, Some("lab")).unwrap();
        assert_eq!(
            TmuxServer::attached_or(Some(bound.clone()), Some("lab"), rmux).unwrap(),
            bound
        );
        assert_eq!(
            TmuxServer::attached_or(None, None, rmux).unwrap(),
            TmuxServer::default_for(Binary::Rmux)
        );
    }
    #[test]
    fn rmux_directory_uses_a_literal_format_with_escaped_delimiters() {
        for (typed, rmux) in [
            ("a#{x}b", "#{l:a##{x#}b}"),
            ("a#[b]c", "#{l:a##[b]c}"),
            ("a##b", "#{l:a####b}"),
            ("a#}b", "#{l:a###}b}"),
            ("a#(echo hi)b", "#{l:a##(echo hi)b}"),
        ] {
            assert_eq!(Binary::Rmux.literal_directory(typed), rmux);
            assert_eq!(Binary::Rmux.literal_name(typed), typed);
            assert_eq!(
                Binary::Tmux.literal_directory(typed),
                if typed.contains("#[") {
                    typed.replace('#', "#{?#{==:1,1},##,}")
                } else {
                    typed.replace('#', "##")
                }
            );
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

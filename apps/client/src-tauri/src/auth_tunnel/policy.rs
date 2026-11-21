//! Whether a sign-in tunnel may start: the evidence behind it, the consent given for it and the
//! ports that never start without a stronger confirmation. The decision is the only thing that
//! creates a tunnel; a printed URL, a listener or a launcher request never does by itself.
use crate::ssh::SshError;
use serde::Deserialize;

/// Per host, kept on the device by the settings (never synced). Ask is the default.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Policy {
    Ask,
    Always,
    Never,
}

/// What made the app think a sign-in needs a tunnel, strongest first.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Evidence {
    /// A host command asked to open this URL.
    Launcher,
    /// A URL in the terminal output redirects to this port.
    Url,
    /// Only a listener appeared. Dev servers look like this, so it never starts a tunnel.
    Listener,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Owner {
    SessionUser,
    /// A root-owned daemon such as NetBird's.
    OtherUser,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Family {
    V4,
    V6,
}

/// The sign-in the app found. It carries a port and a path, never a query, `code` or `state`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hint {
    pub port: u16,
    /// The callback path of the redirect, without a query. `/` when the URL has none.
    #[serde(default)]
    pub path: Option<String>,
    pub evidence: Evidence,
    /// A host listener on the port started around the time of the URL.
    #[serde(default)]
    pub confirmed: bool,
    #[serde(default = "unknown")]
    pub owner: Owner,
    /// The loopback family the listener evidence names, tried first on the host.
    #[serde(default)]
    pub family: Option<Family>,
}
fn unknown() -> Owner {
    Owner::Unknown
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Consent {
    /// The user chose Allow for this flow. `confirm_risky` answers the extra question a privileged
    /// or sensitive port asks.
    Allow {
        #[serde(default)]
        confirm_risky: bool,
    },
    /// The saved policy of the host decides, with nobody asked.
    Policy { policy: Policy },
}

/// A flow a host may open this often in `HOST_WINDOW` before Always stops applying.
pub(super) const HOST_STARTS: usize = 6;

const SENSITIVE: &[(u16, &str)] = &[
    (22, "SSH"),
    (23, "Telnet"),
    (25, "SMTP"),
    (53, "DNS"),
    (110, "POP3"),
    (143, "IMAP"),
    (389, "LDAP"),
    (445, "SMB"),
    (1433, "SQL Server"),
    (1521, "Oracle"),
    (2049, "NFS"),
    (2375, "the Docker API"),
    (2376, "the Docker API"),
    (2379, "etcd"),
    (3306, "MySQL"),
    (3389, "Remote Desktop"),
    (5432, "PostgreSQL"),
    (5900, "VNC"),
    (6379, "Redis"),
    (8500, "Consul"),
    (9200, "Elasticsearch"),
    (11211, "Memcached"),
    (27017, "MongoDB"),
];

fn service(port: u16) -> Option<&'static str> {
    SENSITIVE
        .iter()
        .find(|(known, _)| *known == port)
        .map(|(_, name)| *name)
}

/// Decides whether `hint` may start under `consent`. `ssh_port` is the port of the host's SSH
/// server, which is never tunnelled, and `recent_starts` counts this host's flows in the window.
pub(super) fn admit(
    hint: &Hint,
    consent: Consent,
    ssh_port: Option<u16>,
    recent_starts: usize,
) -> Result<(), SshError> {
    if hint.port == 0 {
        return Err(SshError::new(
            "invalid_port",
            "Enter a port from 1 to 65535",
        ));
    }
    if Some(hint.port) == ssh_port {
        return Err(SshError::new(
            "auth_tunnel_ssh_port",
            "The host's SSH port is never tunnelled",
        ));
    }
    if hint.evidence == Evidence::Listener {
        return Err(SshError::new(
            "auth_tunnel_no_url",
            "A listener alone does not start a sign-in tunnel; open a preview for it instead",
        ));
    }
    let risky = hint.port < 1024 || service(hint.port).is_some();
    match consent {
        Consent::Policy {
            policy: Policy::Never,
        } => Err(SshError::new(
            "auth_tunnel_denied",
            "Sign-in tunnels are turned off for this host",
        )),
        Consent::Policy {
            policy: Policy::Ask,
        } => Err(consent_required("Ask is the policy of this host")),
        Consent::Policy {
            policy: Policy::Always,
        } => {
            let automatic = !risky
                && hint.owner != Owner::OtherUser
                && (hint.confirmed || hint.evidence == Evidence::Launcher)
                && recent_starts < HOST_STARTS;
            if automatic {
                Ok(())
            } else {
                Err(consent_required(
                    "this sign-in needs your answer even though the policy is Always",
                ))
            }
        }
        Consent::Allow { confirm_risky } if risky && !confirm_risky => Err(SshError::new(
            "auth_tunnel_risky_port",
            match service(hint.port) {
                Some(name) => format!(
                    "Port {} is {name}, not a sign-in page. Confirm it separately to continue",
                    hint.port
                ),
                None => format!(
                    "Port {} is a privileged port. Confirm it separately to continue",
                    hint.port
                ),
            },
        )),
        Consent::Allow { .. } => Ok(()),
    }
}

fn consent_required(why: &str) -> SshError {
    SshError::new(
        "auth_tunnel_consent_required",
        format!("Ask the user first: {why}"),
    )
}

//! Closed error vocabulary: classifications only, never request or response text.
use std::{error::Error as StdError, fmt};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// DNS, connect, timeout, TLS handshake, interrupted body, HTTP 5xx, rate limit.
    Network,
    /// No compatible verified release is published.
    Unavailable,
    /// Digest, size, pin or commit disagreement, or a transport that must not be trusted.
    Verification,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Detail {
    Dns,
    Connect,
    Timeout,
    Tls,
    Http,
    RateLimited,
    Interrupted,
    DigestMismatch,
    SizeMismatch,
    PinMismatch,
    RedirectRefused,
    InsecureUrl,
    CommitMismatch,
}
impl Detail {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dns => "dns",
            Self::Connect => "connect",
            Self::Timeout => "timeout",
            Self::Tls => "tls",
            Self::Http => "http",
            Self::RateLimited => "rateLimited",
            Self::Interrupted => "interrupted",
            Self::DigestMismatch => "digestMismatch",
            Self::SizeMismatch => "sizeMismatch",
            Self::PinMismatch => "pinMismatch",
            Self::RedirectRefused => "redirectRefused",
            Self::InsecureUrl => "insecureUrl",
            Self::CommitMismatch => "commitMismatch",
        }
    }
}
#[derive(Debug, PartialEq, Eq)]
pub struct Error {
    pub kind: Kind,
    pub detail: Option<Detail>,
    pub retry_after_seconds: Option<u64>,
}
impl Error {
    pub fn unavailable() -> Self {
        Self {
            kind: Kind::Unavailable,
            detail: None,
            retry_after_seconds: None,
        }
    }
    pub fn network(detail: Detail) -> Self {
        Self {
            kind: Kind::Network,
            detail: Some(detail),
            retry_after_seconds: None,
        }
    }
    pub fn verification(detail: Detail) -> Self {
        Self {
            kind: Kind::Verification,
            detail: Some(detail),
            retry_after_seconds: None,
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self.kind {
            Kind::Network => "Companion release server unreachable",
            Kind::Unavailable => "No compatible verified companion release is published",
            Kind::Verification => "Companion release verification failed",
        })
    }
}
impl StdError for Error {}
pub type Result<T> = std::result::Result<T, Error>;

/// Carried through reqwest's redirect policy so a refusal keeps its classification.
#[derive(Debug)]
pub(crate) struct Refused(pub Detail);
impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Unsupported publisher redirect")
    }
}
impl StdError for Refused {}

/// Classify a transport failure. Only the error chain's types and fixed markers are read;
/// reqwest's own text carries the request URL and is never kept.
pub(crate) fn transport(error: reqwest::Error) -> Error {
    let mut chain = Vec::new();
    let mut source: Option<&(dyn StdError + 'static)> = Some(&error);
    while let Some(link) = source {
        if let Some(Refused(detail)) = link.downcast_ref::<Refused>() {
            return Error::verification(*detail);
        }
        chain.push(link.to_string().to_ascii_lowercase());
        source = link.source();
    }
    let marker = |text: &str| chain.iter().any(|link| link.contains(text));
    if marker("invalid peer certificate") {
        Error::verification(Detail::Tls)
    } else if error.is_timeout() {
        Error::network(Detail::Timeout)
    } else if !error.is_connect() {
        // The connection was established and then lost, or the request could not complete.
        Error::network(Detail::Interrupted)
    } else if marker("dns error") || marker("failed to lookup address") {
        Error::network(Detail::Dns)
    } else if marker("tls") || marker("handshake") {
        Error::network(Detail::Tls)
    } else {
        Error::network(Detail::Connect)
    }
}

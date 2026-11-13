//! Companion release resolution shared by `lazysh-agent update` and the app's installer.
//!
//! Trust is unchanged from the app's installer: TLS to GitHub plus the release pipeline. The chain in
//! [`metadata`] pins the digest from the per-target receipt of `release.json`, cross-checked against
//! GitHub's own asset digest and size, the manifest commit and the tag's commit.
mod error;
mod http;
mod metadata;

#[cfg(feature = "test-support")]
pub mod fake;

pub use error::{Detail, Error, Kind, Result};
#[cfg(feature = "test-endpoint")]
pub use http::Endpoint;
pub use http::{Body, Config, Download, Publisher, Which};
pub use metadata::{extension, sha, version, Selection, MAX_BINARY, TARGETS};

#[cfg(test)]
mod tests;

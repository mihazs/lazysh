//! Release lookup for the app's installer. The verification chain, HTTPS policy and download live in
//! `lazysh-companion-release`, shared with `lazysh-agent update`.
use super::*;
use lazysh_companion_release as shared;
pub(super) use shared::{version, Selection, MAX_BINARY};
use std::time::Duration;

fn rejected() -> SshError {
    error(
        "companion_release_unavailable",
        "No compatible verified companion installer is published",
    )
}
// Codes contain only local classifications, never request or response text.
fn recheck_error(code: &str) -> SshError {
    SshError::new(
        "companion_release_unavailable",
        format!("lazysh-tag-recheck-v1:{code}"),
    )
}
pub(super) struct Publisher {
    inner: shared::Publisher,
    #[cfg(test)]
    fixture: Option<(Selection, Vec<u8>)>,
}
impl Publisher {
    #[cfg(test)]
    pub(super) fn owned(bytes: Vec<u8>, version: String) -> Self {
        assert!(!bytes.is_empty() && bytes.len() as u64 <= MAX_BINARY);
        assert!(self::version(&version).is_some());
        let digest = shared::sha(&bytes);
        let selected = Selection {
            tag: format!("v{version}"),
            version,
            sha: "a".repeat(40),
            target: "linux-agent-x64".into(),
            asset_name: String::new(),
            asset_id: 1,
            digest,
            bytes: bytes.len() as u64,
        };
        let mut publisher = Self::new().unwrap();
        publisher.fixture = Some((selected, bytes));
        publisher
    }

    pub fn new() -> Result<Self> {
        let inner = shared::Publisher::new(shared::Config {
            user_agent: "lazysh-companion-installer".into(),
            env_proxy: false,
            timeout: Duration::from_secs(60),
            idle_timeout: None,
        })
        .map_err(|_| rejected())?;
        Ok(Self {
            inner,
            #[cfg(test)]
            fixture: None,
        })
    }
    pub async fn select(&self, target: &str) -> Result<Selection> {
        #[cfg(test)]
        if let Some((selection, _)) = &self.fixture {
            let _ = target;
            return Ok(selection.clone());
        }
        // The app installs only onto a positively identified Unix shell.
        if !matches!(
            target,
            "linux-agent-x64" | "linux-agent-arm64" | "macos-agent-x64" | "macos-agent-arm64"
        ) {
            return Err(rejected());
        }
        self.inner
            .select(target, shared::Which::Stable)
            .await
            .map_err(|_| rejected())
    }
    pub async fn download(&self, selection: &Selection) -> Result<Vec<u8>> {
        #[cfg(test)]
        if let Some((_, bytes)) = &self.fixture {
            if shared::sha(bytes) != selection.digest || bytes.len() as u64 != selection.bytes {
                return Err(rejected());
            }
            return Ok(bytes.clone());
        }
        let mut download = self
            .inner
            .download(selection)
            .await
            .map_err(|_| rejected())?;
        let mut bytes = Vec::with_capacity(selection.bytes as usize);
        while let Some(chunk) = download.chunk().await.map_err(|_| rejected())? {
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    pub async fn recheck(&self, selection: &Selection) -> Result<()> {
        #[cfg(test)]
        if self.fixture.is_some() {
            return Ok(());
        }
        self.inner
            .recheck(selection)
            .await
            .map_err(|code| recheck_error(&code))
    }
}

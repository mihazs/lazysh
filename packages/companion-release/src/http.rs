//! The bounded HTTPS client. It talks to GitHub's API only and re-checks every redirect.
use crate::{
    error::{transport, Detail, Error, Refused, Result},
    metadata::{
        manifest_asset, select, tag_version, Manifest, Reference, Release, Selection, MAX_BINARY,
        MAX_MANIFEST, MAX_REFERENCE, MAX_RELEASE, MAX_RELEASES,
    },
};
use bytes::Bytes;
use reqwest::{redirect::Policy, Client, Proxy, Response, Url};
use sha2::{Digest, Sha256};
use std::time::Duration;

const REPOSITORY: &str = "https://api.github.com/repos/mihazs/lazysh/";
const MAX_RETRY_AFTER: u64 = 86_400;

pub struct Config {
    pub user_agent: String,
    /// Tunnel through `HTTPS_PROXY`/`https_proxy` (TLS stays end to end). Otherwise proxies are ignored.
    pub env_proxy: bool,
    /// Whole-request limit.
    pub timeout: Duration,
    /// Limit between two reads of one body.
    pub idle_timeout: Option<Duration>,
}
/// A local HTTPS API root (ending in `/repos/mihazs/lazysh/`) trusted through its own CA.
#[cfg(feature = "test-endpoint")]
pub struct Endpoint {
    pub api: String,
    pub ca_pem: Vec<u8>,
}
pub enum Which<'a> {
    /// The release GitHub marks latest: not a draft, not a prerelease.
    Stable,
    /// The highest `X.Y.Z` tag among the newest releases that is not a draft.
    Highest,
    /// This exact `X.Y.Z`; a prerelease is accepted only when `prerelease` is set.
    Tag { version: &'a str, prerelease: bool },
}

#[derive(Clone)]
struct Rules {
    #[cfg(feature = "test-endpoint")]
    local: Option<Url>,
}
fn clean(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
}
pub(crate) fn allowed(url: &Url) -> bool {
    clean(url)
        && url.port().is_none_or(|p| p == 443)
        && match url.host_str() {
            Some("api.github.com") => url.path().starts_with("/repos/mihazs/lazysh/"),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
            _ => false,
        }
}
impl Rules {
    fn check(&self, url: &Url) -> std::result::Result<(), Detail> {
        if url.scheme() != "https" {
            return Err(Detail::InsecureUrl);
        }
        #[cfg(feature = "test-endpoint")]
        if let Some(local) = &self.local {
            return if clean(url) && url.origin() == local.origin() {
                Ok(())
            } else {
                Err(Detail::RedirectRefused)
            };
        }
        allowed(url).then_some(()).ok_or(Detail::RedirectRefused)
    }
}

fn retry_after(response: &Response) -> Option<u64> {
    let seconds = response
        .headers()
        .get("retry-after")?
        .to_str()
        .ok()?
        .parse::<u64>()
        .ok()?;
    Some(seconds.min(MAX_RETRY_AFTER))
}
fn status(response: &Response) -> Result<()> {
    match response.status().as_u16() {
        200 => Ok(()),
        403 | 429 => Err(Error {
            retry_after_seconds: retry_after(response),
            ..Error::network(Detail::RateLimited)
        }),
        500..=599 => Err(Error::network(Detail::Http)),
        _ => Err(Error::unavailable()),
    }
}
fn interrupted(error: reqwest::Error) -> Error {
    Error::network(if error.is_timeout() {
        Detail::Timeout
    } else {
        Detail::Interrupted
    })
}

/// A response body that can never exceed `maximum` and must be exactly `expected` long.
pub struct Body {
    response: Response,
    maximum: u64,
    expected: Option<u64>,
    received: u64,
}
impl Body {
    pub(crate) fn new(response: Response, maximum: u64, expected: Option<u64>) -> Result<Self> {
        status(&response)?;
        if response
            .headers()
            .get("content-encoding")
            .is_some_and(|v| v != "identity")
        {
            return Err(Error::unavailable());
        }
        let declared = response
            .headers()
            .get("content-length")
            .map(|v| {
                v.to_str()
                    .ok()
                    .and_then(|s| s.parse::<u64>().ok())
                    .ok_or_else(Error::unavailable)
            })
            .transpose()?;
        if declared.is_some_and(|n| n > maximum || expected.is_some_and(|e| e != n))
            || expected.is_some_and(|n| n > maximum)
        {
            return Err(Error::verification(Detail::SizeMismatch));
        }
        Ok(Self {
            response,
            maximum,
            expected,
            received: 0,
        })
    }
    /// The next chunk, or `None` once the whole body arrived with the exact length.
    pub async fn chunk(&mut self) -> Result<Option<Bytes>> {
        let Some(chunk) = self.response.chunk().await.map_err(interrupted)? else {
            return if self.expected.is_some_and(|e| e != self.received) {
                Err(Error::verification(Detail::SizeMismatch))
            } else {
                Ok(None)
            };
        };
        self.received += chunk.len() as u64;
        if self.received > self.maximum {
            return Err(Error::verification(Detail::SizeMismatch));
        }
        Ok(Some(chunk))
    }
    async fn collect(mut self) -> Result<Vec<u8>> {
        let mut bytes = Vec::new();
        if let Some(length) = self.expected {
            bytes
                .try_reserve_exact(length as usize)
                .map_err(|_| Error::unavailable())?;
        }
        while let Some(chunk) = self.chunk().await? {
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
}
/// A companion download. `chunk` returns `Ok(None)` only after the byte count and SHA-256 matched.
pub struct Download {
    body: Body,
    hasher: Sha256,
    digest: String,
}
impl Download {
    pub async fn chunk(&mut self) -> Result<Option<Bytes>> {
        match self.body.chunk().await? {
            Some(chunk) => {
                self.hasher.update(&chunk);
                Ok(Some(chunk))
            }
            None if format!("{:x}", self.hasher.clone().finalize()) == self.digest => Ok(None),
            None => Err(Error::verification(Detail::DigestMismatch)),
        }
    }
}

pub struct Publisher {
    client: Client,
    api: Url,
}
impl Publisher {
    pub fn new(config: Config) -> Result<Self> {
        Self::build(
            config,
            Url::parse(REPOSITORY).map_err(|_| Error::unavailable())?,
            Rules {
                #[cfg(feature = "test-endpoint")]
                local: None,
            },
            None,
        )
    }
    #[cfg(feature = "test-endpoint")]
    pub fn with_endpoint(config: Config, endpoint: Endpoint) -> Result<Self> {
        let api = Url::parse(&endpoint.api).map_err(|_| Error::unavailable())?;
        let local = Rules {
            local: Some(api.clone()),
        };
        local.check(&api).map_err(Error::verification)?;
        let certificate =
            reqwest::Certificate::from_pem(&endpoint.ca_pem).map_err(|_| Error::unavailable())?;
        Self::build(config, api, local, Some(certificate))
    }
    fn build(
        config: Config,
        api: Url,
        rules: Rules,
        certificate: Option<reqwest::Certificate>,
    ) -> Result<Self> {
        let mut builder = Client::builder()
            .user_agent(config.user_agent)
            .https_only(true)
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(config.timeout)
            .redirect(Policy::custom(move |attempt| {
                if attempt.previous().len() > 3 {
                    attempt.error(Refused(Detail::RedirectRefused))
                } else if let Err(detail) = rules.check(attempt.url()) {
                    attempt.error(Refused(detail))
                } else {
                    attempt.follow()
                }
            }));
        if let Some(idle) = config.idle_timeout {
            builder = builder.read_timeout(idle);
        }
        if let Some(certificate) = certificate {
            builder = builder.add_root_certificate(certificate);
        }
        if config.env_proxy {
            if let Some(proxy) = ["HTTPS_PROXY", "https_proxy"]
                .iter()
                .find_map(|name| std::env::var(name).ok().filter(|v| !v.is_empty()))
            {
                builder = builder
                    .proxy(Proxy::https(proxy).map_err(|_| Error::network(Detail::Connect))?);
            }
        }
        Ok(Self {
            client: builder.build().map_err(|_| Error::unavailable())?,
            api,
        })
    }
    fn request(&self, path: &str, binary: bool) -> Result<reqwest::RequestBuilder> {
        let url = self.api.join(path).map_err(|_| Error::unavailable())?;
        Ok(self
            .client
            .get(url)
            .header(
                "Accept",
                if binary {
                    "application/octet-stream"
                } else {
                    "application/vnd.github+json"
                },
            )
            .header("Accept-Encoding", "identity"))
    }
    async fn body(
        &self,
        path: &str,
        maximum: u64,
        expected: Option<u64>,
        binary: bool,
    ) -> Result<Body> {
        let response = self
            .request(path, binary)?
            .send()
            .await
            .map_err(transport)?;
        Body::new(response, maximum, expected)
    }
    async fn json<T: serde::de::DeserializeOwned>(&self, path: &str, maximum: u64) -> Result<T> {
        let bytes = self
            .body(path, maximum, None, false)
            .await?
            .collect()
            .await?;
        serde_json::from_slice(&bytes).map_err(|_| Error::unavailable())
    }
    /// Resolve and verify the companion asset for `target`.
    pub async fn select(&self, target: &str, which: Which<'_>) -> Result<Selection> {
        let (release, prerelease) = match which {
            Which::Stable => (self.json("releases/latest", MAX_RELEASE).await?, false),
            Which::Highest => {
                let releases: Vec<Release> =
                    self.json("releases?per_page=10", MAX_RELEASES).await?;
                let highest = releases
                    .into_iter()
                    .filter(|release| !release.draft)
                    .filter_map(|release| {
                        let version = crate::version(tag_version(&release).ok()?)?;
                        Some((version, release))
                    })
                    .max_by_key(|(version, _)| *version)
                    .ok_or_else(Error::unavailable)?;
                (highest.1, true)
            }
            Which::Tag {
                version,
                prerelease,
            } if crate::version(version).is_some() => (
                self.json(&format!("releases/tags/v{version}"), MAX_RELEASE)
                    .await?,
                prerelease,
            ),
            Which::Tag { .. } => return Err(Error::unavailable()),
        };
        if release.assets.len() > 32 {
            return Err(Error::unavailable());
        }
        let version = tag_version(&release)?.to_owned();
        let reference: Reference = self
            .json(&format!("git/ref/tags/v{version}"), MAX_REFERENCE)
            .await?;
        let (id, size, expected) = manifest_asset(&release)?;
        let bytes = self
            .body(
                &format!("releases/assets/{id}"),
                MAX_MANIFEST,
                Some(size),
                true,
            )
            .await?
            .collect()
            .await?;
        if crate::sha(&bytes) != expected {
            return Err(Error::verification(Detail::DigestMismatch));
        }
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|_| Error::unavailable())?;
        select(release, manifest, reference, target, prerelease)
    }
    /// Start downloading the verified asset; nothing is trusted until `chunk` returns `Ok(None)`.
    pub async fn download(&self, selection: &Selection) -> Result<Download> {
        Ok(Download {
            body: self
                .body(
                    &format!("releases/assets/{}", selection.asset_id),
                    MAX_BINARY,
                    Some(selection.bytes),
                    true,
                )
                .await?,
            hasher: Sha256::new(),
            digest: selection.digest.clone(),
        })
    }
    /// Confirm the tag still points at the selected commit. `Err` is a fixed local code.
    pub async fn recheck(&self, selection: &Selection) -> std::result::Result<(), String> {
        let request = self
            .request(&format!("git/ref/tags/v{}", selection.version), false)
            .map_err(|_| "transport:request".to_owned())?;
        let response = request.send().await.map_err(recheck_transport)?;
        recheck_reference(recheck_body(response).await?, selection)
    }
}

// Codes contain only local classifications, never request or response text.
pub(crate) fn recheck_transport(error: reqwest::Error) -> String {
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connect"
    } else if error.is_redirect() {
        "redirect"
    } else if error.is_body() {
        "body"
    } else if error.is_decode() {
        "decode"
    } else if error.is_request() {
        "request"
    } else {
        "other"
    };
    format!("transport:{category}")
}
pub(crate) async fn recheck_body(response: Response) -> std::result::Result<Reference, String> {
    let status = response.status().as_u16();
    if status != 200 {
        return Err(if (100..=599).contains(&status) {
            format!("status:{status}")
        } else {
            "status:other".into()
        });
    }
    let bytes = Body::new(response, MAX_REFERENCE, None)
        .map_err(|_| "body".to_owned())?
        .collect()
        .await
        .map_err(|_| "body".to_owned())?;
    serde_json::from_slice(&bytes).map_err(|_| "json".to_owned())
}
pub(crate) fn recheck_reference(
    reference: Reference,
    selection: &Selection,
) -> std::result::Result<(), String> {
    let code = if reference.r#ref != format!("refs/tags/v{}", selection.version) {
        "ref"
    } else if reference.object.r#type != "commit" {
        "type"
    } else if reference.object.sha != selection.sha {
        "sha"
    } else {
        return Ok(());
    };
    Err(code.into())
}

use super::*;
use reqwest::{redirect::Policy, Client, Url};
use sha2::{Digest, Sha256};
pub(super) const MAX_BINARY: u64 = 64 * 1024 * 1024;
const REPOSITORY: &str = "https://api.github.com/repos/mihazs/lazysh/";
#[derive(Clone, Deserialize)]
struct Asset {
    id: u64,
    size: u64,
    digest: Option<String>,
    state: String,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct Reference {
    r#ref: String,
    object: Object,
}
#[derive(Deserialize)]
struct Object {
    r#type: String,
    sha: String,
}
#[derive(Deserialize)]
struct Manifest {
    schema: u8,
    sha: String,
    version: String,
    platforms: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
struct Receipt {
    schema: u8,
    sha: String,
    version: String,
    target: String,
    signing: String,
    files: Vec<Package>,
}
#[derive(Deserialize)]
struct Package {
    name: String,
    bytes: u64,
    sha256: String,
}
#[derive(Clone)]
pub(super) struct Selection {
    pub version: String,
    pub sha: String,
    pub digest: String,
    pub bytes: u64,
    asset: Asset,
}
pub(super) fn version(value: &str) -> Option<[u64; 3]> {
    let mut result = [0; 3];
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3 {
        return None;
    }
    for (i, part) in parts.into_iter().enumerate() {
        if part.is_empty()
            || (part.len() > 1 && part.starts_with('0'))
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return None;
        }
        result[i] = part.parse().ok()?;
    }
    Some(result)
}
fn digest(value: &str) -> bool {
    lazysh_common::valid_sha256(value)
}
pub(super) fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
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
fn recheck_transport(error: reqwest::Error) -> SshError {
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
    recheck_error(&format!("transport:{category}"))
}
async fn recheck_body(response: reqwest::Response) -> Result<Reference> {
    if response.status() != reqwest::StatusCode::OK {
        let status = response.status().as_u16();
        return Err(recheck_error(&if (100..=599).contains(&status) {
            format!("status:{status}")
        } else {
            "status:other".into()
        }));
    }
    let bytes = read_body(response, 16_384, None)
        .await
        .map_err(|_| recheck_error("body"))?;
    serde_json::from_slice(&bytes).map_err(|_| recheck_error("json"))
}
fn recheck_reference(reference: Reference, selection: &Selection) -> Result<()> {
    let code = if reference.r#ref != format!("refs/tags/v{}", selection.version) {
        "ref"
    } else if reference.object.r#type != "commit" {
        "type"
    } else if reference.object.sha != selection.sha {
        "sha"
    } else {
        return Ok(());
    };
    Err(recheck_error(code))
}
fn asset_digest(asset: &Asset) -> Result<&str> {
    let digest = asset
        .digest
        .as_deref()
        .and_then(|v| v.strip_prefix("sha256:"))
        .filter(|v| digest(v))
        .ok_or_else(rejected)?;
    if asset.id == 0 || asset.state != "uploaded" || asset.size == 0 {
        return Err(rejected());
    }
    Ok(digest)
}
#[cfg(test)]
fn extensions(target: &str) -> Option<&'static [&'static str]> {
    Some(match target {
        "linux-x64" => &["deb", "AppImage"],
        "windows-x64" => &["exe"],
        "android-google-arm64" | "android-foss-arm64" => &["apk"],
        "linux-agent-x64" | "linux-agent-arm64" | "macos-agent-x64" | "macos-agent-arm64" => {
            &["bin"]
        }
        "windows-agent-x64" => &["exe"],
        _ => return None,
    })
}
fn named_asset(assets: &[serde_json::Value], name: &str) -> Result<Asset> {
    let selected = assets
        .iter()
        .filter(|v| v.get("name").and_then(|v| v.as_str()) == Some(name))
        .collect::<Vec<_>>();
    if selected.len() != 1 {
        return Err(rejected());
    }
    serde_json::from_value(selected[0].clone()).map_err(|_| rejected())
}
fn select(
    release: Release,
    manifest: Manifest,
    reference: Reference,
    target: &str,
) -> Result<Selection> {
    let version = release
        .tag_name
        .strip_prefix('v')
        .filter(|v| self::version(v).is_some())
        .ok_or_else(rejected)?;
    if release.draft
        || release.prerelease
        || release.assets.len() > 32
        || manifest.platforms.len() > 32
        || manifest.schema != 1
        || manifest.version != version
        || manifest.sha.len() != 40
        || !manifest
            .sha
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        || reference.r#ref != format!("refs/tags/{}", release.tag_name)
        || reference.object.r#type != "commit"
        || reference.object.sha != manifest.sha
    {
        return Err(rejected());
    }
    if !matches!(
        target,
        "linux-agent-x64" | "linux-agent-arm64" | "macos-agent-x64" | "macos-agent-arm64"
    ) {
        return Err(rejected());
    }
    let entries = manifest
        .platforms
        .iter()
        .filter(|v| v.get("target").and_then(|v| v.as_str()) == Some(target))
        .collect::<Vec<_>>();
    if entries.len() != 1 {
        return Err(rejected());
    }
    let receipt: Receipt = serde_json::from_value(entries[0].clone()).map_err(|_| rejected())?;
    let signing = if target.starts_with("macos-") {
        matches!(receipt.signing.as_str(), "signed" | "ad-hoc")
    } else {
        matches!(receipt.signing.as_str(), "signed" | "unsigned")
    };
    if receipt.schema != 1
        || receipt.sha != manifest.sha
        || receipt.version != version
        || receipt.target != target
        || receipt.files.len() != 1
        || !signing
    {
        return Err(rejected());
    }
    let package = receipt.files.into_iter().next().unwrap();
    if package.name != format!("lazysh-{version}-{target}.bin")
        || package.bytes == 0
        || package.bytes > MAX_BINARY
        || !digest(&package.sha256)
    {
        return Err(rejected());
    }
    let asset = named_asset(&release.assets, &package.name)?;
    if asset.size != package.bytes || asset_digest(&asset)? != package.sha256 {
        return Err(rejected());
    }
    Ok(Selection {
        version: version.into(),
        sha: manifest.sha,
        digest: package.sha256,
        bytes: package.bytes,
        asset,
    })
}
fn allowed(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && url.port().is_none_or(|p| p == 443)
        && match url.host_str() {
            Some("api.github.com") => url.path().starts_with("/repos/mihazs/lazysh/"),
            Some("release-assets.githubusercontent.com" | "objects.githubusercontent.com") => true,
            _ => false,
        }
}
async fn read_body(
    mut response: reqwest::Response,
    maximum: u64,
    expected: Option<u64>,
) -> Result<Vec<u8>> {
    let declared = response
        .headers()
        .get("content-length")
        .map(|v| {
            v.to_str()
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .ok_or_else(rejected)
        })
        .transpose()?;
    if declared.is_some_and(|n| n > maximum || expected.is_some_and(|e| e != n)) {
        return Err(rejected());
    }
    if response.status() != reqwest::StatusCode::OK
        || response
            .headers()
            .get("content-encoding")
            .is_some_and(|v| v != "identity")
        || response
            .content_length()
            .is_some_and(|n| n > maximum || expected.is_some_and(|e| e != n))
    {
        return Err(rejected());
    }
    if expected.is_some_and(|n| n > maximum) {
        return Err(rejected());
    }
    let mut bytes = Vec::new();
    if let Some(length) = expected {
        bytes
            .try_reserve_exact(length as usize)
            .map_err(|_| rejected())?;
    }
    while let Some(chunk) = response.chunk().await.map_err(|_| rejected())? {
        if bytes.len() as u64 + chunk.len() as u64 > maximum {
            return Err(rejected());
        }
        bytes.extend_from_slice(&chunk);
    }
    if expected.is_some_and(|e| e != bytes.len() as u64) {
        return Err(rejected());
    }
    Ok(bytes)
}
pub(super) struct Publisher {
    client: Client,
    #[cfg(test)]
    fixture: Option<(Selection, Vec<u8>)>,
}
impl Publisher {
    #[cfg(test)]
    pub(super) fn owned(bytes: Vec<u8>, version: String) -> Self {
        assert!(!bytes.is_empty() && bytes.len() as u64 <= MAX_BINARY);
        assert!(self::version(&version).is_some());
        let selected = Selection {
            version,
            sha: "a".repeat(40),
            digest: sha(&bytes),
            bytes: bytes.len() as u64,
            asset: Asset {
                id: 1,
                size: bytes.len() as u64,
                digest: Some(format!("sha256:{}", sha(&bytes))),
                state: "uploaded".into(),
            },
        };
        let mut publisher = Self::new().unwrap();
        publisher.fixture = Some((selected, bytes));
        publisher
    }

    pub fn new() -> Result<Self> {
        let client = Client::builder()
            .user_agent("lazysh-companion-installer")
            .https_only(true)
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() > 3 || !allowed(attempt.url()) {
                    attempt.error("Unsupported publisher redirect")
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .map_err(|_| rejected())?;
        Ok(Self {
            client,
            #[cfg(test)]
            fixture: None,
        })
    }
    fn request(&self, path: &str, binary: bool) -> reqwest::RequestBuilder {
        self.client
            .get(format!("{REPOSITORY}{path}"))
            .header(
                "Accept",
                if binary {
                    "application/octet-stream"
                } else {
                    "application/vnd.github+json"
                },
            )
            .header("Accept-Encoding", "identity")
    }
    async fn get(
        &self,
        path: &str,
        maximum: u64,
        expected: Option<u64>,
        binary: bool,
    ) -> Result<Vec<u8>> {
        let response = self
            .request(path, binary)
            .send()
            .await
            .map_err(|_| rejected())?;
        read_body(response, maximum, expected).await
    }
    async fn reference(&self, tag: &str) -> Result<Reference> {
        serde_json::from_slice(
            &self
                .get(&format!("git/ref/tags/v{tag}"), 16_384, None, false)
                .await?,
        )
        .map_err(|_| rejected())
    }
    pub async fn select(&self, target: &str) -> Result<Selection> {
        #[cfg(test)]
        if let Some((selection, _)) = &self.fixture {
            let _ = target;
            return Ok(selection.clone());
        }
        let release: Release =
            serde_json::from_slice(&self.get("releases/latest", 262_144, None, false).await?)
                .map_err(|_| rejected())?;
        if release.assets.len() > 32 || release.draft || release.prerelease {
            return Err(rejected());
        }
        let version = release
            .tag_name
            .strip_prefix('v')
            .filter(|v| version(v).is_some())
            .ok_or_else(rejected)?;
        let reference = self.reference(version).await?;
        let asset = named_asset(&release.assets, "release.json")?;
        if asset.size > 65_536 {
            return Err(rejected());
        }
        let expected = asset_digest(&asset)?;
        let bytes = self
            .get(
                &format!("releases/assets/{}", asset.id),
                65_536,
                Some(asset.size),
                true,
            )
            .await?;
        if sha(&bytes) != expected {
            return Err(rejected());
        }
        let manifest = serde_json::from_slice(&bytes).map_err(|_| rejected())?;
        select(release, manifest, reference, target)
    }
    pub async fn download(&self, selection: &Selection) -> Result<Vec<u8>> {
        #[cfg(test)]
        if let Some((_, bytes)) = &self.fixture {
            if sha(bytes) != selection.digest || bytes.len() as u64 != selection.bytes {
                return Err(rejected());
            }
            return Ok(bytes.clone());
        }
        let bytes = self
            .get(
                &format!("releases/assets/{}", selection.asset.id),
                MAX_BINARY,
                Some(selection.bytes),
                true,
            )
            .await?;
        if sha(&bytes) != selection.digest {
            return Err(rejected());
        }
        Ok(bytes)
    }
    pub async fn recheck(&self, selection: &Selection) -> Result<()> {
        #[cfg(test)]
        if self.fixture.is_some() {
            return Ok(());
        }
        let response = self
            .request(&format!("git/ref/tags/v{}", selection.version), false)
            .send()
            .await
            .map_err(recheck_transport)?;
        recheck_reference(recheck_body(response).await?, selection)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn fixture() -> (Value, Value, Value) {
        let source = "a".repeat(40);
        let checksum = "b".repeat(64);
        let mut platforms = Vec::new();
        let mut assets = Vec::new();
        for target in [
            "linux-x64",
            "windows-x64",
            "android-google-arm64",
            "android-foss-arm64",
            "linux-agent-x64",
            "linux-agent-arm64",
            "macos-agent-x64",
            "macos-agent-arm64",
            "windows-agent-x64",
        ] {
            let files=extensions(target).unwrap().iter().map(|ext|{
                let name=format!("lazysh-0.24.0-{target}.{ext}");
                assets.push(json!({"id":assets.len()+1,"name":name,"size":100,"digest":format!("sha256:{checksum}"),"state":"uploaded"}));
                json!({"name":name,"bytes":100,"sha256":checksum})
            }).collect::<Vec<_>>();
            platforms.push(json!({"schema":1,"sha":source,"version":"0.24.0","target":target,"signing":if target.starts_with("android"){"signed"}else if target.starts_with("macos"){"ad-hoc"}else{"unsigned"},"files":files}));
        }
        for name in [
            "release.json",
            "release-notes.md",
            "INSTALL-AND-UPDATE.md",
            "SHA256SUMS",
        ] {
            assets.push(json!({"id":assets.len()+1,"name":name,"size":100,"digest":format!("sha256:{checksum}"),"state":"uploaded"}));
        }
        (
            json!({"tag_name":"v0.24.0","draft":false,"prerelease":false,"assets":assets}),
            json!({"schema":1,"sha":source,"version":"0.24.0","platforms":platforms}),
            json!({"ref":"refs/tags/v0.24.0","object":{"type":"commit","sha":source}}),
        )
    }
    fn chosen((release, manifest, reference): (Value, Value, Value)) -> Result<Selection> {
        select(
            serde_json::from_value(release).unwrap(),
            serde_json::from_value(manifest).unwrap(),
            serde_json::from_value(reference).unwrap(),
            "linux-agent-x64",
        )
    }
    fn diagnostic(error: SshError) -> String {
        let value = serde_json::to_value(error).unwrap();
        assert_eq!(value["kind"], "companion_release_unavailable");
        assert_eq!(value.as_object().unwrap().len(), 2);
        value["message"].as_str().unwrap().to_owned()
    }
    #[tokio::test]
    async fn recheck_failures_classify_status_body_and_json_without_remote_text() {
        for (status, code) in [(403, "403"), (429, "429"), (599, "599"), (600, "other")] {
            let response = hyper::http::Response::builder()
                .status(status)
                .header("x-private-header", "private-value")
                .body("private response body")
                .unwrap();
            assert_eq!(
                diagnostic(
                    recheck_body(reqwest::Response::from(response))
                        .await
                        .err()
                        .unwrap()
                ),
                format!("lazysh-tag-recheck-v1:status:{code}")
            );
        }
        for (body, length, code) in [("private-not-json", "16", "json"), ("{}", "17000", "body")] {
            let response = hyper::http::Response::builder()
                .header("content-length", length)
                .body(body)
                .unwrap();
            assert_eq!(
                diagnostic(
                    recheck_body(reqwest::Response::from(response))
                        .await
                        .err()
                        .unwrap()
                ),
                format!("lazysh-tag-recheck-v1:{code}")
            );
        }
    }
    #[test]
    fn recheck_provenance_failures_are_closed_and_still_rejected() {
        let selection = chosen(fixture()).unwrap();
        for (field, code) in [("ref", "ref"), ("type", "type"), ("sha", "sha")] {
            let (_, _, mut reference) = fixture();
            if field == "ref" {
                reference[field] = json!("private-ref");
            } else {
                reference["object"][field] = json!("private-value");
            }
            assert_eq!(
                diagnostic(
                    recheck_reference(serde_json::from_value(reference).unwrap(), &selection)
                        .unwrap_err()
                ),
                format!("lazysh-tag-recheck-v1:{code}")
            );
        }
        let (_, _, reference) = fixture();
        assert!(recheck_reference(serde_json::from_value(reference).unwrap(), &selection).is_ok());
        let invalid = Client::new()
            .get("http://[private-invalid-url")
            .build()
            .unwrap_err();
        assert_eq!(
            diagnostic(recheck_transport(invalid)),
            "lazysh-tag-recheck-v1:transport:other"
        );
    }
    #[test]
    fn selected_receipt_source_tag_and_api_digest_must_agree() {
        assert_eq!(chosen(fixture()).unwrap().version, "0.24.0");
        for mutation in 0..12 {
            let (mut r, mut m, mut t) = fixture();
            let selected = r["assets"]
                .as_array()
                .unwrap()
                .iter()
                .position(|v| v["name"] == "lazysh-0.24.0-linux-agent-x64.bin")
                .unwrap();
            match mutation {
                0 => t["object"]["sha"] = json!("c".repeat(40)),
                1 => t["object"]["type"] = json!("tag"),
                2 => m["version"] = json!("0.25.0"),
                3 => {
                    m["platforms"].as_array_mut().unwrap().remove(4);
                }
                4 => r["assets"][selected]["digest"] = json!(format!("sha256:{}", "c".repeat(64))),
                5 => r["assets"][selected]["size"] = json!(101),
                6 => m["platforms"][4]["files"][0]["bytes"] = json!(MAX_BINARY + 1),
                7 => r["prerelease"] = json!(true),
                8 => {
                    let duplicate = r["assets"][selected].clone();
                    r["assets"].as_array_mut().unwrap().push(duplicate);
                }
                9 => {
                    let duplicate = m["platforms"][4].clone();
                    m["platforms"].as_array_mut().unwrap().push(duplicate);
                }
                10 => m["platforms"][4]["schema"] = json!(2),
                _ => m["platforms"][4]["signing"] = json!("ad-hoc"),
            }
            assert!(chosen((r, m, t)).is_err(), "mutation {mutation}");
        }
    }
    #[test]
    fn unrelated_platforms_and_assets_do_not_change_selected_authority() {
        let (mut r, mut m, t) = fixture();
        m["platforms"].as_array_mut().unwrap().push(json!({"schema":1,"sha":"a".repeat(40),"version":"0.24.0","target":"macos-arm64","signing":"ad-hoc","files":[{"name":"lazysh-0.24.0-macos-arm64.dmg","bytes":1000000000,"sha256":"c".repeat(64)}]}));
        r["assets"].as_array_mut().unwrap().push(json!({"name":"lazysh-0.24.0-macos-arm64.dmg","id":999,"size":1000000000,"digest":format!("sha256:{}","c".repeat(64)),"state":"uploaded"}));
        r["assets"]
            .as_array_mut()
            .unwrap()
            .push(json!({"name":"unrelated-future-asset","opaque":"no authority"}));
        let selection = chosen((r, m, t)).unwrap();
        assert_eq!(selection.digest, "b".repeat(64));
        assert_eq!(selection.bytes, 100);
    }
    #[test]
    fn url_boundaries_and_versions_do_not_admit_injection() {
        for bad in [
            "http://api.github.com",
            "https://api.github.com.evil.invalid",
            "https://user@api.github.com",
            "https://api.github.com:444",
            "https://release-assets.githubusercontent.com/#fragment",
        ] {
            assert!(!allowed(&bad.parse().unwrap()), "{bad}");
        }
        assert!(allowed(
            &"https://release-assets.githubusercontent.com/asset?signature=owned"
                .parse()
                .unwrap()
        ));
        for bad in ["01.2.3", "1.2.3-dev", "1.2.3/../../evil", "1.2", "1.2.3\n"] {
            assert!(version(bad).is_none());
        }
    }
    #[tokio::test]
    async fn response_stream_rejects_truncation_extra_bytes_compression_and_size_headers() {
        for (length, expected, encoding) in [
            (3, 3, None),
            (2, 3, None),
            (4, 3, None),
            (3, 3, Some("gzip")),
        ] {
            let mut builder = hyper::http::Response::builder().status(200);
            if let Some(encoding) = encoding {
                builder = builder.header("content-encoding", encoding);
            }
            let response = reqwest::Response::from(builder.body(vec![b'x'; length]).unwrap());
            let result = read_body(response, 3, Some(expected)).await;
            assert_eq!(result.is_ok(), length == 3 && encoding.is_none());
        }
        let response = reqwest::Response::from(
            hyper::http::Response::builder()
                .header("content-length", "999")
                .body(vec![0; 1])
                .unwrap(),
        );
        assert!(read_body(response, 3, None).await.is_err());
    }
}

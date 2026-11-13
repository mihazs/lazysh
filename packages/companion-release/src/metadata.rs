//! The verification chain: the release, the tag's commit, `release.json` and the per-target receipt
//! must agree with GitHub's own asset digest and size before a byte is trusted.
use crate::error::{Detail, Error, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const MAX_BINARY: u64 = 64 * 1024 * 1024;
pub(crate) const MAX_RELEASE: u64 = 262_144;
pub(crate) const MAX_RELEASES: u64 = 1_048_576;
pub(crate) const MAX_MANIFEST: u64 = 65_536;
pub(crate) const MAX_REFERENCE: u64 = 16_384;
pub const TARGETS: [&str; 5] = [
    "linux-agent-x64",
    "linux-agent-arm64",
    "macos-agent-x64",
    "macos-agent-arm64",
    "windows-agent-x64",
];

#[derive(Clone, Deserialize)]
pub(crate) struct Asset {
    id: u64,
    size: u64,
    digest: Option<String>,
    state: String,
}
#[derive(Deserialize)]
pub(crate) struct Release {
    pub tag_name: String,
    pub draft: bool,
    prerelease: bool,
    pub assets: Vec<serde_json::Value>,
}
#[derive(Deserialize)]
pub(crate) struct Reference {
    pub r#ref: String,
    pub object: Object,
}
#[derive(Deserialize)]
pub(crate) struct Object {
    pub r#type: String,
    pub sha: String,
}
#[derive(Deserialize)]
pub(crate) struct Manifest {
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
/// One verified companion asset. `digest` and `bytes` are the pin a host may re-check.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
    pub version: String,
    pub tag: String,
    /// Commit the tag points at.
    pub sha: String,
    pub target: String,
    pub asset_name: String,
    pub asset_id: u64,
    pub digest: String,
    pub bytes: u64,
}

/// Strict `X.Y.Z`: no leading zeros, no suffixes.
pub fn version(value: &str) -> Option<[u64; 3]> {
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
pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
/// File extension of the published companion for a target, or `None` for anything else.
pub fn extension(target: &str) -> Option<&'static str> {
    match target {
        "linux-agent-x64" | "linux-agent-arm64" | "macos-agent-x64" | "macos-agent-arm64" => {
            Some("bin")
        }
        "windows-agent-x64" => Some("exe"),
        _ => None,
    }
}
fn digest(value: &str) -> bool {
    lazysh_common::valid_sha256(value)
}
pub(crate) fn asset_digest(asset: &Asset) -> Result<&str> {
    let digest = asset
        .digest
        .as_deref()
        .and_then(|v| v.strip_prefix("sha256:"))
        .filter(|v| digest(v))
        .ok_or_else(Error::unavailable)?;
    if asset.id == 0 || asset.state != "uploaded" || asset.size == 0 {
        return Err(Error::unavailable());
    }
    Ok(digest)
}
pub(crate) fn named_asset(assets: &[serde_json::Value], name: &str) -> Result<Asset> {
    let selected = assets
        .iter()
        .filter(|v| v.get("name").and_then(|v| v.as_str()) == Some(name))
        .collect::<Vec<_>>();
    if selected.len() != 1 {
        return Err(Error::unavailable());
    }
    serde_json::from_value(selected[0].clone()).map_err(|_| Error::unavailable())
}
/// `release.json` as GitHub describes it: its id, exact size and digest (checked after download).
pub(crate) fn manifest_asset(release: &Release) -> Result<(u64, u64, String)> {
    let asset = named_asset(&release.assets, "release.json")?;
    if asset.size > MAX_MANIFEST {
        return Err(Error::unavailable());
    }
    let digest = asset_digest(&asset)?.to_owned();
    Ok((asset.id, asset.size, digest))
}
pub(crate) fn tag_version(release: &Release) -> Result<&str> {
    release
        .tag_name
        .strip_prefix('v')
        .filter(|v| version(v).is_some())
        .ok_or_else(Error::unavailable)
}

pub(crate) fn select(
    release: Release,
    manifest: Manifest,
    reference: Reference,
    target: &str,
    allow_prerelease: bool,
) -> Result<Selection> {
    let version = tag_version(&release)?.to_owned();
    if release.draft
        || (release.prerelease && !allow_prerelease)
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
    {
        return Err(Error::unavailable());
    }
    if reference.object.sha != manifest.sha {
        return Err(Error::verification(Detail::CommitMismatch));
    }
    let extension = extension(target).ok_or_else(Error::unavailable)?;
    let entries = manifest
        .platforms
        .iter()
        .filter(|v| v.get("target").and_then(|v| v.as_str()) == Some(target))
        .collect::<Vec<_>>();
    if entries.len() != 1 {
        return Err(Error::unavailable());
    }
    let receipt: Receipt =
        serde_json::from_value(entries[0].clone()).map_err(|_| Error::unavailable())?;
    let signing = if target.starts_with("macos-") {
        matches!(receipt.signing.as_str(), "signed" | "ad-hoc")
    } else {
        matches!(receipt.signing.as_str(), "signed" | "unsigned")
    };
    if receipt.schema != 1
        || receipt.version != version
        || receipt.target != target
        || receipt.files.len() != 1
        || !signing
    {
        return Err(Error::unavailable());
    }
    if receipt.sha != manifest.sha {
        return Err(Error::verification(Detail::CommitMismatch));
    }
    let package = receipt.files.into_iter().next().unwrap();
    if package.name != format!("lazysh-{version}-{target}.{extension}")
        || package.bytes == 0
        || package.bytes > MAX_BINARY
        || !digest(&package.sha256)
    {
        return Err(Error::unavailable());
    }
    let asset = named_asset(&release.assets, &package.name)?;
    let reported = asset_digest(&asset)?;
    if asset.size != package.bytes {
        return Err(Error::verification(Detail::SizeMismatch));
    }
    if reported != package.sha256 {
        return Err(Error::verification(Detail::DigestMismatch));
    }
    Ok(Selection {
        tag: release.tag_name,
        version,
        sha: manifest.sha,
        target: target.into(),
        asset_name: package.name,
        asset_id: asset.id,
        digest: package.sha256,
        bytes: package.bytes,
    })
}

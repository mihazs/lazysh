use crate::private_files::validate_output_parent;
use crate::{digest, https, secret, Event, Source, Status};
use serde::{Deserialize, Serialize};
use std::{io::Write, path::Path};
use uuid::Uuid;

mod bound;
pub use bound::{BoundError, CapturedPublisher, PublisherBinding};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Capability {
    pub schema_version: u8,
    pub origin: String,
    pub account_id: String,
    pub source_id: Uuid,
    pub alias: String,
    pub secret: String,
}
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    validate_output_parent(path)?;
    let mut file = lazysh_common::fs::private_create_new()
        .open(path)
        .map_err(|_| "Cannot create private capability output (never overwrite)")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Cannot persist private capability output")?;
    sync_parent(path)
}
fn sync_parent(path: &Path) -> Result<(), String> {
    std::fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )
    .and_then(|f| f.sync_all())
    .map_err(|_| "Cannot persist capability directory".into())
}
fn sync_existing_envelope(path: &Path) -> Result<(), String> {
    validate_output_parent(path)?;
    lazysh_common::service_secrets::file(path, false)?
        .sync_all()
        .map_err(|_| "Cannot persist private capability output")?;
    sync_parent(path)
}

pub fn keygen(path: &Path) -> Result<(), String> {
    write_private(path, secret().as_bytes())
}
pub fn read_token(path: &Path) -> Result<zeroize::Zeroizing<String>, String> {
    let value = lazysh_common::service_secrets::read_secret(path)?;
    if !crate::valid_token(value.trim()) {
        return Err("Invalid capability file".into());
    }
    Ok(value)
}
fn base(value: &str) -> Result<String, String> {
    let url = https(value)?;
    if value.len() > 512 || url.path() != "/" {
        return Err("Relay origin must have no path".into());
    }
    Ok(url.origin().ascii_serialization())
}
async fn response<T: serde::de::DeserializeOwned>(
    request: reqwest::RequestBuilder,
) -> Result<T, String> {
    let response = request
        .send()
        .await
        .map_err(|_| "Relay request outcome unknown; retry only with the same saved identity")?;
    if !response.status().is_success() {
        return Err(format!(
            "Relay rejected request ({})",
            response.status().as_u16()
        ));
    }
    let bytes = bounded_body(response).await?;
    serde_json::from_slice(&bytes).map_err(|_| "Invalid relay response".into())
}
async fn bounded_body(response: reqwest::Response) -> Result<Vec<u8>, String> {
    // No unbounded body collection, including authenticated but untrusted relay responses.
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Cannot read bounded relay response")?
    {
        if bytes.len() + chunk.len() > 4096 {
            return Err("Relay response too large".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

pub async fn admin_status(
    client: &reqwest::Client,
    origin: &str,
    admin: &str,
) -> Result<Status, String> {
    response(
        client
            .get(format!("{}/v1/admin/status", base(origin)?))
            .bearer_auth(admin),
    )
    .await
}
pub async fn create_source(
    client: &reqwest::Client,
    origin: &str,
    admin: &str,
    alias: &str,
    output: &Path,
) -> Result<Uuid, String> {
    let origin = base(origin)?;
    let status = admin_status(client, &origin, admin).await?;
    if Uuid::parse_str(&status.account_id).is_err() {
        return Err("Invalid relay account".into());
    }
    let cap = Capability {
        schema_version: 1,
        origin,
        account_id: status.account_id,
        source_id: Uuid::new_v4(),
        alias: alias.into(),
        secret: secret().to_string(),
    };
    Source {
        account_id: cap.account_id.clone(),
        id: cap.source_id,
        alias: cap.alias.clone(),
        token_hash: digest(&cap.secret).to_vec(),
    }
    .validate()
    .map_err(|_| "Invalid source metadata")?;
    let bytes =
        zeroize::Zeroizing::new(serde_json::to_vec(&cap).map_err(|_| "Cannot encode capability")?);
    write_private(output, &bytes)?;
    resume_source(client, &cap.origin, admin, output).await
}
pub async fn resume_source(
    client: &reqwest::Client,
    origin: &str,
    admin: &str,
    path: &Path,
) -> Result<Uuid, String> {
    let cap = read_capability(path)?;
    if cap.origin != base(origin)? {
        return Err("Capability origin mismatch".into());
    }
    sync_existing_envelope(path)?;
    let status = admin_status(client, origin, admin).await?;
    if status.account_id != cap.account_id {
        return Err("Capability account mismatch".into());
    }
    let source = Source {
        account_id: cap.account_id.clone(),
        id: cap.source_id,
        alias: cap.alias.clone(),
        token_hash: digest(&cap.secret).to_vec(),
    };
    source.validate().map_err(|_| "Invalid source metadata")?;
    let _: serde_json::Value = response(
        client
            .post(format!("{}/v1/admin/sources", cap.origin))
            .bearer_auth(admin)
            .json(&source),
    )
    .await?;
    Ok(cap.source_id)
}
pub fn read_capability(path: &Path) -> Result<Capability, String> {
    capture_capability(path).map(|(cap, _)| cap)
}
fn capture_capability(path: &Path) -> Result<(Capability, String), String> {
    let raw = lazysh_common::service_secrets::read_secret(path)?;
    let cap: Capability = serde_json::from_str(&raw).map_err(|_| "Invalid source envelope")?;
    if cap.schema_version != 1
        || cap.origin != base(&cap.origin)?
        || Uuid::parse_str(&cap.account_id).is_err()
        || !crate::valid_token(&cap.secret)
    {
        return Err("Invalid source envelope".into());
    }
    Ok((cap, hex_digest(raw.as_bytes())))
}
pub async fn publish(
    client: &reqwest::Client,
    path: &Path,
    event: Event,
) -> Result<crate::Receipt, String> {
    let cap = read_capability(path)?;
    // Check account binding before transmitting the source capability/event.
    let status: Status = response(
        client
            .get(format!("{}/v1/source/status", cap.origin))
            .bearer_auth(&cap.secret),
    )
    .await?;
    if status.account_id != cap.account_id {
        return Err("Capability account mismatch".into());
    }
    response(
        client
            .post(format!("{}/v1/events", cap.origin))
            .bearer_auth(&cap.secret)
            .json(&event),
    )
    .await
}
pub async fn admin_action(
    client: &reqwest::Client,
    origin: &str,
    admin: &str,
    action: &str,
) -> Result<serde_json::Value, String> {
    response(
        client
            .post(format!("{}/v1/admin/{action}", base(origin)?))
            .bearer_auth(admin),
    )
    .await
}
pub async fn receipt(
    client: &reqwest::Client,
    path: &Path,
    id: Uuid,
) -> Result<crate::Receipt, String> {
    let cap = read_capability(path)?;
    response(
        client
            .get(format!("{}/v1/receipts/{id}", cap.origin))
            .bearer_auth(&cap.secret),
    )
    .await
}
impl Drop for Capability {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.secret.zeroize();
    }
}

/// Additional explicit relay trust; this never disables chain or hostname verification.
pub fn transport(ca_file: Option<&Path>) -> Result<reqwest::Client, String> {
    captured_transport(ca_file).map(|(client, _)| client)
}
fn captured_transport(ca_file: Option<&Path>) -> Result<(reqwest::Client, Option<String>), String> {
    use std::io::Read;
    let captured = ca_file
        .map(|path| {
            let mut bytes = Vec::new();
            lazysh_common::service_secrets::file(path, false)?
                .take(16385)
                .read_to_end(&mut bytes)
                .map_err(|_| "Cannot read relay CA file")?;
            if bytes.len() > 16384 {
                return Err("Relay CA file is too large".to_owned());
            }
            let root = reqwest::Certificate::from_pem(&bytes)
                .map_err(|_| "Invalid relay CA certificate".to_owned())?;
            Ok((root, hex_digest(&bytes)))
        })
        .transpose()?;
    let (root, hash) = match captured {
        Some((root, hash)) => (Some(root), Some(hash)),
        None => (None, None),
    };
    Ok((crate::client_with_root(root)?, hash))
}

fn hex_digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

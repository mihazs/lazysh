pub mod client;
mod private_files;
mod wire;
use sha2::{Digest, Sha256};
use std::time::Duration;
pub use wire::{BoundEvent, BoundReceipt, BoundStatus, Event, Kind, Receipt, Source, Status};
use zeroize::Zeroizing;

pub fn secret() -> Zeroizing<String> {
    Zeroizing::new(
        rand::random::<[u8; 32]>()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
pub fn digest(value: &str) -> [u8; 32] {
    Sha256::digest(value.as_bytes()).into()
}
pub fn valid_token(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}
pub fn https(value: &str) -> Result<reqwest::Url, String> {
    if !value.starts_with("https://")
        || value.contains('\\')
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .nth(2)
            .is_some_and(|authority| authority.contains('@'))
    {
        return Err("Require HTTPS without userinfo, query or fragment".into());
    }
    let url = reqwest::Url::parse(value).map_err(|_| "Invalid HTTPS endpoint")?;
    if value.len() > 2048 || !lazysh_common::urls::credential_free_https(&url) {
        return Err("Require HTTPS without userinfo, query or fragment".into());
    }
    Ok(url)
}
pub fn http_client() -> Result<reqwest::Client, String> {
    client_with_root(None)
}
pub fn client_with_root(root: Option<reqwest::Certificate>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(10));
    if let Some(root) = root {
        builder = builder.add_root_certificate(root);
    }
    builder
        .build()
        .map_err(|_| "Cannot construct HTTPS client".into())
}

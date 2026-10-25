use crate::app_lock::{AccessLease, Guarded, GuardedError};
use russh::keys::{decode_secret_key, ssh_key, Algorithm, HashAlg, PrivateKey};
use serde::Serialize;
use zeroize::Zeroizing;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    public_key: String,
    fingerprint: String,
    algorithm: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    private_key: String,
    info: KeyInfo,
}

fn info(key: &PrivateKey) -> Result<KeyInfo, String> {
    Ok(KeyInfo {
        public_key: key
            .public_key()
            .to_openssh()
            .map_err(|_| "Could not encode public key")?,
        fingerprint: key.public_key().fingerprint(HashAlg::Sha256).to_string(),
        algorithm: key.algorithm().to_string(),
    })
}

fn inspect(private_key: &str, passphrase: Option<&str>) -> Result<KeyInfo, String> {
    if private_key.len() > 64 * 1024 || passphrase.is_some_and(|s| s.len() > 1024) {
        return Err("Key or passphrase exceeds the size limit".into());
    }
    if ssh_key::PublicKey::from_openssh(private_key.trim()).is_ok() {
        return Err("This is a public key. Import its corresponding private key instead.".into());
    }
    let key = decode_secret_key(private_key, passphrase)
        .map_err(|_| "Cannot unlock this private key. Check its format and passphrase.")?;
    info(&key)
}

#[tauri::command]
pub async fn inspect_identity(
    private_key: String,
    passphrase: Option<String>,
    access: AccessLease,
) -> std::result::Result<Guarded<KeyInfo>, GuardedError<String>> {
    access
        .run(async {
            let private_key = Zeroizing::new(private_key);
            let passphrase = passphrase.map(Zeroizing::new);
            tauri::async_runtime::spawn_blocking(move || {
                inspect(&private_key, passphrase.as_deref().map(String::as_str))
            })
            .await
            .map_err(|_| "Key inspection failed".to_string())?
        })
        .await
}

fn generate(passphrase: &str) -> Result<GeneratedKey, String> {
    if !(12..=1024).contains(&passphrase.len()) {
        return Err("Use a passphrase between 12 and 1024 bytes".into());
    }
    let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .map_err(|_| "Could not generate an Ed25519 identity")?;
    let info = info(&key)?;
    let encrypted = key
        .encrypt(&mut rand::rng(), passphrase)
        .map_err(|_| "Could not encrypt identity")?;
    let private_key = encrypted
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|_| "Could not encode encrypted identity")?
        .to_string();
    Ok(GeneratedKey { private_key, info })
}

#[tauri::command]
pub async fn generate_identity(
    passphrase: String,
    access: AccessLease,
) -> std::result::Result<Guarded<GeneratedKey>, GuardedError<String>> {
    access
        .run(async {
            let passphrase = Zeroizing::new(passphrase);
            tauri::async_runtime::spawn_blocking(move || generate(&passphrase))
                .await
                .map_err(|_| "Key generation failed".to_string())?
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_identity_is_encrypted_and_public_export_matches() {
        let generated = generate("a sufficient test passphrase").unwrap();
        let key = PrivateKey::from_openssh(&generated.private_key).unwrap();
        assert!(key.is_encrypted());
        assert!(inspect(&generated.private_key, Some("incorrect")).is_err());
        assert_eq!(
            inspect(&generated.private_key, Some("a sufficient test passphrase"))
                .unwrap()
                .fingerprint,
            generated.info.fingerprint
        );
        let public = ssh_key::PublicKey::from_openssh(&generated.info.public_key).unwrap();
        assert_eq!(
            public.fingerprint(HashAlg::Sha256).to_string(),
            generated.info.fingerprint
        );
        assert!(inspect(&generated.info.public_key, None)
            .unwrap_err()
            .contains("public key"));
    }

    #[test]
    fn malformed_and_oversized_inputs_fail_without_echoing_secrets() {
        assert!(generate("short").is_err());
        assert!(inspect(&"x".repeat(65537), None).is_err());
        let error = inspect("SECRET_MALFORMED", Some("SECRET_PASSWORD"))
            .err()
            .unwrap();
        assert!(!error.contains("SECRET"));
    }
}

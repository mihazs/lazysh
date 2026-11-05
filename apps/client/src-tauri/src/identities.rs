use crate::app_lock::{AccessLease, Guarded, GuardedError};
use russh::keys::{decode_secret_key, ssh_key, Algorithm, HashAlg, PrivateKey};
use serde::Serialize;
use zeroize::Zeroizing;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub(crate) public_key: String,
    fingerprint: String,
    algorithm: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKey {
    pub(crate) private_key: String,
    pub(crate) info: KeyInfo,
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

const KEY_LIMIT: usize = 64 * 1024;
const PASSPHRASE_LIMIT: usize = 1024;

/// Why a supplied identity cannot be used. Messages never echo key or passphrase text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum IdentityError {
    TooLarge,
    PublicKey,
    PassphraseRequired,
    Undecodable,
}
impl IdentityError {
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::TooLarge => "identity_too_large",
            Self::PublicKey => "public_key_identity",
            Self::PassphraseRequired => "identity_passphrase_required",
            Self::Undecodable => "identity_invalid",
        }
    }
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::TooLarge => "Key or passphrase exceeds the size limit",
            Self::PublicKey => {
                "This is a public key. Import its corresponding private key instead."
            }
            Self::PassphraseRequired => "This private key is encrypted. Enter its passphrase.",
            Self::Undecodable => "Cannot unlock this private key. Check its format and passphrase.",
        }
    }
}

/// Key files may come from other platforms: drop a UTF-8 BOM, CRLF and trailing spaces.
fn normalized(text: &str) -> Zeroizing<String> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).trim();
    let mut out = Zeroizing::new(String::with_capacity(text.len() + 1));
    for line in text.lines() {
        out.push_str(line.trim_end());
        out.push('\n');
    }
    out
}

/// OpenSSH `.pub`, `authorized_keys` entries, certificates, RFC 4716 and PEM public keys.
fn is_public_key(text: &str) -> bool {
    if text.contains("PRIVATE KEY") || text.starts_with("PuTTY-User-Key-File-") {
        return false;
    }
    text.contains("PUBLIC KEY-----")
        || text.starts_with("---- BEGIN SSH2 PUBLIC KEY ----")
        || text
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .any(|line| {
                ssh_key::PublicKey::from_openssh(line).is_ok()
                    || line.parse::<ssh_key::authorized_keys::Entry>().is_ok()
                    || ssh_key::Certificate::from_openssh(line).is_ok()
            })
}

/// The only private-key decoder for inspection and authentication.
pub(crate) fn decode_identity(
    private_key: &str,
    passphrase: Option<&str>,
) -> Result<PrivateKey, IdentityError> {
    if private_key.len() > KEY_LIMIT || passphrase.is_some_and(|s| s.len() > PASSPHRASE_LIMIT) {
        return Err(IdentityError::TooLarge);
    }
    let text = normalized(private_key);
    if is_public_key(&text) {
        return Err(IdentityError::PublicKey);
    }
    let passphrase = passphrase.filter(|s| !s.is_empty());
    match decode_secret_key(&text, passphrase) {
        Ok(key) => Ok(key),
        Err(russh::keys::Error::KeyIsEncrypted) if passphrase.is_none() => {
            Err(IdentityError::PassphraseRequired)
        }
        Err(_) => Err(IdentityError::Undecodable),
    }
}

fn inspect(private_key: &str, passphrase: Option<&str>) -> Result<KeyInfo, String> {
    let key = decode_identity(private_key, passphrase).map_err(|e| e.message().to_string())?;
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

pub(crate) fn generate(passphrase: &str) -> Result<GeneratedKey, String> {
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

/// Real OpenSSH key files for tests; passphrases here are test-only values.
#[cfg(all(test, unix))]
pub(crate) mod openssh_keys {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    pub(crate) fn keygen(args: &[&str]) -> String {
        let output = Command::new("ssh-keygen")
            .args(args)
            .output()
            .expect("OpenSSH ssh-keygen is required for identity file tests");
        assert!(output.status.success(), "ssh-keygen {:?} failed", args[0]);
        String::from_utf8(output.stdout).unwrap()
    }

    /// `ssh-keygen -t <kind> [-m <format>] -N <passphrase>`; returns the private key path.
    pub(crate) fn generate(
        directory: &Path,
        name: &str,
        kind: &[&str],
        format: Option<&str>,
        passphrase: &str,
    ) -> PathBuf {
        let path = directory.join(name);
        let path_text = path.to_str().unwrap();
        let mut args = vec!["-q", "-C", "lazysh-test"];
        args.extend_from_slice(kind);
        if let Some(format) = format {
            args.extend_from_slice(&["-m", format]);
        }
        args.extend_from_slice(&["-N", passphrase, "-f", path_text]);
        keygen(&args);
        path
    }

    pub(crate) fn public_path(private: &Path) -> PathBuf {
        let mut name = private.file_name().unwrap().to_os_string();
        name.push(".pub");
        private.with_file_name(name)
    }
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

    #[cfg(unix)]
    mod openssh_files {
        use super::super::openssh_keys::{generate, keygen, public_path};
        use super::*;
        use std::path::Path;

        const PASSPHRASE: &str = "test-only identity passphrase";

        fn openssh_fingerprint(public: &Path) -> String {
            keygen(&["-l", "-E", "sha256", "-f", public.to_str().unwrap()])
                .split_whitespace()
                .nth(1)
                .unwrap()
                .to_string()
        }
        /// `ssh-keygen -y` derives the public key from the private file itself.
        fn openssh_export(private: &Path, passphrase: &str) -> String {
            let exported = keygen(&["-y", "-P", passphrase, "-f", private.to_str().unwrap()]);
            exported
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ")
        }

        #[test]
        fn imported_key_files_match_openssh_fingerprint_and_public_export() {
            let directory = tempfile::tempdir().unwrap();
            let cases: [(&str, &[&str], Option<&str>, &str); 7] = [
                ("ed25519-plain", &["-t", "ed25519"], None, ""),
                ("ed25519-encrypted", &["-t", "ed25519"], None, PASSPHRASE),
                (
                    "ecdsa-encrypted",
                    &["-t", "ecdsa", "-b", "256"],
                    None,
                    PASSPHRASE,
                ),
                (
                    "rsa-openssh",
                    &["-t", "rsa", "-b", "2048"],
                    None,
                    PASSPHRASE,
                ),
                ("rsa-pem", &["-t", "rsa", "-b", "2048"], Some("PEM"), ""),
                (
                    "rsa-pem-encrypted",
                    &["-t", "rsa", "-b", "2048"],
                    Some("PEM"),
                    PASSPHRASE,
                ),
                (
                    "ecdsa-pkcs8",
                    &["-t", "ecdsa", "-b", "256"],
                    Some("PKCS8"),
                    "",
                ),
            ];
            for (name, kind, format, passphrase) in cases {
                let private = generate(directory.path(), name, kind, format, passphrase);
                let contents = std::fs::read_to_string(&private).unwrap();
                let supplied = Some(passphrase).filter(|value| !value.is_empty());
                let inspected = inspect(&contents, supplied)
                    .unwrap_or_else(|_| panic!("{name} should import from its file"));
                assert_eq!(
                    inspected.fingerprint,
                    openssh_fingerprint(&public_path(&private)),
                    "{name} fingerprint"
                );
                assert_eq!(
                    inspected
                        .public_key
                        .split_whitespace()
                        .take(2)
                        .collect::<Vec<_>>()
                        .join(" "),
                    openssh_export(&private, passphrase),
                    "{name} public export"
                );
                // The same file saved with Windows line endings and a BOM still imports.
                let windows = format!("\u{feff}{}", contents.replace('\n', "\r\n"));
                assert_eq!(
                    inspect(&windows, supplied).unwrap().fingerprint,
                    inspected.fingerprint,
                    "{name} CRLF"
                );
                if !passphrase.is_empty() {
                    assert_eq!(
                        decode_identity(&contents, Some("incorrect passphrase")).unwrap_err(),
                        IdentityError::Undecodable,
                        "{name} wrong passphrase"
                    );
                    assert!(
                        decode_identity(&contents, None).is_err(),
                        "{name} must not decode without its passphrase"
                    );
                }
            }
            let encrypted =
                std::fs::read_to_string(directory.path().join("ed25519-encrypted")).unwrap();
            assert_eq!(
                decode_identity(&encrypted, None).unwrap_err(),
                IdentityError::PassphraseRequired
            );
            assert_eq!(
                decode_identity(&encrypted, Some("")).unwrap_err(),
                IdentityError::PassphraseRequired
            );
        }

        #[test]
        fn public_key_files_in_every_openssh_export_format_are_rejected() {
            let directory = tempfile::tempdir().unwrap();
            let user = generate(
                directory.path(),
                "user",
                &["-t", "rsa", "-b", "2048"],
                None,
                "",
            );
            let ca = generate(directory.path(), "ca", &["-t", "ed25519"], None, "");
            let public = public_path(&user);
            let public_text = public.to_str().unwrap();
            keygen(&[
                "-q",
                "-s",
                ca.to_str().unwrap(),
                "-I",
                "lazysh-test",
                "-n",
                "tester",
                public_text,
            ]);
            let openssh = std::fs::read_to_string(&public).unwrap();
            let exports = [
                openssh.clone(),
                format!("restrict,command=\"true\" {openssh}"),
                std::fs::read_to_string(directory.path().join("user-cert.pub")).unwrap(),
                keygen(&["-e", "-f", public_text]),
                keygen(&["-e", "-m", "PKCS8", "-f", public_text]),
                keygen(&["-e", "-m", "PEM", "-f", public_text]),
            ];
            for export in exports {
                assert_eq!(
                    decode_identity(&export, None).unwrap_err(),
                    IdentityError::PublicKey,
                    "{}",
                    export
                        .lines()
                        .next()
                        .unwrap_or_default()
                        .split_whitespace()
                        .next()
                        .unwrap_or_default()
                );
            }
        }
    }
}

//! Test-support-only relay for the owned official Gotify Android acceptance.
//! No user endpoint, production CLI trust change, or server-only acceptance claim.
#[cfg(all(unix, feature = "test-support"))]
mod owned {
    use lazysh_common::service_secrets;
    use lazysh_notifications::{client, Config, DestinationFormat, Service};
    use serde::Deserialize;
    use std::{fs, io::Read, path::PathBuf, time::Duration};
    use zeroize::Zeroize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Input {
        schema_version: u8,
        nonce: String,
        origin: String,
        application_token: String,
        admin: String,
    }
    impl Drop for Input {
        fn drop(&mut self) {
            self.application_token.zeroize();
            self.admin.zeroize();
        }
    }
    fn phase(nonce: &str, name: &str, port: Option<u16>) {
        println!(
            "{}",
            serde_json::json!({"schemaVersion":1,"nonce":nonce,"phase":name,"port":port})
        );
    }
    fn certificates(directory: &std::path::Path) -> Result<String, Box<dyn std::error::Error>> {
        let issuer_key = rcgen::KeyPair::generate()?;
        let mut issuer_params = rcgen::CertificateParams::new(Vec::<String>::new())?;
        issuer_params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "lazysh owned Gotify CA");
        issuer_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        issuer_params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
        let issuer = issuer_params.self_signed(&issuer_key)?;
        let server_key = rcgen::KeyPair::generate()?;
        let mut server_params = rcgen::CertificateParams::new(vec![String::from("localhost")])?;
        server_params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "localhost");
        let server = server_params.signed_by(
            &server_key,
            &rcgen::Issuer::from_params(&issuer_params, &issuer_key),
        )?;
        let ca = issuer.pem();
        for (name, contents) in [
            ("ca.pem", ca.clone()),
            ("server.pem", format!("{}{}", server.pem(), ca)),
            ("server-key.pem", server_key.serialize_pem()),
        ] {
            client::write_private(&directory.join(name), contents.as_bytes())?;
        }
        Ok(ca)
    }
    pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
        if std::env::var("LAZYSH_ANDROID_GOTIFY").as_deref() != Ok("1") {
            return Err("Explicit owned Gotify acceptance required".into());
        }
        let nonce = std::env::var("LAZYSH_GOTIFY_FIXTURE_NONCE")?;
        if nonce.len() != 32
            || !nonce
                .bytes()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        {
            return Err("Owned Gotify nonce rejected".into());
        }
        let directory = PathBuf::from(
            std::env::args_os()
                .nth(1)
                .ok_or("Owned directory required")?,
        );
        if !directory.is_absolute() || fs::canonicalize(&directory)? != directory {
            return Err("Owned Gotify directory rejected".into());
        }
        let metadata = fs::symlink_metadata(&directory)?;
        if metadata.file_type().is_symlink() {
            return Err("Owned Gotify directory rejected".into());
        }
        service_secrets::private(&metadata, true)?;
        let ca = certificates(&directory)?;
        phase(&nonce, "certificates-ready", None);
        let input_path = directory.join("relay.json");
        let until = tokio::time::Instant::now() + Duration::from_secs(45);
        loop {
            match fs::symlink_metadata(&input_path) {
                Ok(_) => break,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err("Owned Gotify configuration unavailable".into()),
            }
            if tokio::time::Instant::now() >= until {
                return Err("Owned Gotify configuration deadline".into());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let private = service_secrets::read_secret(&input_path)?;
        let input: Input = serde_json::from_str(&private)?;
        let origin = reqwest::Url::parse(&input.origin)?;
        if input.schema_version != 1
            || input.nonce != nonce
            || origin.scheme() != "https"
            || origin.host_str() != Some("localhost")
            || origin.port().is_none()
            || origin.path() != "/"
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.query().is_some()
            || origin.fragment().is_some()
        {
            return Err("Owned Gotify configuration rejected".into());
        }
        let client = reqwest::Client::builder()
            .add_root_certificate(reqwest::Certificate::from_pem(ca.as_bytes())?)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()?;
        let config = Config::with_format(
            directory.join("relay-state"),
            &input.admin,
            &format!("{}message", origin),
            &input.application_token,
            DestinationFormat::Gotify,
        )?;
        let service = Service::open_with_test_client(config, client)?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        phase(&nonce, "relay-ready", Some(listener.local_addr()?.port()));
        // The owning parent retains stdin. EOF requests graceful worker shutdown.
        let shutdown = async {
            let _ = tokio::task::spawn_blocking(|| {
                let mut byte = [0u8; 1];
                let _ = std::io::stdin().read(&mut byte);
            })
            .await;
        };
        lazysh_notifications::serve(listener, service, shutdown).await?;
        phase(&nonce, "stopped", None);
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn owned_directory() -> tempfile::TempDir {
            let directory = tempfile::tempdir().unwrap();
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
            directory
        }

        fn verifies(directory: &std::path::Path, ca: &std::path::Path, hostname: &str) -> bool {
            std::process::Command::new("openssl")
                .arg("verify")
                .arg("-CAfile")
                .arg(ca)
                .args(["-purpose", "sslserver", "-verify_hostname", hostname])
                .arg(directory.join("server.pem"))
                .output()
                .expect("owned TLS regression requires OpenSSL")
                .status
                .success()
        }

        #[test]
        fn generated_chain_requires_its_owned_ca_and_localhost() {
            let directory = owned_directory();
            certificates(directory.path()).unwrap();
            let ca = directory.path().join("ca.pem");
            assert!(
                verifies(directory.path(), &ca, "localhost"),
                "the owned server chain must verify for localhost"
            );
            assert!(
                !verifies(directory.path(), &ca, "other.invalid"),
                "an unrelated hostname must remain rejected"
            );
            let foreign = owned_directory();
            certificates(foreign.path()).unwrap();
            assert!(
                !verifies(
                    directory.path(),
                    &foreign.path().join("ca.pem"),
                    "localhost"
                ),
                "an unrelated CA must remain rejected"
            );
        }
    }
}

#[cfg(all(unix, feature = "test-support"))]
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() {
    if owned::run().await.is_err() {
        // Private input and TLS errors must never reach public diagnostics.
        eprintln!("Owned Gotify relay fixture failed");
        std::process::exit(1);
    }
}

#[cfg(not(all(unix, feature = "test-support")))]
fn main() {
    eprintln!("Owned Gotify relay requires Unix and explicit test-support");
    std::process::exit(2);
}

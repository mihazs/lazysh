//! Encrypted sync against a real WebDAV server.
//!
//! `dav-server` is an independent RFC 4918 implementation with strong ETags and the `If-Match` /
//! `If-None-Match` preconditions, so these tests exercise the production transport, crypto, baseline,
//! rollback and merge code against server behavior this crate did not write. Each `Device` runs the same
//! helpers the Tauri commands call, minus the OS vault and the webview. Only this module substitutes a
//! loopback `http://` folder; production endpoints always require HTTPS, so certificate validation is not
//! covered here. Saving imported credentials into the OS vault is not covered either.
use super::{tests::*, *};
use dav_server::{body::Body, fakels::FakeLs, memfs::MemFs, DavHandler};
use hyper::{body::Incoming, server::conn::http1, service::service_fn, Request, Response};
use hyper_util::rt::TokioIo;
use std::{convert::Infallible, net::SocketAddr, sync::Mutex as Gate};
use tokio::net::TcpListener;

const OPERATOR: (&str, &str) = ("operator", "operator-password");
const SETTINGS: Scope = Scope::Settings;
const CREDENTIALS: Scope = Scope::Credentials;

fn authorization(user: &str, password: &str) -> String {
    let request = Client::new()
        .get("http://basic.invalid/")
        .basic_auth(user, Some(password))
        .build()
        .unwrap();
    request.headers()[reqwest::header::AUTHORIZATION]
        .to_str()
        .unwrap()
        .into()
}
fn pin(fill: char) -> String {
    format!("SHA256:{}", fill.to_string().repeat(43))
}
fn pinned(id: &str) -> Host {
    Host {
        fingerprint: Some(pin('A')),
        ..host(id)
    }
}
fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

/// A WebDAV account gate in front of the server, like the app passwords of a real provider.
struct Server {
    address: SocketAddr,
    accepted: Arc<Gate<HashSet<String>>>,
}
impl Server {
    async fn start(accounts: &[(&str, &str)]) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let address = listener.local_addr().unwrap();
        let accepted = Arc::new(Gate::new(
            accounts
                .iter()
                .chain([&OPERATOR])
                .map(|(user, password)| authorization(user, password))
                .collect::<HashSet<_>>(),
        ));
        let dav = DavHandler::builder()
            .filesystem(MemFs::new())
            .locksystem(FakeLs::new())
            .build_handler();
        let gate = accepted.clone();
        tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let (dav, gate) = (dav.clone(), gate.clone());
                tokio::spawn(async move {
                    let service = service_fn(move |request: Request<Incoming>| {
                        let (dav, gate) = (dav.clone(), gate.clone());
                        async move {
                            let allowed = request
                                .headers()
                                .get(reqwest::header::AUTHORIZATION)
                                .and_then(|value| value.to_str().ok())
                                .is_some_and(|value| gate.lock().unwrap().contains(value));
                            Ok::<_, Infallible>(if allowed {
                                dav.handle(request).await
                            } else {
                                Response::builder()
                                    .status(401)
                                    .header("WWW-Authenticate", "Basic realm=\"lazysh\"")
                                    .body(Body::empty())
                                    .unwrap()
                            })
                        }
                    });
                    let _ = http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Self { address, accepted }
    }
    /// Revoke one app password at the server.
    fn revoke(&self, user: &str, password: &str) {
        assert!(self
            .accepted
            .lock()
            .unwrap()
            .remove(&authorization(user, password)));
    }
    async fn operate(&self, method: &str, path: &str, body: &[u8]) -> reqwest::Response {
        Client::new()
            .request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap(),
                format!("http://{}{path}", self.address),
            )
            .basic_auth(OPERATOR.0, Some(OPERATOR.1))
            .body(body.to_vec())
            .send()
            .await
            .unwrap()
    }
    /// The WebDAV folder a user creates before enrolling.
    async fn folder(&self, name: &str) -> Url {
        let created = self.operate("MKCOL", &format!("/{name}/"), b"").await;
        assert_eq!(created.status(), StatusCode::CREATED);
        Url::parse(&format!("http://{}/{name}/", self.address)).unwrap()
    }
    fn path(folder: &Url, scope: Scope) -> String {
        format!("{}{}", folder.path(), scope.file())
    }
    /// What an operator or a thief of the server disk sees: the stored resource, if any.
    async fn stored(&self, folder: &Url, scope: Scope) -> Option<Vec<u8>> {
        let response = self.operate("GET", &Self::path(folder, scope), b"").await;
        match response.status() {
            StatusCode::OK => Some(response.bytes().await.unwrap().to_vec()),
            StatusCode::NOT_FOUND => None,
            other => panic!("unexpected server answer {other}"),
        }
    }
    /// An operator writes the resource without any precondition, for example a backup restore.
    async fn overwrite(&self, folder: &Url, scope: Scope, bytes: &[u8]) {
        let written = self.operate("PUT", &Self::path(folder, scope), bytes).await;
        assert!(written.status().is_success());
    }
}

struct Review {
    bundle: Bundle,
    tag: String,
    local: Vec<Host>,
    additions: Vec<Host>,
}
/// One enrolled installation: its own host list, WebDAV account and baseline.
struct Device {
    _dir: tempfile::TempDir,
    hosts: AppState,
    remote: Remote,
    enrollment: Enrollment,
}
impl Device {
    fn enroll(folder: &Url, account: (&str, &str), key: &str) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let mut remote = Remote::new("https://example.invalid/").unwrap();
        remote.endpoint = folder.clone();
        let mut enrollment = enrollment(key);
        enrollment.config.username = account.0.into();
        enrollment.password = account.1.into();
        Self {
            hosts: AppState::new(dir.path().into()).unwrap(),
            _dir: dir,
            remote,
            enrollment,
        }
    }
    fn add_host(&self, host: Host) {
        let local = self.hosts.sync_snapshot().unwrap();
        self.hosts.sync_add_hosts(&local, vec![host], &[]).unwrap();
    }
    fn local_ids(&self) -> Vec<String> {
        let mut ids: Vec<_> = self
            .hosts
            .sync_snapshot()
            .unwrap()
            .into_iter()
            .map(|host| host.id)
            .collect();
        ids.sort();
        ids
    }
    fn snapshot(&self, scope: Scope) -> Bundle {
        let mut hosts = self.hosts.sync_snapshot().unwrap();
        let credentials = if scope == CREDENTIALS {
            hosts
                .iter()
                .map(|host| CredentialRecord {
                    host_id: host.id.clone(),
                    credentials: Credentials {
                        password: Some(format!("ssh-secret-{}", host.id)),
                        private_key: None,
                        passphrase: None,
                    },
                })
                .collect()
        } else {
            for host in &mut hosts {
                host.fingerprint = None;
            }
            Vec::new()
        };
        Bundle {
            version: 1,
            revision: self.enrollment.revision(scope) + 1,
            scope,
            hosts,
            preferences: (scope == SETTINGS)
                .then(|| serde_json::json!({"version":1,"fontSize":14})),
            credentials,
        }
    }
    /// The network and crypto half of `sync_push`.
    async fn push(&mut self, scope: Scope) -> Result<()> {
        ensure_enabled(&self.enrollment, scope)?;
        let current = self.remote.fetch(&self.enrollment, scope).await?;
        ensure_baseline(&self.enrollment, scope, &current)?;
        let ciphertext =
            seal_upload(&self.enrollment, scope, current, self.snapshot(scope)).await?;
        finish_upload(&self.remote, &mut self.enrollment, scope, ciphertext).await
    }
    /// The network and crypto half of `sync_preview`.
    async fn review(&self, scope: Scope) -> Result<Review> {
        ensure_enabled(&self.enrollment, scope)?;
        let (bundle, tag) = fetch_for_review(&self.remote, &self.enrollment, scope).await?;
        let local = self.hosts.sync_snapshot().unwrap();
        let (additions, ..) = plan(&bundle, &local);
        Ok(Review {
            bundle,
            tag,
            local,
            additions,
        })
    }
    async fn refusal(&self, scope: Scope) -> String {
        self.review(scope)
            .await
            .err()
            .expect("the review must be refused")
    }
    /// The network and host-list half of `sync_apply`; returns the number of imported profiles.
    async fn apply(&mut self, review: Review) -> Result<usize> {
        let scope = review.bundle.scope;
        let current = self.remote.fetch(&self.enrollment, scope).await?;
        ensure_reviewed(&current, &review.tag)?;
        let added = review.additions.len();
        self.hosts
            .sync_add_hosts(&review.local, review.additions, &[])
            .map_err(|_| "Local hosts changed. Fetch and review a new preview.")?;
        self.enrollment
            .observe(scope, Some(review.tag), review.bundle.revision);
        Ok(added)
    }
}

/// A server with one folder and two enrolled devices that share a recovery secret.
struct Group {
    key: Zeroizing<String>,
    server: Server,
    folder: Url,
    phone: Device,
    second: Device,
}
impl Group {
    async fn start(second: &str) -> Self {
        let key = generate_recovery();
        let password = format!("{second}-pw");
        let server = Server::start(&[("phone", "phone-pw"), (second, &password)]).await;
        let folder = server.folder("lazysh").await;
        Self {
            phone: Device::enroll(&folder, ("phone", "phone-pw"), &key),
            second: Device::enroll(&folder, (second, &password), &key),
            key,
            server,
            folder,
        }
    }
}

#[tokio::test]
async fn enrolled_devices_exchange_only_ciphertext_and_each_category_is_opt_in() {
    let Group {
        key,
        server,
        folder,
        mut phone,
        second: mut laptop,
    } = Group::start("laptop").await;
    phone.add_host(pinned("prod"));
    assert!(server.stored(&folder, SETTINGS).await.is_none());
    phone.push(SETTINGS).await.unwrap();
    let stored = server.stored(&folder, SETTINGS).await.unwrap();
    assert!(!contains(&stored, "prod.example") && !contains(&stored, "fontSize"));
    // Enabling settings never enables credentials: the second category is refused and never created.
    assert!(phone.push(CREDENTIALS).await.is_err());
    assert!(server.stored(&folder, CREDENTIALS).await.is_none());

    let review = laptop.review(SETTINGS).await.unwrap();
    assert_eq!(review.bundle.preferences.as_ref().unwrap()["fontSize"], 14);
    assert!(review
        .bundle
        .hosts
        .iter()
        .all(|host| host.fingerprint.is_none()));
    assert_eq!(laptop.apply(review).await.unwrap(), 1);
    assert_eq!(laptop.local_ids(), ["prod"]);
    // The next push from the importing device starts from the baseline the import recorded.
    laptop.push(SETTINGS).await.unwrap();

    let stranger = Device::enroll(&folder, ("laptop", "laptop-pw"), &generate_recovery());
    assert!(stranger.refusal(SETTINGS).await.contains("Cannot decrypt"));
    let guest = Device::enroll(&folder, ("laptop", "not-the-app-password"), &key);
    assert!(guest
        .refusal(SETTINGS)
        .await
        .contains("refused by the server"));

    phone.enrollment.config.credentials_enabled = true;
    phone.push(CREDENTIALS).await.unwrap();
    let secrets = server.stored(&folder, CREDENTIALS).await.unwrap();
    assert!(!contains(&secrets, "ssh-secret-prod") && !contains(&secrets, &pin('A')));
    laptop.enrollment.config.credentials_enabled = true;
    let credentials = laptop.review(CREDENTIALS).await.unwrap().bundle.credentials;
    assert_eq!(
        credentials[0].credentials.password.as_deref(),
        Some("ssh-secret-prod")
    );
    assert_ne!(
        server.stored(&folder, SETTINGS).await.unwrap(),
        secrets,
        "each category is its own resource"
    );
}

#[tokio::test]
async fn concurrent_writers_conflict_on_the_etag_and_deletions_never_propagate() {
    let Group {
        key,
        server,
        folder,
        mut phone,
        second: mut laptop,
    } = Group::start("laptop").await;
    phone.add_host(host("prod"));
    phone.push(SETTINGS).await.unwrap();
    let review = laptop.review(SETTINGS).await.unwrap();
    laptop.apply(review).await.unwrap();

    // The phone moves the remote forward; the laptop's baseline is now stale and nothing is overwritten.
    phone.add_host(host("staging"));
    phone.push(SETTINGS).await.unwrap();
    let winner = server.stored(&folder, SETTINGS).await.unwrap();
    laptop.add_host(host("laptop-only"));
    assert!(laptop
        .push(SETTINGS)
        .await
        .unwrap_err()
        .contains("Remote sync changed"));
    assert_eq!(server.stored(&folder, SETTINGS).await.unwrap(), winner);

    // A writer that passes the baseline check and then loses the race is stopped by the server's If-Match.
    let review = laptop.review(SETTINGS).await.unwrap();
    laptop.apply(review).await.unwrap();
    let current = laptop
        .remote
        .fetch(&laptop.enrollment, SETTINGS)
        .await
        .unwrap();
    ensure_baseline(&laptop.enrollment, SETTINGS, &current).unwrap();
    phone.add_host(host("race"));
    phone.push(SETTINGS).await.unwrap();
    let winner = server.stored(&folder, SETTINGS).await.unwrap();
    let sealed = seal_upload(
        &laptop.enrollment,
        SETTINGS,
        current,
        laptop.snapshot(SETTINGS),
    )
    .await
    .unwrap();
    let error = finish_upload(&laptop.remote, &mut laptop.enrollment, SETTINGS, sealed)
        .await
        .unwrap_err();
    assert!(error.contains("Remote sync changed"));
    assert_eq!(server.stored(&folder, SETTINGS).await.unwrap(), winner);

    // A preview goes stale when the remote moves before it is applied; the local host list is untouched.
    let stale = laptop.review(SETTINGS).await.unwrap();
    phone.push(SETTINGS).await.unwrap();
    let before = laptop.local_ids();
    assert!(laptop
        .apply(stale)
        .await
        .unwrap_err()
        .contains("review it again"));
    assert_eq!(laptop.local_ids(), before);

    // After a fresh review the laptop merges, and its upload keeps every profile either side had.
    let review = laptop.review(SETTINGS).await.unwrap();
    assert_eq!(laptop.apply(review).await.unwrap(), 1);
    laptop.push(SETTINGS).await.unwrap();
    // Deleting a profile removes it from this device only; the next upload does not delete it remotely.
    crate::ssh::delete_host_record(&laptop.hosts, "staging", |_| Ok(())).unwrap();
    assert!(!laptop.local_ids().contains(&"staging".into()));
    laptop.push(SETTINGS).await.unwrap();
    let remote = decrypt(
        &key,
        &server.stored(&folder, SETTINGS).await.unwrap(),
        SETTINGS,
    )
    .unwrap();
    assert!(remote.hosts.iter().any(|host| host.id == "staging"));
    assert_eq!(remote.hosts.len(), 4);
}

#[tokio::test]
async fn server_side_rollback_and_deletion_are_detected_and_never_silently_repaired() {
    let Group {
        key,
        server,
        folder,
        mut phone,
        ..
    } = Group::start("unused").await;
    phone.add_host(host("prod"));
    phone.push(SETTINGS).await.unwrap();
    let revision_one = server.stored(&folder, SETTINGS).await.unwrap();
    phone.add_host(host("staging"));
    phone.push(SETTINGS).await.unwrap();

    // The operator restores an older backup over the newer snapshot.
    server.overwrite(&folder, SETTINGS, &revision_one).await;
    assert!(phone.refusal(SETTINGS).await.contains("rollback detected"));
    assert!(phone
        .push(SETTINGS)
        .await
        .unwrap_err()
        .contains("Remote sync changed"));
    assert_eq!(
        server.stored(&folder, SETTINGS).await.unwrap(),
        revision_one
    );
    // Even a server that replays the old bytes under the baseline ETag cannot make an upload succeed.
    let replay = Some((revision_one.clone(), "\"replayed\"".to_string()));
    let sealed = seal_upload(
        &phone.enrollment,
        SETTINGS,
        replay,
        phone.snapshot(SETTINGS),
    )
    .await;
    assert!(sealed.unwrap_err().contains("rollback detected"));
    // A device without a baseline cannot tell; the documented limit of a fresh enrollment.
    let fresh = Device::enroll(&folder, ("phone", "phone-pw"), &key);
    assert_eq!(fresh.review(SETTINGS).await.unwrap().bundle.revision, 1);

    // External deletion is a changed baseline: neither erased locally nor recreated remotely.
    let removed = server
        .operate("DELETE", &Server::path(&folder, SETTINGS), b"")
        .await;
    assert!(removed.status().is_success());
    assert!(phone
        .push(SETTINGS)
        .await
        .unwrap_err()
        .contains("Remote sync changed"));
    assert!(phone.refusal(SETTINGS).await.contains("No remote snapshot"));
    assert!(server.stored(&folder, SETTINGS).await.is_none());
    assert_eq!(phone.local_ids(), ["prod", "staging"]);
    // Re-enrolling with the saved recovery secret and uploading explicitly initializes the empty folder.
    let mut again = Device::enroll(&folder, ("phone", "phone-pw"), &key);
    again.add_host(host("prod"));
    again.push(SETTINGS).await.unwrap();
    assert!(server.stored(&folder, SETTINGS).await.is_some());
}

#[tokio::test]
async fn revoking_an_app_password_and_rotating_the_key_cuts_off_the_lost_device() {
    let Group {
        key: old_key,
        server,
        folder,
        mut phone,
        second: mut lost,
    } = Group::start("lost").await;
    phone.add_host(host("prod"));
    phone.push(SETTINGS).await.unwrap();
    let review = lost.review(SETTINGS).await.unwrap();
    lost.apply(review).await.unwrap();
    let copied = server.stored(&folder, SETTINGS).await.unwrap();

    server.revoke("lost", "lost-pw");
    assert!(lost
        .refusal(SETTINGS)
        .await
        .contains("refused by the server"));
    assert!(lost
        .push(SETTINGS)
        .await
        .unwrap_err()
        .contains("refused by the server"));
    phone.push(SETTINGS).await.unwrap();
    // Revocation does not erase what the device already learned: copied ciphertext still opens with the old key.
    assert!(decrypt(&old_key, &copied, SETTINGS).is_ok());

    // Rotation: a fresh folder and recovery secret that the lost device never received.
    let new_key = generate_recovery();
    let rotated_folder = server.folder("rotated").await;
    let mut rotated = Device::enroll(&rotated_folder, ("phone", "phone-pw"), &new_key);
    rotated.add_host(host("prod"));
    rotated.push(SETTINGS).await.unwrap();
    let sealed = server.stored(&rotated_folder, SETTINGS).await.unwrap();
    assert!(decrypt(&old_key, &sealed, SETTINGS).is_err());
    let still_has_access = Device::enroll(&rotated_folder, ("phone", "phone-pw"), &old_key);
    assert!(still_has_access
        .refusal(SETTINGS)
        .await
        .contains("Cannot decrypt"));
    assert!(decrypt(&new_key, &sealed, SETTINGS).is_ok());
}

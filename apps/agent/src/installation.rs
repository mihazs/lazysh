//! Explicit local installation only; never changes PATH, hooks, settings or event state.
use crate::{Error, Result};
use clap::Subcommand;
use serde_json::{json, Value};

#[derive(Subcommand)]
pub enum Command {
    Inspect,
    Install {
        /// Hash of the complete inspected source, destination and existing identity.
        #[arg(long)]
        expected_plan: String,
    },
}
pub fn run(command: Command) -> Result<Value> {
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    {
        unix::run(command)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        match command {
            Command::Inspect => Ok(
                json!({"schemaVersion":1,"supported":false,"reason":"windowsInstallerUnsupported"}),
            ),
            Command::Install { .. } => Err(Error::Installation("windowsInstallerUnsupported")),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    use super::*;
    use lazysh_common::{fs as private, storage_filesystem, storage_namespace};
    use serde::Serialize;
    use sha2::{Digest, Sha256};
    use std::{
        ffi::CString,
        fs::{self, File},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
        },
        path::{Path, PathBuf},
    };
    const MAXIMUM: u64 = 64 * 1024 * 1024;
    const NAME: &str = "lazysh-agent";
    fn rejected(code: &'static str) -> Error {
        Error::Installation(code)
    }
    #[derive(Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity {
        version: &'static str,
        sha256: String,
        bytes: u64,
    }
    #[derive(PartialEq, Eq, Serialize)]
    #[serde(tag = "state", rename_all = "camelCase")]
    enum Existing {
        Missing,
        Present { sha256: String, bytes: u64 },
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Plan {
        schema_version: u8,
        source: Identity,
        destination: PathBuf,
        existing: Existing,
    }
    fn hash(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    fn plan_hash(plan: &Plan) -> Result<String> {
        Ok(hash(
            &serde_json::to_vec(plan).map_err(|_| Error::InvalidArgument)?,
        ))
    }
    fn file_hash(file: &mut File, private_file: bool) -> Result<(String, u64)> {
        let before = file.metadata()?;
        if !before.is_file()
            || before.len() == 0
            || before.len() > MAXIMUM
            || (private_file && !private::owner_only(&before, false))
        {
            return Err(rejected("InstallUnsafeFile"));
        }
        let mut digest = Sha256::new();
        let count = std::io::copy(&mut file.take(MAXIMUM + 1), &mut digest)?;
        let after = file.metadata()?;
        if count != before.len()
            || count > MAXIMUM
            || before.dev() != after.dev()
            || before.ino() != after.ino()
            || before.len() != after.len()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
        {
            return Err(rejected("InstallChangedFile"));
        }
        Ok((format!("{:x}", digest.finalize()), count))
    }
    fn source() -> Result<(PathBuf, File, Identity)> {
        let path = std::env::current_exe()?;
        let mut file = private::read_options(false).open(&path)?;
        let (sha256, bytes) = file_hash(&mut file, false)?;
        Ok((
            path,
            file,
            Identity {
                version: env!("CARGO_PKG_VERSION"),
                sha256,
                bytes,
            },
        ))
    }
    fn destination() -> Result<PathBuf> {
        let root = dirs::data_local_dir().ok_or_else(|| rejected("InstallNoUserData"))?;
        if !root.is_absolute() {
            return Err(rejected("InstallUnsafeNamespace"));
        }
        let parent = storage_namespace::resolve(&root.join("lazysh/companion"))?;
        let destination = parent.join(NAME);
        let text = destination
            .to_str()
            .ok_or_else(|| rejected("InstallUnsafeNamespace"))?;
        if text.len() > 4096 || text.chars().any(char::is_control) {
            return Err(rejected("InstallUnsafeNamespace"));
        }
        Ok(destination)
    }
    struct Directory {
        file: File,
        path: PathBuf,
    }
    impl Directory {
        fn open(path: &Path) -> Result<Self> {
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)?;
            if !private::owner_only(&file.metadata()?, true) {
                return Err(rejected("InstallUnsafeNamespace"));
            }
            Ok(Self {
                file,
                path: path.to_owned(),
            })
        }
        fn check(&self) -> Result<()> {
            storage_namespace::resolve(&self.path)?;
            let path = fs::symlink_metadata(&self.path)?;
            let retained = self.file.metadata()?;
            if !private::owner_only(&path, true)
                || path.dev() != retained.dev()
                || path.ino() != retained.ino()
            {
                return Err(rejected("InstallChangedNamespace"));
            }
            Ok(())
        }
        fn open_file(&self, name: &str, flags: i32) -> std::io::Result<File> {
            let name = CString::new(name).map_err(std::io::Error::other)?;
            // SAFETY: retained directory descriptor and NUL-terminated fixed/owned basename.
            let fd = unsafe {
                libc::openat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                    0o600,
                )
            };
            if fd < 0 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: successful openat returns a newly owned descriptor.
            Ok(unsafe { File::from_raw_fd(fd) })
        }
        fn existing(&self) -> Result<Existing> {
            match self.open_file(NAME, libc::O_RDONLY) {
                Ok(mut file) => {
                    if file.metadata()?.mode() & 0o777 != 0o700 {
                        return Err(rejected("InstallUnsafeFile"));
                    }
                    let (sha256, bytes) = file_hash(&mut file, true)?;
                    Ok(Existing::Present { sha256, bytes })
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Existing::Missing),
                Err(e) => Err(e.into()),
            }
        }
    }
    struct Lock(File);
    impl Drop for Lock {
        fn drop(&mut self) {
            let _ = self.0.unlock();
        }
    }
    struct Temporary<'a> {
        directory: &'a Directory,
        name: CString,
        committed: bool,
    }
    impl Drop for Temporary<'_> {
        fn drop(&mut self) {
            if !self.committed {
                // SAFETY: descriptor remains owned by Directory; name belongs only to this operation.
                unsafe {
                    libc::unlinkat(self.directory.file.as_raw_fd(), self.name.as_ptr(), 0);
                }
            }
        }
    }
    fn inspect(source: Identity, destination: PathBuf) -> Result<Plan> {
        let parent = destination.parent().unwrap();
        storage_namespace::resolve(parent)?;
        storage_filesystem::require_local(parent)?;
        let existing = match Directory::open(parent) {
            Ok(directory) => {
                directory.check()?;
                directory.existing()?
            }
            Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => Existing::Missing,
            Err(e) => return Err(e),
        };
        Ok(Plan {
            schema_version: 1,
            source,
            destination,
            existing,
        })
    }
    fn preview(plan: &Plan) -> Result<Value> {
        let mut value = serde_json::to_value(plan).map_err(|_| Error::InvalidArgument)?;
        value["supported"] = json!(true);
        value["planSha256"] = json!(plan_hash(plan)?);
        Ok(value)
    }
    pub(super) fn run(command: Command) -> Result<Value> {
        if let Command::Install { expected_plan } = &command {
            if !lazysh_common::valid_sha256(expected_plan) {
                return Err(Error::InvalidArgument);
            }
        }
        let (_, source_file, identity) = source()?;
        let plan = inspect(identity.clone(), destination()?)?;
        let Command::Install { expected_plan } = command else {
            return preview(&plan);
        };
        install(plan, source_file, &expected_plan)
    }
    #[cfg(test)]
    thread_local! { static FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) }; }
    fn fault(point: u8) -> Result<()> {
        #[cfg(test)]
        if FAULT.with(|fault| fault.get() == point) {
            return Err(std::io::Error::other("Owned install interruption").into());
        }
        #[cfg(not(test))]
        let _ = point;
        Ok(())
    }
    fn install(plan: Plan, mut source_file: File, expected_plan: &str) -> Result<Value> {
        let identity = plan.source.clone();
        if plan_hash(&plan)? != expected_plan {
            return Err(rejected("InstallStalePlan"));
        }
        let parent = plan.destination.parent().unwrap();
        let mut missing = Vec::new();
        let mut ancestor = parent;
        while !ancestor.try_exists()? {
            let previous = ancestor
                .parent()
                .ok_or_else(|| rejected("InstallUnsafeNamespace"))?;
            missing.push(previous.to_owned());
            ancestor = previous;
        }
        storage_namespace::create(parent)?;
        let directory = Directory::open(parent)?;
        // Persist newly created namespace entries before a later executable commit.
        directory.file.sync_all()?;
        for ancestor in missing {
            File::open(ancestor)?.sync_all()?;
        }
        let lock = directory.open_file("installation.lock", libc::O_RDWR | libc::O_CREAT)?;
        if !private::owner_only(&lock.metadata()?, false) {
            return Err(rejected("InstallUnsafeLock"));
        }
        lock.try_lock().map_err(|_| rejected("InstallBusy"))?;
        let _lock = Lock(lock);
        directory.check()?;
        let plan = Plan {
            existing: directory.existing()?,
            ..plan
        };
        if plan_hash(&plan)? != expected_plan {
            return Err(rejected("InstallStalePlan"));
        }
        if plan.existing
            == (Existing::Present {
                sha256: identity.sha256.clone(),
                bytes: identity.bytes,
            })
        {
            return Ok(
                json!({"schemaVersion":1,"status":"reused","committed":false,"plan":preview(&plan)?}),
            );
        }
        let temporary_name = format!(".install-{}", uuid::Uuid::new_v4());
        let mut temporary_file =
            directory.open_file(&temporary_name, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)?;
        let mut temporary = Temporary {
            directory: &directory,
            name: CString::new(temporary_name).unwrap(),
            committed: false,
        };
        use std::io::{Seek, SeekFrom};
        source_file.seek(SeekFrom::Start(0))?;
        let copied = std::io::copy(
            &mut (&mut source_file).take(MAXIMUM + 1),
            &mut temporary_file,
        )?;
        temporary_file.flush()?;
        temporary_file.set_permissions(fs::Permissions::from_mode(0o700))?;
        temporary_file.seek(SeekFrom::Start(0))?;
        if file_hash(&mut temporary_file, true)? != (identity.sha256.clone(), identity.bytes)
            || copied != identity.bytes
        {
            return Err(rejected("InstallSourceMismatch"));
        }
        temporary_file.sync_all()?;
        fault(1)?;
        directory.check()?;
        if directory.existing()? != plan.existing {
            return Err(rejected("InstallStalePlan"));
        }
        let name = CString::new(NAME).unwrap();
        // SAFETY: both names are within the same retained directory; no path or symlink traversal.
        if unsafe {
            libc::renameat(
                directory.file.as_raw_fd(),
                temporary.name.as_ptr(),
                directory.file.as_raw_fd(),
                name.as_ptr(),
            )
        } != 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
        temporary.committed = true;
        let durable = directory.file.sync_all().is_ok()
            && fault(2).is_ok()
            && directory.check().is_ok()
            && directory.existing().is_ok_and(|existing| {
                existing
                    == Existing::Present {
                        sha256: identity.sha256.clone(),
                        bytes: identity.bytes,
                    }
            });
        let installed = Plan {
            existing: Existing::Present {
                sha256: identity.sha256.clone(),
                bytes: identity.bytes,
            },
            ..plan
        };
        Ok(
            json!({"schemaVersion":1,"status":if durable {"installed"} else {"committedDurabilityUnknown"},"committed":true,"plan":preview(&installed)?}),
        )
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;
        struct Fixture {
            _root: tempfile::TempDir,
            source: PathBuf,
            destination: PathBuf,
        }
        impl Fixture {
            fn new() -> Self {
                let root = tempfile::tempdir().unwrap();
                let source = root.path().join("source");
                fs::write(&source, b"owned new binary").unwrap();
                let destination = root
                    .path()
                    .canonicalize()
                    .unwrap()
                    .join("managed")
                    .join(NAME);
                Self {
                    _root: root,
                    source,
                    destination,
                }
            }
            fn plan(&self) -> Plan {
                let mut source = File::open(&self.source).unwrap();
                let (sha256, bytes) = file_hash(&mut source, false).unwrap();
                inspect(
                    Identity {
                        version: env!("CARGO_PKG_VERSION"),
                        sha256,
                        bytes,
                    },
                    self.destination.clone(),
                )
                .unwrap()
            }
            fn install(&self, plan: Plan, expected: &str) -> Result<Value> {
                install(plan, File::open(&self.source).unwrap(), expected)
            }
            fn existing(&self) {
                storage_namespace::create(self.destination.parent().unwrap()).unwrap();
                fs::write(&self.destination, b"owned old binary").unwrap();
                fs::set_permissions(&self.destination, fs::Permissions::from_mode(0o700)).unwrap();
            }
        }
        #[test]
        fn inspect_is_read_only_and_plan_binds_destination_source_and_old_identity() {
            let fixture = Fixture::new();
            let plan = fixture.plan();
            let hash = plan_hash(&plan).unwrap();
            assert!(!fixture.destination.parent().unwrap().exists());
            assert_eq!(plan_hash(&fixture.plan()).unwrap(), hash);
            let changed = Plan {
                destination: fixture._root.path().join("elsewhere"),
                ..fixture.plan()
            };
            assert_ne!(plan_hash(&changed).unwrap(), hash);
            fs::write(&fixture.source, b"another source").unwrap();
            assert_ne!(plan_hash(&fixture.plan()).unwrap(), hash);
            fixture.existing();
            assert_ne!(plan_hash(&fixture.plan()).unwrap(), hash);
        }
        #[test]
        fn installation_and_reuse_preserve_private_identity() {
            let fixture = Fixture::new();
            let plan = fixture.plan();
            let expected = plan_hash(&plan).unwrap();
            assert_eq!(
                fixture.install(plan, &expected).unwrap()["status"],
                "installed"
            );
            assert_eq!(fs::read(&fixture.destination).unwrap(), b"owned new binary");
            assert_eq!(
                fs::metadata(&fixture.destination).unwrap().mode() & 0o777,
                0o700
            );
            let plan = fixture.plan();
            let expected = plan_hash(&plan).unwrap();
            let before = fs::metadata(&fixture.destination).unwrap().ino();
            assert_eq!(
                fixture.install(plan, &expected).unwrap()["status"],
                "reused"
            );
            assert_eq!(fs::metadata(&fixture.destination).unwrap().ino(), before);
        }
        #[test]
        fn stale_destination_and_wrong_source_preserve_existing_bytes() {
            let fixture = Fixture::new();
            let missing = fixture.plan();
            let expected = plan_hash(&missing).unwrap();
            fixture.existing();
            assert_eq!(
                fixture.install(missing, &expected).unwrap_err().class(),
                "InstallStalePlan"
            );
            let plan = fixture.plan();
            let expected = plan_hash(&plan).unwrap();
            fs::write(&fixture.source, b"tampered source").unwrap();
            assert_eq!(
                fixture.install(plan, &expected).unwrap_err().class(),
                "InstallSourceMismatch"
            );
            assert_eq!(fs::read(&fixture.destination).unwrap(), b"owned old binary");
        }
        #[test]
        fn kernel_lock_contends_without_overwriting_or_removing_its_inode() {
            let fixture = Fixture::new();
            fixture.existing();
            let directory = Directory::open(fixture.destination.parent().unwrap()).unwrap();
            let lock = directory
                .open_file("installation.lock", libc::O_RDWR | libc::O_CREAT)
                .unwrap();
            lock.try_lock().unwrap();
            let inode = lock.metadata().unwrap().ino();
            let plan = fixture.plan();
            let expected = plan_hash(&plan).unwrap();
            assert_eq!(
                fixture.install(plan, &expected).unwrap_err().class(),
                "InstallBusy"
            );
            assert_eq!(
                directory
                    .open_file("installation.lock", libc::O_RDONLY)
                    .unwrap()
                    .metadata()
                    .unwrap()
                    .ino(),
                inode
            );
            assert_eq!(fs::read(&fixture.destination).unwrap(), b"owned old binary");
        }
        #[test]
        fn hostile_destination_links_and_shared_namespace_are_refused() {
            for kind in ["symlink", "hardlink", "public", "not-executable"] {
                let fixture = Fixture::new();
                fixture.existing();
                match kind {
                    "symlink" => {
                        fs::remove_file(&fixture.destination).unwrap();
                        symlink(&fixture.source, &fixture.destination).unwrap();
                    }
                    "hardlink" => {
                        fs::hard_link(&fixture.destination, fixture._root.path().join("alias"))
                            .unwrap()
                    }
                    "not-executable" => {
                        fs::set_permissions(&fixture.destination, fs::Permissions::from_mode(0o600))
                            .unwrap()
                    }
                    _ => fs::set_permissions(
                        fixture.destination.parent().unwrap(),
                        fs::Permissions::from_mode(0o777),
                    )
                    .unwrap(),
                }
                let mut file = File::open(&fixture.source).unwrap();
                let (sha256, bytes) = file_hash(&mut file, false).unwrap();
                assert!(
                    inspect(
                        Identity {
                            version: env!("CARGO_PKG_VERSION"),
                            sha256,
                            bytes
                        },
                        fixture.destination.clone()
                    )
                    .is_err(),
                    "{kind}"
                );
                assert_eq!(fs::read(&fixture.source).unwrap(), b"owned new binary");
            }
        }
        #[test]
        fn lock_symlink_is_not_followed_or_modified() {
            let fixture = Fixture::new();
            fixture.existing();
            symlink(
                &fixture.source,
                fixture
                    .destination
                    .parent()
                    .unwrap()
                    .join("installation.lock"),
            )
            .unwrap();
            let plan = fixture.plan();
            let expected = plan_hash(&plan).unwrap();
            assert!(fixture.install(plan, &expected).is_err());
            assert_eq!(fs::read(&fixture.source).unwrap(), b"owned new binary");
            assert_eq!(fs::read(&fixture.destination).unwrap(), b"owned old binary");
        }
        #[test]
        fn precommit_interruption_preserves_old_bytes_and_postcommit_sync_is_explicit() {
            for point in [1, 2] {
                let fixture = Fixture::new();
                fixture.existing();
                let plan = fixture.plan();
                let expected = plan_hash(&plan).unwrap();
                FAULT.with(|fault| fault.set(point));
                let result = fixture.install(plan, &expected);
                FAULT.with(|fault| fault.set(0));
                if point == 1 {
                    assert!(result.is_err());
                    assert_eq!(fs::read(&fixture.destination).unwrap(), b"owned old binary");
                } else {
                    let value = result.unwrap();
                    assert_eq!(value["status"], "committedDurabilityUnknown");
                    assert_eq!(value["committed"], true);
                    assert_eq!(fs::read(&fixture.destination).unwrap(), b"owned new binary");
                }
                assert!(fs::read_dir(fixture.destination.parent().unwrap())
                    .unwrap()
                    .all(|entry| !entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".install-")));
            }
        }
        #[test]
        fn retained_directory_rejects_replacement_and_never_follows_the_new_route() {
            let fixture = Fixture::new();
            fixture.existing();
            let parent = fixture.destination.parent().unwrap();
            let directory = Directory::open(parent).unwrap();
            let detached = fixture._root.path().join("detached");
            fs::rename(parent, &detached).unwrap();
            let outside = fixture._root.path().join("outside");
            fs::create_dir(&outside).unwrap();
            symlink(&outside, parent).unwrap();
            assert!(directory.check().is_err());
            let mut retained = directory
                .open_file(
                    "owned-fixture",
                    libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY,
                )
                .unwrap();
            retained.write_all(b"retained").unwrap();
            assert_eq!(
                fs::read(detached.join("owned-fixture")).unwrap(),
                b"retained"
            );
            assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
        }
        #[test]
        fn oversized_source_is_rejected_before_reading() {
            let fixture = Fixture::new();
            let mut file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&fixture.source)
                .unwrap();
            file.set_len(MAXIMUM + 1).unwrap();
            assert_eq!(
                file_hash(&mut file, false).unwrap_err().class(),
                "InstallUnsafeFile"
            );
        }
    }
}

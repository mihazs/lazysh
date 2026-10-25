//! Opt-in observation of the concurrent hook fixture, never production stores.
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    process::{Command, Output},
};

const FILE_LIMIT: usize = 64;
const EXCERPT_LIMIT: usize = 128 * 1024;

pub(super) struct StorageTrace {
    spool: tempfile::TempDir,
    results: PathBuf,
    tool: PathBuf,
}

impl StorageTrace {
    pub(super) fn from_env() -> Option<Self> {
        let root = std::env::var_os("LAZYSH_TEST_STORAGE_TRACE_DIR")?;
        #[cfg(not(target_os = "linux"))]
        {
            let _ = root;
            panic!("storage syscall tracing requires Linux");
        }
        #[cfg(target_os = "linux")]
        Some(
            Self::new(Path::new(&root), Path::new("strace"))
                .expect("explicit storage tracing requested but strace/results unavailable"),
        )
    }

    fn new(root: &Path, tool: &Path) -> io::Result<Self> {
        let version = Command::new(tool).arg("--version").output()?;
        if !version.status.success() {
            return Err(io::Error::other("storage trace tool preflight failed"));
        }
        fs::create_dir_all(root)?;
        validate_metadata(&fs::symlink_metadata(root)?, true)?;
        Ok(Self {
            spool: tempfile::tempdir()?,
            results: tempfile::Builder::new()
                .prefix("concurrent-hooks-")
                .tempdir_in(root)?
                .keep(),
            tool: tool.to_owned(),
        })
    }

    pub(super) fn command(&self, worker: usize, program: &Path) -> Command {
        let mut command = Command::new(&self.tool);
        command
            .args([
                "-ff",
                "-ttt",
                "-T",
                "-yy",
                "-e",
                "trace=fcntl,fsync,fdatasync",
                "-o",
            ])
            .arg(self.spool.path().join(format!("writer-{worker}")))
            .arg("--")
            .arg(program);
        command
    }

    pub(super) fn export(&self, outputs: &[Output]) -> io::Result<()> {
        if outputs.len() > 16 {
            return Err(io::Error::other("unexpected storage trace worker count"));
        }
        let mut entries = fs::read_dir(self.spool.path())?
            .take(FILE_LIMIT + 1)
            .collect::<io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        let mut manifest = format!("fixture=concurrent_hooks_preserve_every_event observer=strace workers={}\nexport_file_limit={FILE_LIMIT} export_bytes_per_file={EXCERPT_LIMIT} raw_spool_byte_limit=none\n", outputs.len());
        for (worker, output) in outputs.iter().enumerate() {
            manifest.push_str(&format!(
                "worker={worker} status={} stdout_bytes={} stderr_bytes={}\n",
                output.status,
                output.stdout.len(),
                output.stderr.len()
            ));
        }
        for entry in entries.iter().take(FILE_LIMIT) {
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| io::Error::other("invalid trace filename"))?;
            if !valid_filename(name) {
                return Err(io::Error::other("unexpected file in owned trace spool"));
            }
            let original = copy_excerpt(&entry.path(), &self.results.join(name))?;
            manifest.push_str(&format!("trace={name} original_bytes={original}\n"));
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(self.results.join("manifest.txt"))?;
        file.write_all(manifest.as_bytes())?;
        if entries.is_empty() || entries.len() > FILE_LIMIT {
            return Err(io::Error::other(
                "missing/excess storage trace files; bounded manifest retained",
            ));
        }
        Ok(())
    }
}

fn valid_filename(name: &str) -> bool {
    let Some((worker, pid)) = name
        .strip_prefix("writer-")
        .and_then(|name| name.split_once('.'))
    else {
        return false;
    };
    !worker.is_empty()
        && worker.len() <= 2
        && worker.bytes().all(|byte| byte.is_ascii_digit())
        && !pid.is_empty()
        && pid.len() <= 10
        && pid.bytes().all(|byte| byte.is_ascii_digit())
        && worker.parse::<usize>().is_ok_and(|worker| worker < 16)
        && pid.parse::<u32>().is_ok_and(|pid| pid > 0)
}

fn validate_metadata(metadata: &fs::Metadata, directory: bool) -> io::Result<()> {
    if metadata.file_type().is_symlink()
        || (if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        })
    {
        return Err(io::Error::other(
            "trace path is not an owned regular file/directory",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid takes no pointers and observes this fixture's user.
        if metadata.uid() != unsafe { libc::geteuid() } || (!directory && metadata.nlink() != 1) {
            return Err(io::Error::other("trace file ownership/link count mismatch"));
        }
    }
    Ok(())
}

fn copy_excerpt(source: &Path, destination: &Path) -> io::Result<u64> {
    validate_metadata(&fs::symlink_metadata(source)?, false)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    }
    let mut source = options.open(source)?;
    let metadata = source.metadata()?;
    validate_metadata(&metadata, false)?;
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)?;
    if metadata.len() <= EXCERPT_LIMIT as u64 {
        io::copy(&mut source.take(EXCERPT_LIMIT as u64), &mut destination)?;
    } else {
        let marker = b"\n... middle omitted by bounded export ...\n";
        let head = EXCERPT_LIMIT / 2;
        let tail = EXCERPT_LIMIT - head - marker.len();
        io::copy(
            &mut Read::by_ref(&mut source).take(head as u64),
            &mut destination,
        )?;
        destination.write_all(marker)?;
        source.seek(SeekFrom::End(-(tail as i64)))?;
        io::copy(&mut source.take(tail as u64), &mut destination)?;
    }
    Ok(metadata.len())
}

#[test]
fn bounded_excerpt_preserves_lock_start_and_commit_end() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    let destination = dir.path().join("excerpt");
    let mut bytes = b"BEGIN_LOCK\n".to_vec();
    bytes.extend(vec![b'x'; EXCERPT_LIMIT * 3]);
    bytes.extend_from_slice(b"\nCOMMIT_UNLOCK");
    fs::write(&source, &bytes).unwrap();
    assert_eq!(
        copy_excerpt(&source, &destination).unwrap(),
        bytes.len() as u64
    );
    let excerpt = fs::read(destination).unwrap();
    assert_eq!(excerpt.len(), EXCERPT_LIMIT);
    assert!(excerpt.starts_with(b"BEGIN_LOCK\n"));
    assert!(excerpt.ends_with(b"\nCOMMIT_UNLOCK"));
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn explicitly_requested_missing_tool_fails_before_creating_results() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("results");
    assert!(StorageTrace::new(&root, &dir.path().join("absent-strace")).is_err());
    assert!(!root.exists());
}

#[test]
fn export_retains_only_a_bounded_number_of_owned_pid_files() {
    let results = tempfile::tempdir().unwrap();
    let trace = StorageTrace {
        spool: tempfile::tempdir().unwrap(),
        results: results.path().to_owned(),
        tool: PathBuf::from("unused"),
    };
    for pid in 1..=FILE_LIMIT + 1 {
        fs::write(
            trace.spool.path().join(format!("writer-0.{pid}")),
            b"fcntl fixture\n",
        )
        .unwrap();
    }
    assert!(
        trace.export(&[]).is_err(),
        "excess files must be reported, not silently ignored"
    );
    let files = fs::read_dir(results.path())
        .unwrap()
        .collect::<io::Result<Vec<_>>>()
        .unwrap();
    assert_eq!(files.len(), FILE_LIMIT + 1); // excerpts plus bounded manifest
    assert!(files
        .iter()
        .all(|file| file.metadata().unwrap().len() <= EXCERPT_LIMIT as u64));
    assert_eq!(
        fs::read_dir(trace.spool.path()).unwrap().count(),
        FILE_LIMIT + 1
    );
}

#[cfg(unix)]
#[test]
fn trace_export_rejects_symlinks_and_hard_links_without_reading_them() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("untouched");
    fs::write(&target, b"fixture sentinel").unwrap();
    let link = dir.path().join("linked");
    symlink(&target, &link).unwrap();
    assert!(copy_excerpt(&link, &dir.path().join("symlink-excerpt")).is_err());
    fs::remove_file(&link).unwrap();
    fs::hard_link(&target, &link).unwrap();
    assert!(copy_excerpt(&link, &dir.path().join("hardlink-excerpt")).is_err());
    assert_eq!(fs::read(target).unwrap(), b"fixture sentinel");
}

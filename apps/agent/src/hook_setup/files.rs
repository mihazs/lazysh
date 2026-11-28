use super::{
    json,
    record::{self, Agent, Binary, FileState, Identity, Owned, Record},
    render,
    state::{self, Observation},
};
use crate::{
    managed_directory::{open, Directory},
    Error, Result,
};
use lazysh_common::storage_filesystem;
use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "linux", target_os = "macos"))]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
};

/// The mode a freshly staged file reports: owner-only on POSIX hosts, an ordinary writable file on Windows,
/// where access is the DACL's and the read-only attribute is the only mode there is.
#[cfg(unix)]
pub(super) const NEW_FILE_MODE: u32 = 0o600;
#[cfg(windows)]
pub(super) const NEW_FILE_MODE: u32 = 0o666;

pub(super) fn rejected(kind: &'static str) -> Error {
    Error::Installation(kind)
}
/// Admission is intentionally limited to retained leaf descriptors, not ancestors.
/// Any POSIX or macOS extended ACL is refused: the commit path cannot preserve one.
///
/// `private` asks for a file nobody but the owner, the system and the administrators can open at all; the other
/// level only keeps foreign accounts from changing it. A POSIX host enforces `private` through the mode.
pub(super) fn ordinary_acl(file: &std::fs::File, private: bool) -> Result<()> {
    #[cfg(unix)]
    let _ = private;
    #[cfg(target_os = "linux")]
    {
        for name in [c"system.posix_acl_access", c"system.posix_acl_default"] {
            // SAFETY: the retained descriptor and NUL-terminated name are valid;
            // a null buffer with size zero requests only the attribute length.
            let result = unsafe {
                libc::fgetxattr(file.as_raw_fd(), name.as_ptr(), std::ptr::null_mut(), 0)
            };
            if result >= 0 {
                return Err(rejected("HooksUnhandledAcl"));
            }
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ENODATA) {
                return Err(rejected("HooksAclUnsupported"));
            }
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        crate::managed_directory::admit(
            file,
            if private {
                lazysh_common::windows_acl::Need::Private
            } else {
                lazysh_common::windows_acl::Need::NoForeignChange
            },
        )
    }
    #[cfg(target_os = "macos")]
    {
        // <sys/acl.h> is not exposed by libc. An entry-free file has no extended ACL:
        // Darwin then returns NULL with ENOENT, while ENOTSUP and the like mean the
        // filesystem cannot answer, which stays unsupported rather than assumed absent.
        unsafe extern "C" {
            fn acl_get_fd_np(fd: libc::c_int, kind: libc::c_uint) -> *mut libc::c_void;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }
        const ACL_TYPE_EXTENDED: libc::c_uint = 0x100;
        // SAFETY: the retained descriptor is valid; a returned ACL is released exactly once.
        let acl = unsafe { acl_get_fd_np(file.as_raw_fd(), ACL_TYPE_EXTENDED) };
        if !acl.is_null() {
            unsafe { acl_free(acl) };
            return Err(rejected("HooksUnhandledAcl"));
        }
        match io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOENT) => Ok(()),
            _ => Err(rejected("HooksAclUnsupported")),
        }
    }
}
pub(super) fn directory_admission(directory: &Directory) -> Result<()> {
    directory.check()?;
    ordinary_acl(&directory.file, false)
}
#[derive(Clone)]
pub(super) struct Target {
    pub agent: Agent,
    pub profile: PathBuf,
}
#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Action {
    Install,
    Remove,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Plan {
    pub schema_version: u8,
    pub action: Action,
    pub agent: Agent,
    pub profile: PathBuf,
    pub profile_identity: [u64; 2],
    pub provider_parent_identity: Option<[u64; 2]>,
    pub provider: FileState,
    pub provider_group: Option<u32>,
    pub manifest: FileState,
    pub binary: Binary,
    pub transition: Option<Record>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amp_shadows: Option<[Option<Identity>; 2]>,
}
impl Plan {
    pub(super) fn digest(&self) -> Result<String> {
        Ok(record::hash(
            &serde_json::to_vec(self).map_err(|_| rejected("HooksInvalidPlan"))?,
        ))
    }
}
pub(super) struct ReadFile {
    pub state: FileState,
    pub contents: Option<String>,
    pub group: Option<u32>,
}
#[cfg(unix)]
pub(super) fn identity(metadata: &std::fs::Metadata) -> Identity {
    Identity {
        device: metadata.dev(),
        inode: metadata.ino(),
        owner: metadata.uid(),
        mode: metadata.mode(),
        links: metadata.nlink(),
        bytes: metadata.len(),
        modified: [metadata.mtime(), metadata.mtime_nsec()],
        changed: [metadata.ctime(), metadata.ctime_nsec()],
    }
}
/// What the open file is, by its handle or descriptor: the same object whatever its name does later.
pub(super) fn file_identity(file: &std::fs::File) -> io::Result<Identity> {
    #[cfg(unix)]
    {
        Ok(identity(&file.metadata()?))
    }
    #[cfg(windows)]
    {
        let info = crate::managed_directory::info(file)?;
        // 100 ns ticks since 1601 as whole seconds and nanoseconds, the shape the record keeps for times.
        let time = |ticks: i64| {
            [
                ticks.div_euclid(10_000_000),
                ticks.rem_euclid(10_000_000) * 100,
            ]
        };
        Ok(Identity {
            device: info.volume,
            inode: info.index,
            // The SID is admitted from the DACL at every read, not remembered here.
            owner: 0,
            mode: if info.is_read_only() { 0o444 } else { 0o666 },
            links: info.links,
            bytes: info.bytes,
            modified: time(info.written),
            changed: time(info.changed),
        })
    }
}
/// Device and file number of an open file, to tell a staged file from a replacement of its name.
pub(super) fn file_id(file: &std::fs::File) -> Option<[u64; 2]> {
    file_identity(file)
        .ok()
        .map(|identity| [identity.device, identity.inode])
}
/// A provider file must be a plain file only its owner can change, and for the record only its owner can open.
fn unsafe_file(file: &std::fs::File, identity: &Identity, private_file: bool) -> bool {
    #[cfg(unix)]
    {
        let _ = file;
        identity.owner != unsafe { libc::geteuid() }
            || identity.links != 1
            || identity.mode & 0o7022 != 0
            || (private_file && identity.mode & 0o777 != 0o600)
    }
    #[cfg(windows)]
    {
        let _ = private_file;
        identity.links != 1
            || crate::managed_directory::info(file).is_ok_and(|info| info.is_reparse_point())
    }
}
#[cfg(unix)]
fn group(metadata: &std::fs::Metadata) -> Option<u32> {
    Some(metadata.gid())
}
#[cfg(windows)]
fn group(_: &std::fs::Metadata) -> Option<u32> {
    None
}
pub(super) fn read(
    directory: &Directory,
    name: &str,
    private_file: bool,
    maximum: usize,
) -> Result<ReadFile> {
    let mut file = match directory.open_file(name, open::READ) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(ReadFile {
                state: FileState::Missing,
                contents: None,
                group: None,
            })
        }
        Err(error) => return Err(error.into()),
    };
    let before = file.metadata()?;
    let identity_before = file_identity(&file)?;
    if !before.is_file()
        || unsafe_file(&file, &identity_before, private_file)
        || before.len() > maximum as u64
    {
        return Err(rejected("HooksUnsafeFile"));
    }
    ordinary_acl(&file, private_file)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if identity_before != file_identity(&file)?
        || group(&before) != group(&after)
        || bytes.len() != before.len() as usize
    {
        return Err(rejected("HooksChangedFile"));
    }
    let sha256 = record::hash(&bytes);
    let contents = String::from_utf8(bytes).map_err(|_| rejected("HooksInvalidConfiguration"))?;
    Ok(ReadFile {
        state: FileState::Present {
            identity: identity_before,
            sha256,
        },
        contents: Some(contents),
        group: group(&before),
    })
}
pub(super) fn binary(path: &Path) -> Result<Binary> {
    if !record::valid_path(path) {
        return Err(rejected("HooksInvalidBinary"));
    }
    let parent = Directory::executable_parent(
        path.parent()
            .ok_or_else(|| rejected("HooksInvalidBinary"))?,
    )?;
    let basename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| rejected("HooksInvalidBinary"))?;
    let mut file = parent.open_file(basename, open::READ)?;
    let before = file.metadata()?;
    let identity_before = file_identity(&file)?;
    if !before.is_file()
        || unsafe_binary(&file, &identity_before, basename)
        || before.len() == 0
        || before.len() > 64 * 1024 * 1024
    {
        return Err(rejected("HooksUnsafeBinary"));
    }
    let mut digest = Sha256::new();
    let bytes = io::copy(&mut (&mut file).take(64 * 1024 * 1024 + 1), &mut digest)?;
    parent.check()?;
    let at_path = file_identity(&parent.open_file(basename, open::READ)?)?;
    if identity_before != file_identity(&file)?
        || identity_before != at_path
        || bytes != before.len()
    {
        return Err(rejected("HooksChangedBinary"));
    }
    parent.check()?;
    Ok(Binary {
        path: path.to_owned(),
        sha256: format!("{:x}", digest.finalize()),
        identity: identity_before,
    })
}
/// The bound executable must be a plain file that only its owner, root or the administrators can change,
/// and one the host can run.
fn unsafe_binary(file: &std::fs::File, identity: &Identity, basename: &str) -> bool {
    #[cfg(unix)]
    {
        let _ = (file, basename);
        (identity.owner != 0 && identity.owner != unsafe { libc::geteuid() })
            || identity.links != 1
            || identity.mode & 0o022 != 0
            || identity.mode & 0o111 == 0
    }
    #[cfg(windows)]
    {
        identity.links != 1
            || !Path::new(basename)
                .extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
            || crate::managed_directory::info(file).is_ok_and(|info| info.is_reparse_point())
            || ordinary_acl(file, false).is_err()
    }
}
pub(super) struct Inspection {
    pub target: Target,
    pub profile: Directory,
    pub plugins: Option<Directory>,
    pub provider: ReadFile,
    pub manifest: ReadFile,
    pub record: Option<Record>,
    pub observation: Option<Observation>,
    pub binary: Binary,
    pub amp_shadows: Option<[Option<Identity>; 2]>,
}
/// Metadata of the entry itself: never follow a link or read a foreign same-name plugin.
#[cfg(any(target_os = "linux", windows))]
fn entry_identity(directory: &Directory, name: &str) -> Result<Option<Identity>> {
    match directory.open_file(name, open::ENTRY) {
        Ok(file) => Ok(Some(file_identity(&file)?)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}
/// Darwin has no `O_PATH`; `fstatat` reads the same metadata without opening the entry.
#[cfg(target_os = "macos")]
fn entry_identity(directory: &Directory, name: &str) -> Result<Option<Identity>> {
    let name = std::ffi::CString::new(name).map_err(io::Error::other)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: the retained directory descriptor and NUL-terminated name are valid and
    // the buffer is initialized only after a successful call.
    let result = unsafe {
        libc::fstatat(
            directory.file.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::NotFound {
            Ok(None)
        } else {
            Err(error.into())
        };
    }
    // SAFETY: fstatat succeeded.
    let stat = unsafe { stat.assume_init() };
    Ok(Some(Identity {
        device: stat.st_dev as u64,
        inode: stat.st_ino,
        owner: stat.st_uid,
        mode: u32::from(stat.st_mode),
        links: u64::from(stat.st_nlink),
        bytes: stat.st_size as u64,
        modified: [stat.st_mtime, stat.st_mtime_nsec],
        changed: [stat.st_ctime, stat.st_ctime_nsec],
    }))
}
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn entry_identity(directory: &Directory, name: &str) -> Result<Option<Identity>> {
    let _ = (directory, name);
    Err(rejected("HooksAclUnsupported"))
}
/// Metadata only: do not traverse or read a foreign same-name plugin.
pub(super) fn amp_shadows(
    agent: Agent,
    directory: Option<&Directory>,
) -> Result<Option<[Option<Identity>; 2]>> {
    if agent != Agent::Amp {
        return Ok(None);
    }
    let Some(directory) = directory else {
        return Ok(Some([None, None]));
    };
    let mut snapshot = [None, None];
    for (slot, name) in snapshot.iter_mut().zip(["lazysh.ts", "lazysh"]) {
        *slot = entry_identity(directory, name)?;
    }
    Ok(Some(snapshot))
}
impl Inspection {
    pub(super) fn provider_name(&self) -> &'static str {
        self.target.agent.provider_name()
    }
    pub(super) fn manifest_name(&self) -> String {
        format!(".lazysh-hooks-{}.json", self.target.agent.name())
    }
    fn previous(&self) -> Result<Option<Owned>> {
        Ok(match (&self.record, &self.observation) {
            (Some(record), Some(Observation::Configured)) => record.next.clone(),
            (Some(record), Some(Observation::Prepared)) => record.previous.clone(),
            (_, Some(Observation::Conflict)) => return Err(rejected("HooksConflict")),
            _ => None,
        })
    }
    pub(super) fn desired(&self) -> Result<Owned> {
        let entries = render::entries(self.target.agent, &self.binary.path).map_err(rejected)?;
        let plugin_sha256 = if self.target.agent.is_whole_file() {
            Some(record::hash(
                render::owned_file(self.target.agent, &self.binary.path)
                    .map_err(rejected)?
                    .as_bytes(),
            ))
        } else {
            None
        };
        Ok(Owned {
            template_version: 1,
            package_version: env!("CARGO_PKG_VERSION").into(),
            binary: self.binary.clone(),
            entries,
            plugin_sha256,
        })
    }
    pub(super) fn plan(&self, action: Action) -> Result<Plan> {
        let previous = self.previous()?;
        let next = match action {
            Action::Install => {
                if self
                    .amp_shadows
                    .as_ref()
                    .is_some_and(|items| items.iter().any(Option::is_some))
                {
                    return Err(rejected("HooksAmpShadow"));
                }
                Some(self.desired()?)
            }
            Action::Remove => None,
        };
        if self.target.agent.is_whole_file()
            && previous.is_none()
            && next.is_some()
            && self.provider.contents.is_some()
        {
            return Err(rejected("HooksForeignPlugin"));
        }
        let reuse = previous == next && self.observation != Some(Observation::Prepared);
        let transition = if reuse {
            None
        } else {
            let after = self.after(previous.as_ref(), next.as_ref())?;
            let record = Record {
                schema_version: 1,
                product: "lazysh".into(),
                agent: self.target.agent,
                profile: self.profile.path.clone(),
                profile_identity: self.profile.identity()?,
                previous,
                next,
                provider_before: self.provider.state.clone(),
                provider_after_sha256: after.as_ref().map(|text| record::hash(text.as_bytes())),
            };
            record.validate().map_err(rejected)?;
            Some(record)
        };
        Ok(Plan {
            schema_version: 1,
            action,
            agent: self.target.agent,
            profile: self.profile.path.clone(),
            profile_identity: self.profile.identity()?,
            provider_parent_identity: self.plugins.as_ref().map(Directory::identity).transpose()?,
            provider: self.provider.state.clone(),
            provider_group: self.provider.group,
            manifest: self.manifest.state.clone(),
            binary: self.binary.clone(),
            transition,
            amp_shadows: self.amp_shadows.clone(),
        })
    }
    pub(super) fn after(
        &self,
        previous: Option<&Owned>,
        next: Option<&Owned>,
    ) -> Result<Option<String>> {
        if previous.is_none() && next.is_none() {
            return Ok(self.provider.contents.clone());
        }
        if self.target.agent.is_whole_file() {
            return next
                .map(|_| render::owned_file(self.target.agent, &self.binary.path).map_err(rejected))
                .transpose();
        }
        let previous = previous
            .map(|owned| owned.entries.as_slice())
            .unwrap_or_default();
        let next = next
            .map(|owned| owned.entries.as_slice())
            .unwrap_or_default();
        render::configuration(
            self.target.agent,
            self.provider.contents.as_deref().unwrap_or("{}\n"),
            previous,
            next,
        )
        .map(Some)
        .map_err(|_| rejected("HooksConflict"))
    }
}
pub(super) fn inspect(target: Target, source: &Path) -> Result<Inspection> {
    if !record::valid_path(&target.profile) {
        return Err(rejected("HooksInvalidProfile"));
    }
    let profile = Directory::profile(&target.profile)?;
    storage_filesystem::require_local(&profile.path)?;
    directory_admission(&profile)?;
    let plugins = if target.agent.is_whole_file() {
        match profile.child(
            target.agent.asset_directory().expect("whole-file agent"),
            false,
        ) {
            Ok(directory) => Some(directory),
            Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        }
    } else {
        None
    };
    if let Some(directory) = &plugins {
        directory_admission(directory)?;
    }
    let provider_name = target.agent.provider_name();
    let provider = if target.agent.is_whole_file() && plugins.is_none() {
        ReadFile {
            state: FileState::Missing,
            contents: None,
            group: None,
        }
    } else {
        read(
            plugins.as_ref().unwrap_or(&profile),
            provider_name,
            false,
            json::MAXIMUM,
        )?
    };
    // Creating a standalone Droid file could shadow settings/legacy fallback hooks.
    if target.agent == Agent::Droid && provider.state == FileState::Missing {
        return Err(rejected("HooksDroidStandaloneRequired"));
    }
    // Kimi's config.toml is foreign-owned and secret-bearing: appending to it never creates it.
    if target.agent == Agent::KimiCode && provider.state == FileState::Missing {
        return Err(rejected("HooksKimiConfigRequired"));
    }
    let manifest = read(
        &profile,
        &format!(".lazysh-hooks-{}.json", target.agent.name()),
        true,
        64 * 1024,
    )?;
    let record = manifest
        .contents
        .as_ref()
        .map(|contents| Record::decode(contents.as_bytes()).map_err(rejected))
        .transpose()?;
    // A profile's device and inode legitimately change (a btrfs subvolume gets a new anonymous device number
    // after a reboot, a restored or copied profile gets a new inode). The record's own checksum, the settings
    // classification below and the plan's identity check at apply time keep it bound; the next write rebinds it.
    if record
        .as_ref()
        .is_some_and(|record| record.agent != target.agent || record.profile != profile.path)
    {
        return Err(rejected("HooksForeignRecord"));
    }
    let observation = record
        .as_ref()
        .map(|record| {
            state::classify(record, &provider.state, provider.contents.as_deref()).map_err(rejected)
        })
        .transpose()?;
    let binary = binary(source)?;
    let amp_shadows = amp_shadows(target.agent, plugins.as_ref())?;
    directory_admission(&profile)?;
    if let Some(plugins) = &plugins {
        directory_admission(plugins)?;
    }
    Ok(Inspection {
        target,
        profile,
        plugins,
        provider,
        manifest,
        record,
        observation,
        binary,
        amp_shadows,
    })
}

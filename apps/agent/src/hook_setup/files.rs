use super::{
    json,
    record::{self, Agent, Binary, FileState, Identity, Owned, Record},
    render,
    state::{self, Observation},
};
use crate::{managed_directory::Directory, Error, Result};
use lazysh_common::storage_filesystem;
use serde::Serialize;
use sha2::{Digest, Sha256};
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
use std::{
    io::{self, Read},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
};

pub(super) fn rejected(kind: &'static str) -> Error {
    Error::Installation(kind)
}
/// Admission is intentionally limited to retained leaf descriptors, not ancestors.
/// Native macOS ACL absence semantics still require runtime qualification.
pub(super) fn ordinary_acl(file: &std::fs::File) -> Result<()> {
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
    #[cfg(not(target_os = "linux"))]
    {
        let _ = file;
        Err(rejected("HooksAclUnsupported"))
    }
}
pub(super) fn directory_admission(directory: &Directory) -> Result<()> {
    directory.check()?;
    ordinary_acl(&directory.file)
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
pub(super) fn read(
    directory: &Directory,
    name: &str,
    private_file: bool,
    maximum: usize,
) -> Result<ReadFile> {
    let mut file = match directory.open_file(name, libc::O_RDONLY) {
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
    if !before.is_file()
        || before.uid() != unsafe { libc::geteuid() }
        || before.nlink() != 1
        || before.mode() & 0o7022 != 0
        || before.len() > maximum as u64
        || (private_file && before.mode() & 0o777 != 0o600)
    {
        return Err(rejected("HooksUnsafeFile"));
    }
    ordinary_acl(&file)?;
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    let after = file.metadata()?;
    if identity(&before) != identity(&after)
        || before.gid() != after.gid()
        || bytes.len() != before.len() as usize
    {
        return Err(rejected("HooksChangedFile"));
    }
    let sha256 = record::hash(&bytes);
    let contents = String::from_utf8(bytes).map_err(|_| rejected("HooksInvalidConfiguration"))?;
    Ok(ReadFile {
        state: FileState::Present {
            identity: identity(&before),
            sha256,
        },
        contents: Some(contents),
        group: Some(before.gid()),
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
    let mut file = parent.open_file(basename, libc::O_RDONLY)?;
    let before = file.metadata()?;
    let owner = unsafe { libc::geteuid() };
    if !before.is_file()
        || (before.uid() != 0 && before.uid() != owner)
        || before.nlink() != 1
        || before.mode() & 0o022 != 0
        || before.mode() & 0o111 == 0
        || before.len() == 0
        || before.len() > 64 * 1024 * 1024
    {
        return Err(rejected("HooksUnsafeBinary"));
    }
    let mut digest = Sha256::new();
    let bytes = io::copy(&mut (&mut file).take(64 * 1024 * 1024 + 1), &mut digest)?;
    parent.check()?;
    let at_path = parent.open_file(basename, libc::O_RDONLY)?.metadata()?;
    if identity(&before) != identity(&file.metadata()?)
        || identity(&before) != identity(&at_path)
        || bytes != before.len()
    {
        return Err(rejected("HooksChangedBinary"));
    }
    parent.check()?;
    Ok(Binary {
        path: path.to_owned(),
        sha256: format!("{:x}", digest.finalize()),
        identity: identity(&before),
    })
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
    #[cfg(target_os = "linux")]
    {
        let mut snapshot = [None, None];
        for (slot, name) in snapshot.iter_mut().zip(["lazysh.ts", "lazysh"]) {
            *slot = match directory.open_file(name, libc::O_PATH) {
                Ok(file) => Some(identity(&file.metadata()?)),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
        }
        Ok(Some(snapshot))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = directory;
        Err(rejected("HooksAclUnsupported"))
    }
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
    if record.as_ref().is_some_and(|record| {
        record.agent != target.agent
            || record.profile != profile.path
            || profile.identity().ok() != Some(record.profile_identity)
    }) {
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

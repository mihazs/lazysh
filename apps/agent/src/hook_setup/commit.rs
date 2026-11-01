//! Only explicit inspected plans reach these bounded local filesystem mutations.
//! The cooperative lock and final preimage checks do not provide an atomic CAS
//! against a noncooperating editor changing the path after the last check.
use super::{
    files::{self, rejected, Action, Inspection, Plan, Target},
    json,
    record::{self, FileState},
    state::{self, Observation},
};
use crate::{managed_directory::Directory, Error, Result};
use lazysh_common::fs as private;
use serde::Serialize;
use std::{
    fs::File,
    io::Write,
    os::unix::{
        fs::{MetadataExt, PermissionsExt},
        io::AsRawFd,
    },
    path::Path,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum Boundary {
    BeforeRecord,
    AfterRecord,
    BeforeProvider,
    AfterProvider,
}
#[cfg(test)]
type Interruption = Box<dyn FnMut(Boundary) -> Result<()>>;
#[cfg(test)]
thread_local! {pub(super) static INTERRUPT:std::cell::RefCell<Option<Interruption>>=const{std::cell::RefCell::new(None)};}
fn boundary(point: Boundary) -> Result<()> {
    #[cfg(test)]
    INTERRUPT.with(|slot| match slot.borrow_mut().as_mut() {
        Some(callback) => callback(point),
        None => Ok(()),
    })?;
    let _ = point;
    Ok(())
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Outcome {
    pub status: &'static str,
    pub metadata_committed: bool,
    pub provider_committed: bool,
    pub reason: Option<&'static str>,
}
struct Lock(File);
impl Drop for Lock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}
struct Stage<'a> {
    directory: &'a Directory,
    name: String,
    identity: [u64; 2],
    file: File,
    published: bool,
}
impl Drop for Stage<'_> {
    fn drop(&mut self) {
        if !self.published
            && self
                .directory
                .open_file(&self.name, libc::O_RDONLY)
                .and_then(|file| file.metadata())
                .is_ok_and(|metadata| [metadata.dev(), metadata.ino()] == self.identity)
        {
            let _ = self.directory.remove(&self.name, false);
        }
    }
}
impl<'a> Stage<'a> {
    fn new(directory: &'a Directory, contents: &str) -> Result<Self> {
        files::directory_admission(directory)?;
        let name = format!(".lazysh-hooks-stage-{}", uuid::Uuid::new_v4());
        let file = directory.open_file(&name, libc::O_RDWR | libc::O_CREAT | libc::O_EXCL)?;
        let metadata = file.metadata()?;
        let mut stage = Self {
            directory,
            name,
            identity: [metadata.dev(), metadata.ino()],
            file,
            published: false,
        };
        stage
            .file
            .set_permissions(std::fs::Permissions::from_mode(0o600))?;
        files::ordinary_acl(&stage.file)?;
        stage.file.write_all(contents.as_bytes())?;
        stage.file.sync_all()?;
        Ok(stage)
    }
    fn check(&self, contents: &str, mode: u32, group: Option<u32>) -> Result<()> {
        files::directory_admission(self.directory)?;
        let current = files::read(self.directory, &self.name, false, json::MAXIMUM)?;
        if !matches!(&current.state,FileState::Present{identity,..} if [identity.device,identity.inode]==self.identity && identity.mode&0o7777==mode)
            || current.contents.as_deref() != Some(contents)
            || group.is_some_and(|group| current.group != Some(group))
        {
            return Err(rejected("HooksChangedStage"));
        }
        Ok(())
    }
    fn permissions(&mut self, mode: u32, group: Option<u32>) -> Result<()> {
        files::ordinary_acl(&self.file)?;
        if let Some(group) = group {
            if self.file.metadata()?.gid() != group {
                // SAFETY: change only this owned staging descriptor; retain its current UID.
                if unsafe { libc::fchown(self.file.as_raw_fd(), !0, group) } != 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
        }
        self.file
            .set_permissions(std::fs::Permissions::from_mode(mode))?;
        self.file.sync_all()?;
        Ok(())
    }
    fn publish(&mut self, name: &str, missing: bool) -> Result<()> {
        self.directory.rename(&self.name, name, missing)?;
        self.published = true;
        Ok(())
    }
}
fn read_provider(
    current: &Inspection,
    provider: &Directory,
    missing_parent: bool,
) -> Result<files::ReadFile> {
    if !missing_parent {
        return files::read(provider, current.provider_name(), false, json::MAXIMUM);
    }
    match current.profile.child("plugins", false) {
        Err(Error::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(files::ReadFile {
                state: FileState::Missing,
                contents: None,
                group: None,
            })
        }
        Err(error) => Err(error),
        Ok(_) => Err(rejected("HooksStalePlan")),
    }
}
fn verify(
    current: &Inspection,
    provider: &Directory,
    missing_parent: bool,
    expected_manifest: &FileState,
    plan: &Plan,
) -> Result<()> {
    files::directory_admission(&current.profile)?;
    files::directory_admission(provider)?;
    let actual_provider = read_provider(current, provider, missing_parent)?;
    if files::read(&current.profile, &current.manifest_name(), true, 64 * 1024)?.state
        != *expected_manifest
        || actual_provider.state != plan.provider
        || actual_provider.group != plan.provider_group
        || files::binary(&plan.binary.path)? != plan.binary
    {
        return Err(rejected("HooksStalePlan"));
    }
    Ok(())
}
fn no_change(action: Action) -> Outcome {
    Outcome {
        status: match action {
            Action::Install => "reused",
            Action::Remove => "absent",
        },
        metadata_committed: false,
        provider_committed: false,
        reason: None,
    }
}
pub(super) fn apply(
    target: Target,
    source: &Path,
    action: Action,
    expected: &str,
) -> Result<Outcome> {
    if !lazysh_common::valid_sha256(expected) {
        return Err(rejected("HooksInvalidPlan"));
    }
    let initial = files::inspect(target.clone(), source)?;
    let original = initial.plan(action)?;
    if original.digest()? != expected {
        return Err(rejected("HooksStalePlan"));
    }
    if original.transition.is_none() {
        return Ok(no_change(action));
    }
    files::directory_admission(&initial.profile)?;
    let lock = initial
        .profile
        .open_file(".lazysh-hooks.lock", libc::O_RDWR | libc::O_CREAT)?;
    if !private::owner_only(&lock.metadata()?, false) || lock.metadata()?.len() != 0 {
        return Err(rejected("HooksUnsafeLock"));
    }
    files::ordinary_acl(&lock)?;
    lock.try_lock().map_err(|_| rejected("HooksBusy"))?;
    let _lock = Lock(lock);
    let current = files::inspect(target, source)?;
    let plan = current.plan(action)?;
    if plan.digest()? != expected {
        return Err(rejected("HooksStalePlan"));
    }
    let Some(record) = &plan.transition else {
        return Ok(no_change(action));
    };
    let after = current.after(record.previous.as_ref(), record.next.as_ref())?;
    if after.as_ref().map(|text| record::hash(text.as_bytes())) != record.provider_after_sha256 {
        return Err(rejected("HooksInvalidPlan"));
    }
    let changing_provider = after != current.provider.contents;
    if changing_provider
        && matches!(&plan.provider,FileState::Present{identity,..} if identity.mode&0o200==0)
    {
        return Err(rejected("HooksReadOnlyConfiguration"));
    }
    let new_plugins =
        if current.target.agent.is_plugin() && current.plugins.is_none() && after.is_some() {
            files::directory_admission(&current.profile)?;
            current.profile.mkdir("plugins")?;
            current.profile.file.sync_all()?;
            Some(current.profile.child("plugins", false)?)
        } else {
            None
        };
    let provider = current
        .plugins
        .as_ref()
        .or(new_plugins.as_ref())
        .unwrap_or(&current.profile);
    let missing_parent =
        current.target.agent.is_plugin() && current.plugins.is_none() && new_plugins.is_none();
    let receipt = String::from_utf8(record.encode().map_err(rejected)?)
        .map_err(|_| rejected("HooksInvalidRecord"))?;
    let mut staged_record = Stage::new(&current.profile, &receipt)?;
    let mut staged_provider = if changing_provider {
        after
            .as_ref()
            .map(|text| Stage::new(provider, text))
            .transpose()?
    } else {
        None
    };
    let mut metadata_committed = false;
    let mut provider_committed = false;
    let work = (|| -> Result<()> {
        boundary(Boundary::BeforeRecord)?;
        verify(&current, provider, missing_parent, &plan.manifest, &plan)?;
        staged_record.check(&receipt, 0o600, None)?;
        staged_record.publish(
            &current.manifest_name(),
            plan.manifest == FileState::Missing,
        )?;
        metadata_committed = true;
        current.profile.file.sync_all()?;
        boundary(Boundary::AfterRecord)?;
        let prepared = files::read(&current.profile, &current.manifest_name(), true, 64 * 1024)?;
        if prepared.contents.as_deref() != Some(&receipt) {
            return Err(rejected("HooksChangedRecord"));
        }
        if let Some(stage) = &mut staged_provider {
            let mode = match &plan.provider {
                FileState::Missing => 0o600,
                FileState::Present { identity, .. } => identity.mode & 0o777,
            };
            stage.permissions(mode, plan.provider_group)?;
        }
        boundary(Boundary::BeforeProvider)?;
        verify(&current, provider, missing_parent, &prepared.state, &plan)?;
        if changing_provider {
            match (&mut staged_provider, &after) {
                (Some(stage), Some(text)) => {
                    let mode = match &plan.provider {
                        FileState::Missing => 0o600,
                        FileState::Present { identity, .. } => identity.mode & 0o777,
                    };
                    stage.check(text, mode, plan.provider_group)?;
                    stage.publish(current.provider_name(), plan.provider == FileState::Missing)?;
                }
                (None, None) => provider.remove(current.provider_name(), false)?,
                _ => return Err(rejected("HooksInvalidPlan")),
            }
            provider_committed = true;
            provider.file.sync_all()?;
        }
        boundary(Boundary::AfterProvider)?;
        files::directory_admission(&current.profile)?;
        files::directory_admission(provider)?;
        let final_provider = read_provider(&current, provider, missing_parent)?;
        if after.is_some()
            && plan.provider_group.is_some()
            && final_provider.group != plan.provider_group
        {
            return Err(rejected("HooksChangedGroup"));
        }
        let expected = if record.next.is_some() {
            Observation::Configured
        } else {
            Observation::Removed
        };
        if state::classify(
            record,
            &final_provider.state,
            final_provider.contents.as_deref(),
        )
        .map_err(rejected)?
            != expected
            || files::read(&current.profile, &current.manifest_name(), true, 64 * 1024)?
                .contents
                .as_deref()
                != Some(&receipt)
        {
            return Err(rejected("HooksVerificationFailed"));
        }
        Ok(())
    })();
    match work {
        Err(error) if metadata_committed => Ok(Outcome {
            status: "uncertain",
            metadata_committed,
            provider_committed,
            reason: Some(match error {
                Error::Installation(reason) => reason,
                _ => "HooksFilesystem",
            }),
        }),
        Err(error) => Err(error),
        Ok(()) => Ok(Outcome {
            status: if record.next.is_some() {
                "configured"
            } else {
                "removed"
            },
            metadata_committed,
            provider_committed,
            reason: None,
        }),
    }
}

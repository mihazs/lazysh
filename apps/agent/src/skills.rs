//! Packaged product skills; installation is separate from agent hooks and configuration.
use crate::{Error, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, ValueEnum)]
#[serde(rename_all = "kebab-case")]
pub enum Skill {
    HostSetup,
    AgentReporting,
}
impl Skill {
    fn name(self) -> &'static str {
        match self {
            Self::HostSetup => "lazysh-host-setup",
            Self::AgentReporting => "lazysh-agent-reporting",
        }
    }
    fn body(self) -> &'static str {
        match self {
            Self::HostSetup => include_str!("../skills/lazysh-host-setup/SKILL.md"),
            Self::AgentReporting => include_str!("../skills/lazysh-agent-reporting/SKILL.md"),
        }
    }
}
#[derive(Clone, Copy, Serialize, ValueEnum)]
#[serde(rename_all = "lowercase")]
pub enum AgentProfile {
    Claude,
    Codex,
}
#[derive(Args)]
pub struct Target {
    #[arg(long, value_enum)]
    pub agent: AgentProfile,
    /// Existing per-user agent configuration directory, never bootstrapped by this command.
    #[arg(long)]
    pub profile_root: Option<PathBuf>,
    #[arg(long, value_enum)]
    pub skill: Skill,
}
#[derive(Subcommand)]
pub enum Command {
    /// Print the exact packaged Markdown without accessing an agent profile.
    Preview {
        #[arg(long, value_enum)]
        skill: Skill,
    },
    /// Inspect ownership and return separate install/remove plan hashes without writing.
    Status {
        #[command(flatten)]
        target: Target,
    },
    Install {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        expected_plan: String,
    },
    Remove {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        expected_plan: String,
    },
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn rejected(kind: &'static str) -> Error {
    Error::Installation(kind)
}
pub fn run(command: Command) -> Result<Value> {
    if let Command::Preview { skill } = command {
        return Ok(
            json!({"schemaVersion":1,"skill":skill.name(),"version":env!("CARGO_PKG_VERSION"),"sha256":hash(skill.body().as_bytes()),"content":skill.body()}),
        );
    }
    manage(command)
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
use unix::run as manage;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn manage(command: Command) -> Result<Value> {
    match command {
        Command::Status { .. } => {
            Ok(json!({"schemaVersion":1,"supported":false,"reason":"SkillInstallationUnsupported"}))
        }
        _ => Err(rejected("SkillInstallationUnsupported")),
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
mod unix {
    use super::*;
    use crate::managed_directory::Directory;
    use lazysh_common::{fs as private, storage_filesystem};
    use std::{
        ffi::CStr,
        fs::File,
        io::{self, Read, Write},
        os::unix::{fs::MetadataExt, io::IntoRawFd},
    };
    const FILE: &str = "SKILL.md";
    const MARKER: &str = "\n<!-- lazysh-managed-product-skill ";
    const MAXIMUM: usize = 16 * 1024;
    #[derive(Serialize, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Receipt {
        schema_version: u8,
        product: String,
        skill: String,
        version: String,
        sha256: String,
    }
    fn rendered(skill: Skill) -> Result<Vec<u8>> {
        let receipt = Receipt {
            schema_version: 1,
            product: "lazysh".into(),
            skill: skill.name().into(),
            version: env!("CARGO_PKG_VERSION").into(),
            sha256: hash(skill.body().as_bytes()),
        };
        let receipt = serde_json::to_string(&receipt).map_err(|_| Error::InvalidArgument)?;
        let bytes = format!("{}{MARKER}{receipt} -->\n", skill.body()).into_bytes();
        if bytes.len() > MAXIMUM {
            return Err(rejected("SkillTooLarge"));
        }
        Ok(bytes)
    }
    #[derive(Clone, Debug, PartialEq, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Identity {
        device: u64,
        inode: u64,
        bytes: u64,
        modified_seconds: i64,
        modified_nanos: i64,
        changed_seconds: i64,
        changed_nanos: i64,
        owner: u32,
        mode: u32,
        links: u64,
    }
    fn identity(metadata: &std::fs::Metadata) -> Identity {
        Identity {
            device: metadata.dev(),
            inode: metadata.ino(),
            bytes: metadata.len(),
            modified_seconds: metadata.mtime(),
            modified_nanos: metadata.mtime_nsec(),
            changed_seconds: metadata.ctime(),
            changed_nanos: metadata.ctime_nsec(),
            owner: metadata.uid(),
            mode: metadata.mode(),
            links: metadata.nlink(),
        }
    }
    #[derive(Clone, Debug, PartialEq, Serialize)]
    #[serde(tag = "state", rename_all = "camelCase")]
    enum Existing {
        Missing,
        Owned {
            directory: [u64; 2],
            file: Identity,
            sha256: String,
            version: String,
        },
    }
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Plan {
        schema_version: u8,
        agent: AgentProfile,
        profile_root: PathBuf,
        profile_identity: [u64; 2],
        skills_root_identity: Option<[u64; 2]>,
        skill: String,
        package_version: &'static str,
        source_sha256: String,
        existing: Existing,
    }
    impl Plan {
        fn digest(&self, action: &str) -> Result<String> {
            Ok(hash(
                &serde_json::to_vec(&json!({"action":action,"plan":self}))
                    .map_err(|_| Error::InvalidArgument)?,
            ))
        }
        fn value(&self) -> Result<Value> {
            Ok(
                json!({"schemaVersion":1,"supported":true,"destination":self.profile_root.join("skills").join(&self.skill).join(FILE),"plan":self,"installPlanSha256":self.digest("install")?,"removePlanSha256":self.digest("remove")?}),
            )
        }
    }
    struct Inspection {
        plan: Plan,
        profile: Directory,
        root: Option<Directory>,
    }
    fn profile_path(target: &Target) -> Result<PathBuf> {
        let (variable, fallback) = match target.agent {
            AgentProfile::Claude => ("CLAUDE_CONFIG_DIR", ".claude"),
            AgentProfile::Codex => ("CODEX_HOME", ".codex"),
        };
        let path = target
            .profile_root
            .clone()
            .or_else(|| std::env::var_os(variable).map(PathBuf::from))
            .or_else(|| dirs::home_dir().map(|home| home.join(fallback)))
            .ok_or_else(|| rejected("SkillProfileMissing"))?;
        if !path.is_absolute()
            || path
                .to_str()
                .is_none_or(|text| text.len() > 4096 || text.chars().any(char::is_control))
        {
            return Err(Error::InvalidArgument);
        }
        Ok(path)
    }
    fn child(parent: &Directory, name: &str, private: bool) -> Result<Option<Directory>> {
        match parent.child(name, private) {
            Ok(directory) => Ok(Some(directory)),
            Err(Error::Io(error)) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error),
        }
    }
    struct Listing(*mut libc::DIR);
    impl Drop for Listing {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    fn sole_file(directory: &Directory, ignore: Option<&str>) -> Result<()> {
        // SAFETY: fdopendir takes this fresh duplicate; only this inspection reads its cursor.
        let fd = directory.file.try_clone()?.into_raw_fd();
        let stream = unsafe { libc::fdopendir(fd) };
        if stream.is_null() {
            let error = io::Error::last_os_error();
            unsafe {
                libc::close(fd);
            }
            return Err(error.into());
        }
        let stream = Listing(stream);
        unsafe {
            libc::rewinddir(stream.0);
        }
        let mut found = false;
        loop {
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            let entry = unsafe { libc::readdir(stream.0) };
            if entry.is_null() {
                if io::Error::last_os_error().raw_os_error() != Some(0) {
                    return Err(io::Error::last_os_error().into());
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
            if name == b"." || name == b".." || ignore.is_some_and(|value| value.as_bytes() == name)
            {
                continue;
            }
            if name != FILE.as_bytes() || found {
                return Err(rejected("SkillForeignDirectory"));
            }
            found = true;
        }
        if !found {
            return Err(rejected("SkillForeignDirectory"));
        }
        Ok(())
    }
    fn read_file(directory: &Directory, name: &str) -> Result<(Vec<u8>, Identity)> {
        let mut file = directory.open_file(name, libc::O_RDONLY)?;
        let before = file.metadata()?;
        if !private::owner_only(&before, false)
            || before.mode() & 0o777 != 0o600
            || before.len() > MAXIMUM as u64
        {
            return Err(rejected("SkillUnsafeFile"));
        }
        let mut bytes = Vec::new();
        (&mut file)
            .take(MAXIMUM as u64 + 1)
            .read_to_end(&mut bytes)?;
        let after = file.metadata()?;
        if identity(&before) != identity(&after)
            || bytes.len() != before.len() as usize
            || !private::owner_only(&after, false)
        {
            return Err(rejected("SkillChangedFile"));
        }
        Ok((bytes, identity(&before)))
    }
    fn existing(root: &Directory, skill: Skill, ignore: Option<&str>) -> Result<Existing> {
        let Some(directory) = child(root, skill.name(), true)? else {
            return Ok(Existing::Missing);
        };
        sole_file(&directory, ignore)?;
        let (bytes, file_identity) = read_file(&directory, FILE)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| rejected("SkillForeignFile"))?;
        let (body, receipt) = text
            .rsplit_once(MARKER)
            .ok_or_else(|| rejected("SkillForeignFile"))?;
        let receipt = receipt
            .strip_suffix(" -->\n")
            .ok_or_else(|| rejected("SkillForeignFile"))?;
        let receipt: Receipt =
            serde_json::from_str(receipt).map_err(|_| rejected("SkillForeignFile"))?;
        if receipt.schema_version != 1
            || receipt.product != "lazysh"
            || receipt.skill != skill.name()
            || receipt.sha256 != hash(body.as_bytes())
            || receipt.version.is_empty()
            || receipt.version.len() > 64
        {
            return Err(rejected("SkillModifiedFile"));
        }
        directory.check()?;
        Ok(Existing::Owned {
            directory: directory.identity()?,
            file: file_identity,
            sha256: hash(&bytes),
            version: receipt.version,
        })
    }
    fn inspect(target: &Target) -> Result<Inspection> {
        let profile = Directory::profile(&profile_path(target)?)?;
        storage_filesystem::require_local(&profile.path)?;
        let root = child(&profile, "skills", false)?;
        let current = root
            .as_ref()
            .map(|root| existing(root, target.skill, None))
            .transpose()?
            .unwrap_or(Existing::Missing);
        profile.check()?;
        if let Some(root) = &root {
            root.check()?;
        }
        let plan = Plan {
            schema_version: 1,
            agent: target.agent,
            profile_root: profile.path.clone(),
            profile_identity: profile.identity()?,
            skills_root_identity: root.as_ref().map(Directory::identity).transpose()?,
            skill: target.skill.name().into(),
            package_version: env!("CARGO_PKG_VERSION"),
            source_sha256: hash(&rendered(target.skill)?),
            existing: current,
        };
        Ok(Inspection {
            plan,
            profile,
            root,
        })
    }
    struct Lock(File);
    impl Drop for Lock {
        fn drop(&mut self) {
            let _ = self.0.unlock();
        }
    }
    struct Temporary<'a> {
        directory: &'a Directory,
        name: String,
        file_identity: Option<[u64; 2]>,
        container: Option<(&'a Directory, String, [u64; 2])>,
        committed: bool,
    }
    impl Drop for Temporary<'_> {
        fn drop(&mut self) {
            if self.committed {
                return;
            }
            if let (Some(expected), Ok(file)) = (
                self.file_identity,
                self.directory.open_file(&self.name, libc::O_RDONLY),
            ) {
                if file
                    .metadata()
                    .is_ok_and(|m| [m.dev(), m.ino()] == expected)
                {
                    let _ = self.directory.remove(&self.name, false);
                }
            }
            if let Some((parent, name, expected)) = &self.container {
                if parent
                    .child(name, true)
                    .and_then(|dir| dir.identity())
                    .is_ok_and(|id| id == *expected)
                {
                    let _ = parent.remove(name, true);
                }
            }
        }
    }
    fn check_current(
        inspection: &Inspection,
        root: &Directory,
        skill: Skill,
        ignore: Option<&str>,
    ) -> Result<()> {
        inspection.profile.check()?;
        root.check()?;
        if existing(root, skill, ignore)? != inspection.plan.existing {
            return Err(rejected("SkillStalePlan"));
        }
        Ok(())
    }
    #[cfg(test)]
    thread_local! { static BEFORE_COMMIT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) }; }
    fn before_commit() {
        #[cfg(test)]
        BEFORE_COMMIT.with(|hook| {
            if let Some(hook) = hook.borrow_mut().take() {
                hook();
            }
        });
    }
    fn mutate(target: Target, expected: &str, remove: bool) -> Result<Value> {
        if !lazysh_common::valid_sha256(expected) {
            return Err(Error::InvalidArgument);
        }
        let action = if remove { "remove" } else { "install" };
        let inspected = inspect(&target)?;
        if inspected.plan.digest(action)? != expected {
            return Err(rejected("SkillStalePlan"));
        }
        if remove && inspected.plan.existing == Existing::Missing {
            return Ok(json!({"schemaVersion":1,"status":"absent","committed":false}));
        }
        if !remove
            && matches!(&inspected.plan.existing,Existing::Owned{sha256,..} if sha256==&inspected.plan.source_sha256)
        {
            return Ok(json!({"schemaVersion":1,"status":"reused","committed":false}));
        }
        let lock = inspected
            .profile
            .open_file(".lazysh-product-skills.lock", libc::O_RDWR | libc::O_CREAT)?;
        if !private::owner_only(&lock.metadata()?, false) || lock.metadata()?.len() != 0 {
            return Err(rejected("SkillUnsafeLock"));
        }
        lock.try_lock().map_err(|_| rejected("SkillBusy"))?;
        let _lock = Lock(lock);
        let mut inspected = inspect(&target)?;
        if inspected.plan.digest(action)? != expected {
            return Err(rejected("SkillStalePlan"));
        }
        let root = match inspected.root.take() {
            Some(root) => root,
            None => {
                inspected.profile.check()?;
                inspected.profile.mkdir("skills")?;
                inspected.profile.file.sync_all()?;
                inspected.profile.child("skills", false)?
            }
        };
        check_current(&inspected, &root, target.skill, None)?;
        if remove {
            let directory = root.child(target.skill.name(), true)?;
            before_commit();
            check_current(&inspected, &root, target.skill, None)?;
            directory.check()?;
            directory.remove(FILE, false)?;
            let durable = directory.file.sync_all().is_ok()
                && root
                    .child(target.skill.name(), true)
                    .and_then(|current| current.identity())
                    .is_ok_and(|id| directory.identity().is_ok_and(|expected| expected == id))
                && root.remove(target.skill.name(), true).is_ok()
                && root.file.sync_all().is_ok()
                && inspected.profile.check().is_ok()
                && root.check().is_ok();
            return Ok(
                json!({"schemaVersion":1,"status":if durable {"removed"} else {"committedDurabilityUnknown"},"committed":true}),
            );
        }
        let bytes = rendered(target.skill)?;
        let temporary_name = format!(".lazysh-skill-{}", uuid::Uuid::new_v4());
        let fresh = inspected.plan.existing == Existing::Missing;
        let destination = if fresh {
            root.mkdir(&temporary_name)?;
            root.child(&temporary_name, true)?
        } else {
            root.child(target.skill.name(), true)?
        };
        let file_name = if fresh { FILE } else { &temporary_name };
        let mut temporary = Temporary {
            directory: &destination,
            name: file_name.into(),
            file_identity: None,
            container: if fresh {
                Some((&root, temporary_name.clone(), destination.identity()?))
            } else {
                None
            },
            committed: false,
        };
        let mut file =
            destination.open_file(file_name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)?;
        let metadata = file.metadata()?;
        temporary.file_identity = Some([metadata.dev(), metadata.ino()]);
        file.write_all(&bytes)?;
        file.sync_all()?;
        destination.file.sync_all()?;
        before_commit();
        check_current(
            &inspected,
            &root,
            target.skill,
            if fresh { None } else { Some(&temporary_name) },
        )?;
        let (staged, staged_identity) = read_file(&destination, file_name)?;
        if staged != bytes
            || Some([staged_identity.device, staged_identity.inode]) != temporary.file_identity
        {
            return Err(rejected("SkillStagedFileChanged"));
        }
        destination.check()?;
        if fresh {
            root.rename(&temporary_name, target.skill.name(), true)?;
        } else {
            destination.rename(&temporary_name, FILE, false)?;
        }
        temporary.committed = true;
        let durable = if fresh {
            root.file.sync_all()
        } else {
            destination.file.sync_all()
        }
        .is_ok()
            && inspected.profile.check().is_ok()
            && root.check().is_ok()
            && matches!(existing(&root,target.skill,None),Ok(Existing::Owned{sha256,..}) if sha256==hash(&bytes));
        Ok(
            json!({"schemaVersion":1,"status":if durable {"installed"} else {"committedDurabilityUnknown"},"committed":true}),
        )
    }
    pub(super) fn run(command: Command) -> Result<Value> {
        match command {
            Command::Status { target } => inspect(&target)?.plan.value(),
            Command::Install {
                target,
                expected_plan,
            } => mutate(target, &expected_plan, false),
            Command::Remove {
                target,
                expected_plan,
            } => mutate(target, &expected_plan, true),
            Command::Preview { .. } => unreachable!(),
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{fs, path::Path};
        fn target(profile: &Path) -> Target {
            Target {
                agent: AgentProfile::Claude,
                profile_root: Some(profile.into()),
                skill: Skill::HostSetup,
            }
        }
        fn setup() -> (tempfile::TempDir, PathBuf) {
            let temp = tempfile::tempdir().unwrap();
            let profile = temp.path().canonicalize().unwrap().join("profile");
            fs::create_dir(&profile).unwrap();
            (temp, profile)
        }
        fn plan(profile: &Path, remove: bool) -> String {
            inspect(&target(profile))
                .unwrap()
                .plan
                .digest(if remove { "remove" } else { "install" })
                .unwrap()
        }
        fn install(profile: &Path) {
            assert_eq!(
                mutate(target(profile), &plan(profile, false), false).unwrap()["status"],
                "installed"
            );
        }
        #[test]
        fn ancestor_replacement_before_commit_never_writes_the_replacement_profile() {
            for linked in [false, true] {
                let (temp, profile) = setup();
                let old = temp.path().join("old-profile");
                let victim = temp.path().join("victim");
                fs::create_dir(&victim).unwrap();
                fs::write(victim.join("sentinel"), b"untouched").unwrap();
                let expected = plan(&profile, false);
                let (p, o, v) = (profile.clone(), old.clone(), victim.clone());
                BEFORE_COMMIT.with(|hook| {
                    *hook.borrow_mut() = Some(Box::new(move || {
                        fs::rename(&p, &o).unwrap();
                        if linked {
                            std::os::unix::fs::symlink(&v, &p).unwrap();
                        } else {
                            fs::create_dir(&p).unwrap();
                            fs::write(p.join("sentinel"), b"replacement").unwrap();
                        }
                    }))
                });
                assert!(mutate(target(&profile), &expected, false).is_err());
                assert_eq!(fs::read(victim.join("sentinel")).unwrap(), b"untouched");
                assert!(!profile.join("skills").exists());
                assert_eq!(fs::read_dir(old.join("skills")).unwrap().count(), 0);
                if !linked {
                    assert_eq!(fs::read(profile.join("sentinel")).unwrap(), b"replacement");
                }
            }
        }
        #[test]
        fn user_edit_after_plan_remains_intact_and_staging_is_removed() {
            let (_temp, profile) = setup();
            install(&profile);
            let file = profile.join("skills/lazysh-host-setup/SKILL.md");
            let text = fs::read_to_string(&file)
                .unwrap()
                .replace(env!("CARGO_PKG_VERSION"), "0.1.0");
            fs::write(&file, text).unwrap();
            let expected = plan(&profile, false);
            let edited = file.clone();
            BEFORE_COMMIT.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    fs::write(edited, b"user edit wins").unwrap()
                }))
            });
            assert!(mutate(target(&profile), &expected, false).is_err());
            assert_eq!(fs::read(&file).unwrap(), b"user edit wins");
            assert_eq!(fs::read_dir(file.parent().unwrap()).unwrap().count(), 1);
        }
        #[test]
        fn replaced_staging_directory_cannot_publish_or_cleanup_foreign_contents() {
            let (temp, profile) = setup();
            let expected = plan(&profile, false);
            let moved = temp.path().join("moved-stage");
            let p = profile.clone();
            BEFORE_COMMIT.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    let root = p.join("skills");
                    let stage = fs::read_dir(&root).unwrap().next().unwrap().unwrap().path();
                    fs::rename(&stage, &moved).unwrap();
                    fs::create_dir(&stage).unwrap();
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&stage, fs::Permissions::from_mode(0o700)).unwrap();
                    fs::write(stage.join(FILE), b"foreign staged directory").unwrap();
                }))
            });
            assert!(mutate(target(&profile), &expected, false).is_err());
            assert!(!profile.join("skills/lazysh-host-setup").exists());
            let remaining = fs::read_dir(profile.join("skills"))
                .unwrap()
                .next()
                .unwrap()
                .unwrap()
                .path();
            assert_eq!(
                fs::read(remaining.join(FILE)).unwrap(),
                b"foreign staged directory"
            );
        }
        #[test]
        fn changed_staged_bytes_are_not_published_and_remove_keeps_replacement_folder() {
            let (temp, profile) = setup();
            let expected = plan(&profile, false);
            let p = profile.clone();
            BEFORE_COMMIT.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    let stage = fs::read_dir(p.join("skills"))
                        .unwrap()
                        .next()
                        .unwrap()
                        .unwrap()
                        .path();
                    fs::write(stage.join(FILE), b"changed stage").unwrap();
                }))
            });
            assert!(mutate(target(&profile), &expected, false).is_err());
            assert_eq!(fs::read_dir(profile.join("skills")).unwrap().count(), 0);
            install(&profile);
            let expected = plan(&profile, true);
            let p = profile.clone();
            let moved = temp.path().join("old-skill");
            BEFORE_COMMIT.with(|hook| {
                *hook.borrow_mut() = Some(Box::new(move || {
                    let folder = p.join("skills/lazysh-host-setup");
                    fs::rename(&folder, moved).unwrap();
                    fs::create_dir(&folder).unwrap();
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
                    fs::write(folder.join(FILE), b"replacement skill").unwrap();
                }))
            });
            assert!(mutate(target(&profile), &expected, true).is_err());
            assert_eq!(
                fs::read(profile.join("skills/lazysh-host-setup/SKILL.md")).unwrap(),
                b"replacement skill"
            );
        }
    }
}

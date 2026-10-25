//! Nonsecret device-local intent survives loss of the separately protected proof.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
};
const LIMIT: u64 = 256;
pub(super) const STORAGE: &str = "Cannot read or commit native resume protection policy";
#[derive(Clone)]
pub(super) struct PolicyStore {
    path: PathBuf,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    enabled: bool,
}
pub(super) struct ChangeError {
    pub message: String,
    pub locked: bool,
}
impl ChangeError {
    fn new(message: impl Into<String>, locked: bool) -> Self {
        Self {
            message: message.into(),
            locked,
        }
    }
}
pub(super) trait Proof {
    fn exists(&self) -> Result<bool, String>;
    fn create_verified(&self) -> Result<(), String>;
    fn authenticate(&self) -> Result<(), String>;
    fn remove(&self) -> Result<(), String>;
}
impl PolicyStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }
    fn read(&self) -> Result<Option<bool>, String> {
        let file = match fs::File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err(STORAGE.into()),
        };
        let mut bytes = Vec::new();
        file.take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| STORAGE)?;
        if bytes.len() as u64 > LIMIT {
            return Err(STORAGE.into());
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| STORAGE)?;
        if record.version != 1 {
            return Err(STORAGE.into());
        }
        Ok(Some(record.enabled))
    }
    pub fn write(&self, enabled: bool) -> Result<(), String> {
        let parent = self.path.parent().ok_or(STORAGE)?;
        let mut directory = fs::DirBuilder::new();
        directory.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            directory.mode(0o700);
        }
        directory.create(parent).map_err(|_| STORAGE)?;
        let temporary = parent.join(format!(".resume-lock-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> Result<(), String> {
            let options = lazysh_common::fs::private_create_new();
            let mut file = options.open(&temporary).map_err(|_| STORAGE)?;
            let bytes = serde_json::to_vec(&Record {
                version: 1,
                enabled,
            })
            .map_err(|_| STORAGE)?;
            file.write_all(&bytes).map_err(|_| STORAGE)?;
            file.sync_all().map_err(|_| STORAGE)?;
            fs::rename(&temporary, &self.path).map_err(|_| STORAGE)?;
            #[cfg(unix)]
            fs::File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| STORAGE)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(temporary);
        }
        result
    }
    /// Only absent intent AND absent proof is a fresh/default-off installation.
    pub fn initialize(&self, proof: &impl Proof) -> Result<bool, String> {
        if self.read()? == Some(true) {
            return Ok(true);
        }
        if proof.exists()? {
            self.write(true)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
    pub fn enable(&self, proof: &impl Proof) -> Result<(), ChangeError> {
        if self.read().map_err(|e| ChangeError::new(e, true))? == Some(true) {
            return Err(ChangeError::new(
                "Resume protection is already recorded as enabled",
                true,
            ));
        }
        if proof.exists().map_err(|e| ChangeError::new(e, true))? {
            return Err(ChangeError::new(
                "An existing resume proof requires restarting the protected workspace",
                true,
            ));
        }
        if let Err(message) = proof.create_verified() {
            // This operation started from known OFF with no pre-existing proof. Only a
            // confirmed cleanup may restore that prior state; absence alone is insufficient.
            let cleaned = proof.remove().is_ok() && matches!(proof.exists(), Ok(false));
            let locked = !cleaned || !matches!(self.read(), Ok(None | Some(false)));
            if locked {
                let _ = self.write(true);
            }
            return Err(ChangeError::new(message, locked));
        }
        // Do not delete a recovery proof after attempting this durable commit: even
        // an error can mean rename succeeded but its durability acknowledgement failed.
        self.write(true).map_err(|e| ChangeError::new(e, true))
    }
    pub fn disable(&self, proof: &impl Proof) -> Result<(), ChangeError> {
        proof
            .authenticate()
            .map_err(|e| ChangeError::new(e, true))?;
        // Commit authorized OFF before deleting its recovery proof. If interrupted,
        // the remaining proof makes startup conservatively migrate back to ON.
        if let Err(error) = self.write(false) {
            let _ = self.write(true);
            return Err(ChangeError::new(error, true));
        }
        let removed = proof.remove().and_then(|()| {
            if proof.exists()? {
                Err("The resume proof is still present".into())
            } else {
                Ok(())
            }
        });
        if let Err(error) = removed {
            let _ = self.write(true);
            return Err(ChangeError::new(error, true));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    struct Fake {
        present: Cell<bool>,
        fail_create: bool,
        fail_auth: bool,
        fail_remove: bool,
        remove_calls: Cell<u8>,
    }
    impl Fake {
        fn new(present: bool) -> Self {
            Self {
                present: Cell::new(present),
                fail_create: false,
                fail_auth: false,
                fail_remove: false,
                remove_calls: Cell::new(0),
            }
        }
    }
    impl Proof for Fake {
        fn exists(&self) -> Result<bool, String> {
            Ok(self.present.get())
        }
        fn create_verified(&self) -> Result<(), String> {
            self.present.set(true);
            if self.fail_create {
                Err("cancelled".into())
            } else {
                Ok(())
            }
        }
        fn authenticate(&self) -> Result<(), String> {
            if self.fail_auth || !self.present.get() {
                Err("unavailable".into())
            } else {
                Ok(())
            }
        }
        fn remove(&self) -> Result<(), String> {
            self.remove_calls.set(self.remove_calls.get() + 1);
            if self.fail_remove {
                Err("delete failed".into())
            } else {
                self.present.set(false);
                Ok(())
            }
        }
    }
    fn store(root: &std::path::Path) -> PolicyStore {
        PolicyStore::new(root.join("resume-lock-policy.json"))
    }
    #[test]
    fn cold_start_uses_durable_intent_even_when_proof_is_gone() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let proof = Fake::new(false);
        assert!(!store.initialize(&proof).unwrap());
        store.write(true).unwrap();
        assert!(store.initialize(&proof).unwrap());
        let authority = super::super::AccessState::default();
        authority
            .initialize(true, store.initialize(&proof).unwrap(), "synthetic".into())
            .unwrap();
        assert!(authority.status().unwrap().locked);
        assert!(authority.lease(None).is_err());
    }
    #[test]
    fn legacy_and_interrupted_disable_proofs_migrate_to_enabled() {
        for existing_false in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            if existing_false {
                store.write(false).unwrap();
            }
            assert!(store.initialize(&Fake::new(true)).unwrap());
            assert_eq!(store.read().unwrap(), Some(true));
        }
    }
    #[test]
    fn corrupt_unknown_and_oversized_policy_never_default_off() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        for bytes in [
            b"bad".to_vec(),
            br#"{"version":2,"enabled":false}"#.to_vec(),
            vec![b' '; 257],
        ] {
            fs::write(&store.path, bytes).unwrap();
            assert!(store.initialize(&Fake::new(false)).is_err());
        }
    }
    #[test]
    fn cancelled_new_enrollment_rolls_back_only_after_known_cleanup() {
        for failed_cleanup in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            let mut proof = Fake::new(false);
            proof.fail_create = true;
            proof.fail_remove = failed_cleanup;
            let error = store.enable(&proof).err().unwrap();
            assert_eq!(error.locked, failed_cleanup);
            assert_eq!(store.initialize(&proof).unwrap(), failed_cleanup);
        }
    }
    #[test]
    fn committed_enable_and_authenticated_disable_survive_relaunch() {
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let proof = Fake::new(false);
        store.enable(&proof).ok().unwrap();
        assert_eq!(store.read().unwrap(), Some(true));
        store.disable(&proof).ok().unwrap();
        assert_eq!(store.read().unwrap(), Some(false));
        assert!(!store.initialize(&proof).unwrap());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&store.path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }
    #[test]
    fn failed_disable_authentication_or_delete_keeps_enabled_intent() {
        for fail_auth in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let store = store(root.path());
            store.write(true).unwrap();
            let mut proof = Fake::new(true);
            proof.fail_auth = fail_auth;
            proof.fail_remove = !fail_auth;
            assert!(store.disable(&proof).err().unwrap().locked);
            assert_eq!(store.read().unwrap(), Some(true));
            assert!(proof.present.get());
            if fail_auth {
                assert_eq!(proof.remove_calls.get(), 0);
            }
        }
    }
    #[test]
    fn failed_true_commit_preserves_new_proof_instead_of_rolling_it_back() {
        struct CommitFailure<'a> {
            inner: Fake,
            path: &'a std::path::Path,
        }
        impl Proof for CommitFailure<'_> {
            fn exists(&self) -> Result<bool, String> {
                self.inner.exists()
            }
            fn create_verified(&self) -> Result<(), String> {
                self.inner.create_verified()?;
                // Fail the atomic rename after native proof creation/authentication.
                fs::create_dir(self.path).unwrap();
                Ok(())
            }
            fn authenticate(&self) -> Result<(), String> {
                self.inner.authenticate()
            }
            fn remove(&self) -> Result<(), String> {
                self.inner.remove()
            }
        }
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        let proof = CommitFailure {
            inner: Fake::new(false),
            path: &store.path,
        };
        assert!(store.enable(&proof).err().unwrap().locked);
        assert!(proof.inner.present.get());
        assert_eq!(proof.inner.remove_calls.get(), 0);
        assert!(store.initialize(&proof).is_err());
        fs::remove_dir(&store.path).unwrap();
        assert!(store.initialize(&proof).unwrap());
    }
    #[test]
    fn disable_commits_false_only_after_auth_and_before_deleting_proof() {
        struct Ordered<'a> {
            inner: Fake,
            store: &'a PolicyStore,
        }
        impl Proof for Ordered<'_> {
            fn exists(&self) -> Result<bool, String> {
                self.inner.exists()
            }
            fn create_verified(&self) -> Result<(), String> {
                unreachable!()
            }
            fn authenticate(&self) -> Result<(), String> {
                assert_eq!(self.store.read()?, Some(true));
                self.inner.authenticate()
            }
            fn remove(&self) -> Result<(), String> {
                assert_eq!(self.store.read()?, Some(false));
                self.inner.remove()
            }
        }
        let root = tempfile::tempdir().unwrap();
        let store = store(root.path());
        store.write(true).unwrap();
        let proof = Ordered {
            inner: Fake::new(true),
            store: &store,
        };
        store.disable(&proof).ok().unwrap();
        assert!(!store.initialize(&proof).unwrap());
    }
    #[test]
    fn policy_commit_failure_never_deletes_the_recovery_proof() {
        let root = tempfile::tempdir().unwrap();
        let blocked = root.path().join("blocked");
        fs::write(&blocked, b"file").unwrap();
        let store = PolicyStore::new(blocked.join("policy.json"));
        let proof = Fake::new(true);
        assert!(store.disable(&proof).err().unwrap().locked);
        assert!(proof.present.get());
        assert_eq!(proof.remove_calls.get(), 0);
        let root = tempfile::tempdir().unwrap();
        let store = PolicyStore::new(root.path().to_owned());
        let proof = Fake::new(false);
        // A read error rejects enrollment before any native mutation.
        assert!(store.enable(&proof).err().unwrap().locked);
        assert!(!proof.present.get());
    }
}

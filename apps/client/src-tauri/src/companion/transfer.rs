use super::*;
use russh_sftp::{
    client::RawSftpSession,
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use sha2::{Digest, Sha256};
fn attrs(uid: u32, mode: u32, directory: bool, size: Option<u64>, value: &FileAttributes) -> bool {
    value.uid == Some(uid)
        && value.permissions.is_some_and(|p| p & 0o777 == mode)
        && if directory {
            value.is_dir() && !value.is_symlink()
        } else {
            value.is_regular() && !value.is_symlink() && value.size == size
        }
}
fn invalid() -> SshError {
    error(
        "companion_staging",
        "Companion staging identity or bytes differ from the verified artifact",
    )
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CleanupStage {
    Admission,
    Ownership,
    CloseUpload,
    Directory,
    VerifyFile,
    RemoveFile,
    RemoveDirectory,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum CleanupReason {
    Disconnected,
    Unowned,
    Missing,
    Identity,
    Hash,
    Request,
    Timeout,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub(super) struct CleanupFailure {
    pub stage: CleanupStage,
    pub reason: CleanupReason,
}
struct VerificationFailure {
    reason: CleanupReason,
    error: SshError,
}
impl VerificationFailure {
    fn invalid(reason: CleanupReason) -> Self {
        Self {
            reason,
            error: invalid(),
        }
    }
}
impl From<russh_sftp::client::error::Error> for VerificationFailure {
    fn from(error: russh_sftp::client::error::Error) -> Self {
        let reason = if matches!(&error, russh_sftp::client::error::Error::Status(status) if status.status_code == StatusCode::NoSuchFile)
        {
            CleanupReason::Missing
        } else {
            CleanupReason::Request
        };
        Self {
            reason,
            error: error.into(),
        }
    }
}
pub(super) struct Staging {
    raw: RawSftpSession,
    pub path: String,
    directory: String,
    uid: u32,
    digest: String,
    bytes: u64,
    touched: bool,
    owned: bool,
    file_owned: bool,
    executable: bool,
    handle: Option<String>,
    cleanup_stage: CleanupStage,
}
impl Staging {
    pub fn new(raw: RawSftpSession, unix: &resolve::Unix, selection: &release::Selection) -> Self {
        let directory = format!(
            "{}/.lazysh-install-{}",
            unix.home.trim_end_matches('/'),
            uuid::Uuid::new_v4()
        );
        Self {
            raw,
            path: format!("{directory}/lazysh-agent"),
            directory,
            uid: unix.uid,
            digest: selection.digest.clone(),
            bytes: selection.bytes,
            touched: false,
            owned: false,
            file_owned: false,
            executable: false,
            handle: None,
            cleanup_stage: CleanupStage::Ownership,
        }
    }
    pub async fn upload(&mut self, home: &str, data: &[u8]) -> Result<()> {
        let actual = self.raw.realpath(home).await?.files;
        if actual.len() != 1 || actual[0].filename != home {
            return Err(invalid());
        }
        let home_attrs = self.raw.lstat(home).await?.attrs;
        if !home_attrs.is_dir()
            || home_attrs.is_symlink()
            || home_attrs.uid != Some(self.uid)
            || home_attrs.permissions.is_none_or(|p| p & 0o022 != 0)
        {
            return Err(invalid());
        }
        self.touched = true;
        self.raw
            .mkdir(
                &self.directory,
                FileAttributes {
                    permissions: Some(0o700),
                    ..FileAttributes::empty()
                },
            )
            .await?;
        if !attrs(
            self.uid,
            0o700,
            true,
            None,
            &self.raw.lstat(&self.directory).await?.attrs,
        ) {
            return Err(invalid());
        }
        self.owned = true;
        let handle = self
            .raw
            .open(
                &self.path,
                OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE,
                FileAttributes {
                    permissions: Some(0o600),
                    ..FileAttributes::empty()
                },
            )
            .await?
            .handle;
        self.file_owned = true;
        self.handle = Some(handle.clone());
        for (index, chunk) in data.chunks(65_536).enumerate() {
            self.raw
                .write(&handle, (index * 65_536) as u64, chunk.to_vec())
                .await?;
        }
        self.raw.close(&handle).await?;
        self.handle = None;
        Ok(())
    }
    pub async fn verify(&self, path: &str, mode: u32) -> Result<()> {
        self.verify_observed(path, mode)
            .await
            .map_err(|failure| failure.error)
    }
    async fn verify_observed(
        &self,
        path: &str,
        mode: u32,
    ) -> std::result::Result<(), VerificationFailure> {
        let before = self.raw.lstat(path).await?.attrs;
        if !attrs(self.uid, mode, false, Some(self.bytes), &before) {
            return Err(VerificationFailure::invalid(CleanupReason::Identity));
        }
        let handle = self
            .raw
            .open(path, OpenFlags::READ, FileAttributes::empty())
            .await?
            .handle;
        let result = async {
            if !attrs(
                self.uid,
                mode,
                false,
                Some(self.bytes),
                &self.raw.fstat(&handle).await?.attrs,
            ) {
                return Err(VerificationFailure::invalid(CleanupReason::Identity));
            }
            let mut count = 0u64;
            let mut hash = Sha256::new();
            loop {
                match self
                    .raw
                    .read(
                        &handle,
                        count,
                        ((self.bytes + 1 - count).min(65_536)) as u32,
                    )
                    .await
                {
                    Ok(data) => {
                        if data.data.is_empty() || count + data.data.len() as u64 > self.bytes {
                            return Err(VerificationFailure::invalid(CleanupReason::Identity));
                        }
                        count += data.data.len() as u64;
                        hash.update(&data.data);
                    }
                    Err(russh_sftp::client::error::Error::Status(status))
                        if status.status_code == StatusCode::Eof =>
                    {
                        break
                    }
                    Err(e) => return Err(e.into()),
                }
            }
            let after = self.raw.fstat(&handle).await?.attrs;
            let named = self.raw.lstat(path).await?.attrs;
            let digest = format!("{:x}", hash.finalize());
            if count != self.bytes
                || !attrs(self.uid, mode, false, Some(self.bytes), &after)
                || !attrs(self.uid, mode, false, Some(self.bytes), &named)
                || before.mtime != after.mtime
                || after.mtime != named.mtime
            {
                return Err(VerificationFailure::invalid(CleanupReason::Identity));
            }
            if digest != self.digest {
                return Err(VerificationFailure::invalid(CleanupReason::Hash));
            }
            Ok(())
        }
        .await;
        let close = self.raw.close(handle).await;
        result?;
        close?;
        Ok(())
    }
    pub async fn executable(&mut self) -> Result<()> {
        self.raw
            .setstat(
                &self.path,
                FileAttributes {
                    permissions: Some(0o700),
                    ..FileAttributes::empty()
                },
            )
            .await?;
        self.executable = true;
        self.verify(&self.path, 0o700).await
    }
    fn cleanup_failure(&self, reason: CleanupReason) -> CleanupFailure {
        CleanupFailure {
            stage: self.cleanup_stage,
            reason,
        }
    }
    pub fn cleanup_timeout(&self) -> CleanupFailure {
        self.cleanup_failure(CleanupReason::Timeout)
    }
    pub async fn cleanup(&mut self) -> std::result::Result<(), CleanupFailure> {
        if !self.touched {
            return Ok(());
        }
        self.cleanup_stage = CleanupStage::Ownership;
        if !self.owned {
            return Err(self.cleanup_failure(CleanupReason::Unowned));
        }
        if let Some(handle) = self.handle.take() {
            self.cleanup_stage = CleanupStage::CloseUpload;
            self.raw
                .close(handle)
                .await
                .map_err(|error| self.cleanup_failure(VerificationFailure::from(error).reason))?;
        }
        self.cleanup_stage = CleanupStage::Directory;
        let directory = self
            .raw
            .lstat(&self.directory)
            .await
            .map_err(|error| self.cleanup_failure(VerificationFailure::from(error).reason))?;
        if !attrs(self.uid, 0o700, true, None, &directory.attrs) {
            return Err(self.cleanup_failure(CleanupReason::Identity));
        }
        if self.file_owned {
            // No recursive deletion. Unknown/truncated/replaced bytes are left as residue.
            self.cleanup_stage = CleanupStage::VerifyFile;
            self.verify_observed(&self.path, if self.executable { 0o700 } else { 0o600 })
                .await
                .map_err(|error| self.cleanup_failure(error.reason))?;
            self.cleanup_stage = CleanupStage::RemoveFile;
            self.raw
                .remove(&self.path)
                .await
                .map_err(|error| self.cleanup_failure(VerificationFailure::from(error).reason))?;
            self.file_owned = false;
        }
        self.cleanup_stage = CleanupStage::RemoveDirectory;
        self.raw
            .rmdir(&self.directory)
            .await
            .map_err(|error| self.cleanup_failure(VerificationFailure::from(error).reason))?;
        Ok(())
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = self.raw.close_session();
    }
}

#[cfg(test)]
#[path = "transfer_tests.rs"]
mod tests;

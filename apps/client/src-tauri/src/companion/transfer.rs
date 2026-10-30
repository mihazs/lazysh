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
        let before = self.raw.lstat(path).await?.attrs;
        if !attrs(self.uid, mode, false, Some(self.bytes), &before) {
            return Err(invalid());
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
                return Err(invalid());
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
                            return Err(invalid());
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
            if count != self.bytes
                || format!("{:x}", hash.finalize()) != self.digest
                || !attrs(self.uid, mode, false, Some(self.bytes), &after)
                || !attrs(self.uid, mode, false, Some(self.bytes), &named)
                || before.mtime != after.mtime
                || after.mtime != named.mtime
            {
                return Err(invalid());
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
    pub async fn cleanup(&mut self) -> bool {
        if !self.touched {
            return true;
        }
        if !self.owned {
            return false;
        }
        if let Some(handle) = self.handle.take() {
            if self.raw.close(handle).await.is_err() {
                return false;
            }
        }
        if !attrs(
            self.uid,
            0o700,
            true,
            None,
            &match self.raw.lstat(&self.directory).await {
                Ok(v) => v.attrs,
                Err(_) => return false,
            },
        ) {
            return false;
        }
        if self.file_owned {
            // No recursive deletion. Unknown/truncated/replaced bytes are left as residue.
            if self
                .verify(&self.path, if self.executable { 0o700 } else { 0o600 })
                .await
                .is_err()
                || self.raw.remove(&self.path).await.is_err()
            {
                return false;
            }
            self.file_owned = false;
        }
        self.raw.rmdir(&self.directory).await.is_ok()
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

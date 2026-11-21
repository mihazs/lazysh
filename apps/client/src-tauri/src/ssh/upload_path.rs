//! SFTP names use protocol `/` separators, independent of the client OS.
use super::{check_path, Result, SshError};
use russh_sftp::client::SftpSession;

fn invalid() -> SshError {
    SshError::new(
        "invalid_path",
        "The server did not provide a bounded absolute SFTP destination",
    )
}
pub(crate) fn bounded(path: &str) -> Result<()> {
    check_path(path)?;
    if path.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(())
}
fn root_prefix(parent: &str) -> bool {
    let drive = parent.strip_prefix('/').unwrap_or(parent).as_bytes();
    parent.bytes().all(|byte| byte == b'/')
        || (drive.len() == 2 && drive[0].is_ascii_alphabetic() && drive[1] == b':')
}
fn split(path: &str) -> Result<(&str, &str)> {
    bounded(path)?;
    let (parent, name) = match path.rsplit_once('/') {
        Some((parent, name)) if root_prefix(parent) => (&path[..parent.len() + 1], name),
        Some(pair) => pair,
        None => (".", path),
    };
    if name.is_empty() || matches!(name, "." | "..") {
        return Err(invalid());
    }
    Ok((parent, name))
}
fn absolute(path: &str) -> Result<()> {
    bounded(path)?;
    // The standard form (including Win32-OpenSSH /C:/...) is slash-rooted.
    // Also preserve a server's fully qualified C:/... form, never C:relative.
    let bytes = path.as_bytes();
    if !path.starts_with('/')
        && !(bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":/")
    {
        return Err(invalid());
    }
    if path.split('/').any(|part| matches!(part, "." | "..")) {
        return Err(invalid());
    }
    Ok(())
}
fn join(parent: &str, name: &str) -> Result<String> {
    absolute(parent)?;
    let separator = if parent.ends_with('/') { "" } else { "/" };
    let destination = format!("{parent}{separator}{name}");
    bounded(&destination)?;
    Ok(destination)
}
/// Where an upload lands: an explicit remote path, or a private uniquely named
/// file in the host's shared temporary directory (the attachment default).
pub(crate) enum Destination {
    Path(String),
    Temporary(String),
}
/// A resolved absolute target. `private` targets sit in a directory other
/// accounts can list, so the new file must be readable only by its owner.
pub(super) struct Target {
    pub(super) path: String,
    pub(super) private: bool,
}
const SHARED_TEMPORARY: &str = "/tmp";
const NAME_LIMIT: usize = 255;
/// `lazysh-<random>-<name>`, bounded to one file name that keeps the extension.
pub(crate) fn temporary_name(name: &str) -> Result<String> {
    bounded(name)?;
    if name.contains(['/', '\\']) || matches!(name, "." | "..") {
        return Err(SshError::new(
            "invalid_path",
            "Enter a file name without folders for a temporary attachment",
        ));
    }
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let prefix = format!("lazysh-{}-", &unique[..12]);
    // Keep the extension so agents still recognise the file type.
    let budget = NAME_LIMIT - prefix.len();
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && extension.len() <= 16 => {
            (stem, &name[stem.len()..])
        }
        _ => (name, ""),
    };
    let mut end = budget.saturating_sub(extension.len()).min(stem.len());
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    Ok(format!("{prefix}{}{extension}", &stem[..end]))
}
pub(super) async fn target(sftp: &SftpSession, destination: Destination) -> Result<Target> {
    match destination {
        Destination::Path(path) => Ok(Target {
            path: self::destination(sftp, path).await?,
            private: false,
        }),
        Destination::Temporary(name) => {
            let name = temporary_name(&name)?;
            // Hosts without /tmp (such as Win32-OpenSSH) use the login
            // directory, which is already private to the account.
            let shared = sftp
                .metadata(SHARED_TEMPORARY)
                .await
                .is_ok_and(|metadata| metadata.is_dir());
            let parent = sftp
                .canonicalize(if shared { SHARED_TEMPORARY } else { "." })
                .await?;
            Ok(Target {
                path: join(&parent, &name)?,
                private: shared,
            })
        }
    }
}
pub(super) async fn destination(sftp: &SftpSession, path: String) -> Result<String> {
    bounded(&path)?;
    // A backslash can be a Unix filename character or a Windows separator.
    // Ask the server instead of guessing. OpenSSH permits a missing final name.
    let path = if path.contains('\\') {
        let path = sftp.canonicalize(path).await?;
        absolute(&path)?;
        path
    } else {
        path
    };
    let (parent, name) = split(&path)?;
    let parent = sftp.canonicalize(parent).await?;
    join(&parent, name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol_names_are_split_without_local_os_normalization() {
        for (input, parent, name) in [
            ("file", ".", "file"),
            ("./image's 世界.txt", ".", "image's 世界.txt"),
            ("/file", "/", "file"),
            ("//file", "//", "file"),
            ("///file", "///", "file"),
            ("C:/file", "C:/", "file"),
            ("/C:/file", "/C:/", "file"),
            ("/C:/Users/file", "/C:/Users", "file"),
            ("dir/../file", "dir/..", "file"),
        ] {
            assert_eq!(split(input).unwrap(), (parent, name));
        }
        for input in ["", "/", "dir/", "dir/.", "dir/..", "bad\nname", "bad\0name"] {
            assert!(split(input).is_err(), "{input:?}");
        }
        assert!(join(&format!("/{}", "é".repeat(2041)), "long filename").is_err());
    }
    #[test]
    fn temporary_names_are_unique_bounded_and_keep_their_extension() {
        let first = temporary_name("shot 世界's.png").unwrap();
        let second = temporary_name("shot 世界's.png").unwrap();
        assert_ne!(first, second);
        for name in [&first, &second] {
            assert!(name.starts_with("lazysh-") && name.ends_with("-shot 世界's.png"));
            assert_eq!(name.len(), "lazysh-".len() + 13 + "shot 世界's.png".len());
        }
        let long = temporary_name(&format!("{}.jpeg", "界".repeat(100))).unwrap();
        assert!(long.len() <= NAME_LIMIT && long.ends_with("界.jpeg"));
        assert!(temporary_name(&"a".repeat(255)).unwrap().len() <= NAME_LIMIT);
        assert_eq!(
            temporary_name(".profile").unwrap().len(),
            20 + ".profile".len()
        );
        for invalid in ["", ".", "..", "dir/file", "dir\\file", "bad\nname"] {
            assert!(temporary_name(invalid).is_err(), "{invalid:?}");
        }
    }
}

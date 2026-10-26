//! SFTP names use protocol `/` separators, independent of the client OS.
use super::{check_path, Result, SshError};
use russh_sftp::client::SftpSession;

fn invalid() -> SshError {
    SshError::new(
        "invalid_path",
        "The server did not provide a bounded absolute SFTP destination",
    )
}
fn bounded(path: &str) -> Result<()> {
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
}

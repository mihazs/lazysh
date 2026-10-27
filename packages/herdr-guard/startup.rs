// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Private machine startup framing. A consumer must parse only the first frame,
//! before exposing any bytes. Searching rendered output would permit spoofing.

use serde::{Deserialize, Serialize};
use std::io::{self, Write};

#[cfg(test)]
use super::protocol::decode;
use super::protocol::Secret;

const PREFIX: &[u8] = b"\x1eLAZYSH-GUARD-1:";
const MAX_STARTUP: usize = 512;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AttachTicket {
    pub(crate) boot: Secret,
    pub(crate) ticket: Secret,
}

impl AttachTicket {
    pub(crate) fn write_private_frame(&self, writer: &mut impl Write) -> io::Result<()> {
        let body = serde_json::to_vec(self).map_err(|_| io::Error::other("guard_unavailable"))?;
        if body.len() > MAX_STARTUP {
            return Err(io::Error::other("guard_unavailable"));
        }
        // ASCII length and JSON, without CR/LF: PTY output newline conversion
        // cannot corrupt the prefix. This is output, never terminal input.
        writer.write_all(PREFIX)?;
        write!(writer, "{:08x}:", body.len())?;
        writer.write_all(&body)?;
        writer.write_all(b"\x1f")?;
        writer.flush()
    }
}

/// Returns the consumed prefix only after one whole canonical startup frame.
/// None means bounded incomplete input; malformed/oversize data is fatal.
#[cfg(test)]
pub(crate) fn read_private_frame(
    bytes: &[u8],
) -> Result<Option<(AttachTicket, usize)>, &'static str> {
    let matched = bytes.len().min(PREFIX.len());
    if bytes[..matched] != PREFIX[..matched] {
        return Err("guard_unavailable");
    }
    if bytes.len() < PREFIX.len() + 9 {
        return Ok(None);
    }
    let header = &bytes[PREFIX.len()..PREFIX.len() + 8];
    if !header
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        || bytes[PREFIX.len() + 8] != b':'
    {
        return Err("guard_unavailable");
    }
    let size = usize::from_str_radix(
        std::str::from_utf8(header).map_err(|_| "guard_unavailable")?,
        16,
    )
    .map_err(|_| "guard_unavailable")?;
    if size > MAX_STARTUP {
        return Err("guard_unavailable");
    }
    let start = PREFIX.len() + 9;
    let end = start + size;
    if bytes.len() <= end {
        return Ok(None);
    }
    if bytes[end] != 0x1f {
        return Err("guard_unavailable");
    }
    let ticket = decode(&bytes[start..end]).map_err(|_| "guard_unavailable")?;
    Ok(Some((ticket, end + 1)))
}

pub(crate) fn extract_flag(mut args: Vec<String>) -> io::Result<(Vec<String>, bool)> {
    let count = args
        .iter()
        .skip(1)
        .filter(|arg| arg.as_str() == "--guarded-attach")
        .count();
    if count == 0 {
        return Ok((args, false));
    }
    if count != 1 || args.len() != 2 {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "guard_invalid"));
    }
    args.truncate(1);
    Ok((args, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_frame_is_incremental_and_never_searches_pane_output() {
        let ticket = AttachTicket {
            boot: Secret::generate().unwrap(),
            ticket: Secret::generate().unwrap(),
        };
        let mut bytes = Vec::new();
        ticket.write_private_frame(&mut bytes).unwrap();
        for split in 0..bytes.len() {
            assert!(read_private_frame(&bytes[..split]).unwrap().is_none());
        }
        let original_len = bytes.len();
        bytes.extend_from_slice(b"untrusted rendered pane output");
        let (read, used) = read_private_frame(&bytes).unwrap().unwrap();
        assert_eq!(used, original_len);
        assert!(read.boot == ticket.boot && read.ticket == ticket.ticket);
        let mut spoofed = b"pane output".to_vec();
        spoofed.extend_from_slice(&bytes);
        assert_eq!(
            read_private_frame(&spoofed).err(),
            Some("guard_unavailable")
        );
        assert_eq!(format!("{:?}", ticket.ticket), "Secret([redacted])");
    }
}

# Attachment transfer reference

## Cancellation and limits

Cancel remains available during preparation, reservation and sending. Leaving
either view abandons its operation and cancels its exact acknowledged receipt.
A reservation acknowledgement arriving after abandonment is only cancelled; its
file bytes are not sent. Native watchers also retire lost acknowledgements when
the original access lease is revoked, the session disconnects or the pending
reservation expires. There is no additional blanket background-upload policy.

The new native concurrency default is two occupied jobs, including zero-byte
files and workers still retiring, with at most 20 MiB reserved bytes. Two jobs may belong to the same SSH
session. Each receipt binds the original access generation, session and exact
byte count; a failed foreign/mismatched claim cannot remove its owner's job.
Pending reservations expire after 30 seconds. Once claimed, a transfer retains
the separate existing 30-second deadline, including SFTP setup and writes.

Cancellation stops future local work and closes that upload's SFTP stream. It
does **not** roll back bytes already accepted by the server. A partial or completed
new remote file may remain, and no remote pathname is unlinked on cancellation.
An absent receipt means unknown or already settled, not verified remote stop or
completion. Late results cannot publish success, refresh the file browser or
stage a prompt after cancellation, unmount or access revocation. Check the remote
directory explicitly when deciding whether a remaining file should be kept.

The transport observes cancellation independently of the SFTP library's outgoing
queue, including a blocked initial handshake or write. Reader and writer tasks
have independent cancellation subscriptions, and the capacity permit remains held
until both IO halves retire. An exited reader cannot strand a blocked writer.
An immediate new upload may therefore need to wait briefly for prior cleanup.

Cargo fixtures cover bounded receipts, zero-byte files, exact-size/session checks,
cancel/claim/expiry races, disconnect and lease revocation. A real SFTP protocol
peer withholding its write acknowledgement checks cancellation, stream close,
exclusive creation and absence of remove requests. The existing temporary
OpenSSH interoperability fixture uses this reservation path for real transfer,
existing-file preservation and retained SSH control. Renderer and desktop/phone
browser fixtures use synthetic native replies; they do not access user files or
certify physical-device network/lifecycle behavior.

## Remote destination paths

The destination field starts empty, and an empty destination is the default. The
host then saves the upload in `/tmp` as `/tmp/lazysh-<random>-<name>`: a 48-bit
random prefix from a fresh UUID, then the selected file name (crop/annotation
uploads use `<name>-edited.png`), bounded to 255 bytes with its extension kept.
The file name must not contain folders. The file is created exclusively with mode
`0600`. Before any byte is written, the open file is checked to be owner-only; a
server that ignored the requested mode is asked again through SETSTAT. If the file
still grants group or other access, the upload fails with `upload_not_private` and
the empty file is removed. The error says a file may remain only when that removal
also fails. Hosts without a `/tmp` directory, such as Win32-OpenSSH, save the same
unique name in the SFTP login directory instead, which is already private to the
account. The returned `/tmp` path is what Copy, Stage, Chat and terminal paste
receive. A typed path keeps the explicit behaviour below.

Host-local uploads resolve the existing parent through SFTP REALPATH before
exclusive file creation, then return the exact bounded absolute SFTP name used
for OPEN. Attachments copies/stages that returned name; Files refreshes its
returned parent. A relative input such as `./photo.png` therefore no longer
points into the terminal agent's unrelated working directory. No prompt is sent
automatically. Resolution remains inside the existing cancellable 30-second
transfer deadline and does not change receipt capacity or no-overwrite rules.

Path operations use SFTP `/` separators independently of the client's OS, as
specified in [SFTP v3 sections 6.2 and 6.11](https://www.ietf.org/archive/id/draft-ietf-secsh-filexfer-02.txt).
[Win32-OpenSSH's pinned realpath implementation](https://github.com/PowerShell/openssh-portable/blob/274893f8d1fe86c4d128b514c3af4bc10cdc0c99/contrib/win32/win32compat/misc.c#L954)
returns `/C:/...` or a slash-rooted chroot name; both are preserved. A server's
fully qualified `C:/...` response is also accepted without rewriting it. For an
input containing backslashes, the server first resolves the whole input, avoiding
a guess between a Unix literal filename and a Windows separator. Servers that
cannot canonicalize such a missing final name fail before creating a file.
Malformed, relative, control-containing or over-4096-byte destinations likewise
fail before OPEN. No overwrite fallback or retry is added, and the only pathname
removal is the empty private `/tmp` file described above.

The owned Linux OpenSSH fixture verifies a distinct SFTP initial directory and
agent CWD, including quotes, Unicode and a literal Unix backslash. Native fake
SFTP fixtures exercise Windows-shaped replies; these are not real Windows-server
acceptance. An absolute SFTP name does not prove the terminal shell sees the same
filesystem namespace: independently chrooted SFTP/shell paths may differ. No
mapping, immutable file identity or remote-filesystem race protection is claimed.

For setup and usage, see [attachments](../attachments.md). Return to the [documentation map](../README.md).

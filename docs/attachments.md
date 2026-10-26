# Private host attachments

Open Attachments for an existing SSH session, choose a file or photo, or explicitly
read a clipboard image. Nothing uploads on selection. PNG/JPEG crop and annotation
are flattened to PNG only when Upload is selected. Files are limited to 10 MiB;
editing checks declared dimensions before browser decoding (8 megapixels, at most
8192 pixels per side). Permission and decoder failures remain visible. Actual
camera/photo/clipboard permissions and memory use still need device acceptance.

Choose a destination and upload over the existing verified SSH connection. Remote
Files uses the same native transfer ownership. Both paths exclusively create a
new file; existing files are never truncated or replaced. A successful attachment
offers a shell-quoted path and an editable prompt. Copy and Stage are explicit;
upload completion never sends a prompt or terminal input. Optional expiring public
URLs use the independent, opt-in [sharing service](sharing.md).

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

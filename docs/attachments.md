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

Mosh terminal traffic and SSH file transfer use separate connections. If the
SSH connection closes while the Mosh terminal survives, the upload reports that
specific failure. Open **Connections**, connect to the same saved host using the
existing host-key verification and credential/manual-authentication flow, and
upload from that new connection. Keep the original Mosh tab open if needed.
An interrupted transfer may leave a partial new file; choose a fresh destination
or inspect that file before retrying. Uploads never overwrite it.
Recovery is explicit and never retries an upload automatically.

For a direct Mosh session, a closed-control upload error also offers **Reconnect
uploads**. Authenticate with the existing saved-credential/biometric flow or enter
credentials manually. This action does not save credentials, open a shell or PTY,
or restart Mosh. It accepts only the original verified host identity and
credential policy; changed/deleted hosts or changed server keys require a separate
new verified connection. The attachment selection, edits and destination remain
in place. After success, select **Upload attachment** yourself to retry.

Recovery replaces only this Mosh session's attachment-upload control. Files,
agent tools and other SSH features retain their original connection; use the
new-connection fallback above for those tools. Disconnecting the Mosh tab or
replacing the renderer closes its recovered upload connection. An older upload
keeps its original control handle and is never redirected to the replacement.

## Explicit terminal path paste

Standalone Attachments also offers **Paste uploaded path** after a current upload
completes. It sends only that upload's canonical, quoted path to the original
selected terminal; it does not send the editable prompt or append Enter. The
existing xterm public bracketed-paste mode and ignore option determine whether
the trusted paste delimiters are added. No bytes are sent automatically on
upload, selection, navigation or retry. The action is separate from adding an
attachment to the Chat draft.

Direct paste refuses relative/dot-segment paths, control characters, malformed
Unicode and paths larger than the existing 4096-byte native path bound. Both
slash-rooted SFTP paths and fully qualified `C:/...` forms remain supported.
Validation rejects instead of stripping or truncating. Quoting reuses the
existing POSIX-style path display; it is not a promise that every remote shell
or agent understands that convention. Review the running program and terminal
state before pasting. No shell command, Ctrl+V or Enter is synthesized.

Only one paste request is admitted at a time. Native acknowledgement means the
write was accepted, not that an agent opened the file. Closing, hiding or
revoking the original view cannot reassign a queued action or its result to a
new upload/session. Already-dispatched bytes cannot be withdrawn; failures are
not retried automatically, so inspect the terminal before any explicit retry.
The editable prompt remains unchanged. Actual remote shell/agent consumption,
camera permissions and physical device behavior require separate acceptance.

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
fail before OPEN. No overwrite fallback, pathname removal or retry is added.

The owned Linux OpenSSH fixture verifies a distinct SFTP initial directory and
agent CWD, including quotes, Unicode and a literal Unix backslash. Native fake
SFTP fixtures exercise Windows-shaped replies; these are not real Windows-server
acceptance. An absolute SFTP name does not prove the terminal shell sees the same
filesystem namespace: independently chrooted SFTP/shell paths may differ. No
mapping, immutable file identity or remote-filesystem race protection is claimed.

## Explicit Mac-host clipboard

After a successful attachment upload, **Copy raw path on Mac host** explicitly
writes its raw canonical destination to the host clipboard. The existing Copy
button separately copies shell-quoted text to this device's clipboard. Neither
operation runs automatically, sends terminal input or changes the editable prompt.
The host action uses only the original upload's verified SSH control connection
and fixed `LC_CTYPE=UTF-8 exec /usr/bin/pbcopy`, passing the path through stdin.
It never redirects to another active session or falls back to this device's
clipboard. The host login must have access to the Mac clipboard; a missing tool,
headless-login failure or unavailable clipboard is reported without discarding
the uploaded path. Linux and Windows host tools remain an issue12 parity gap.

Native eligibility is one bounded latest-upload receipt per SSH session, bound
to its original upload ID, canonical path and access generation. Selecting or
editing a source, starting another upload, cancelling, leaving Attachments or
revoking that access abandons the exact old action. The original authority is
never refreshed. The bounded native path metadata remains in memory until its
receipt is cancelled/replaced or its session is dropped; it is not persisted.
Files uploads keep their existing canonical-path callback behavior.

One clipboard request per session is admitted at a time, including channel
opening and retirement. The operation has a five-second absolute budget, followed
by separately bounded channel cleanup. Cancelling revokes eligibility and closes
the request as best effort. Bytes already delivered may still change the remote
clipboard: cancellation does not undo that effect, and an unconfirmed result must
not be interpreted as proof the clipboard stayed unchanged. Cancelling a completed
upload remains an unknown/already-settled **file** outcome, even when it revokes
clipboard eligibility. No remote pathname is removed.

Native synthetic SSH peers verify fixed command/raw stdin, exact receipt/session
binding, cancellation, ownership loss, late channel confirmation, retirement
capacity and the absolute deadline. This is fake-helper protocol evidence, not
Mac clipboard acceptance. The explicitly gated macOS Cargo test uses a temporary
owned OpenSSH server and system pbcopy/pbpaste on a disposable CI runner; it is
never intended to run against a user's clipboard. Its hosted execution is required
before claiming actual Mac-host capability acceptance. SFTP/shell namespace
identity and GUI-session clipboard availability remain host-specific limits.

## Add an attachment to Chat

In Chat, select **Add attachment** to open the same host-local editor without
leaving the existing draft. Choosing a file and completing its upload do not
change that draft. Select **Add uploaded path to Chat draft** to append the
shell-quoted canonical path, separated from existing text by a newline. This
preserves text edited while the upload was pending. Overflow beyond the existing
65,536-character draft limit is refused without truncation; shorten the draft and
retry the explicit action without another upload.

Closing the editor cancels pending upload work under the same existing partial-file
warning. A session change, expired original access lease or unmount cannot attach
an old result. The handoff advances the draft revision, so an older Send result
cannot clear the updated draft. Nothing is sent automatically: terminal staging
and any separately confirmed Chat Send keep their existing consent and destination
guards. This is a path handoff, not a provider-specific attachment API or proof of
physical camera/photo/clipboard permissions.

# SSH connections and bastions

lazysh connects directly using SSH, with password or private-key authentication. The first connection stops before authentication and displays the server's SHA256 host-key fingerprint. Verify it independently before trusting it. A changed key blocks the connection.

To route through a bastion, first save that bastion as a direct SSH host. Select it in the destination host's **Bastion** setting. A route supports one jump host; recursive routes and cycles are rejected. Remove dependent routes before deleting a bastion.

The bastion and destination have separate credentials and host-key pins. The connection dialog can use credentials previously saved for the bastion or a separately entered bastion password. To use a bastion private key, connect to that bastion directly and explicitly save its credentials in the device credential store first. Destination credentials are never reused for the bastion. The trust dialog identifies which server needs verification.

Routing uses an SSH `direct-tcpip` channel to the destination address and port, then starts a second host-key-verified SSH connection inside that channel. The bastion must permit TCP forwarding to the destination. The destination hostname is resolved by the bastion. Files, agent snapshots, and previews use the resulting destination connection.

This implementation supports SSH routing. Bastion routes and selected-identity forwarding are SSH-terminal features. A bastion's forwarding permission error is reported by the SSH server; lazysh does not change server configuration.

## SSH identity interface language

The identity generator/import inspector uses English, Brazilian Portuguese and
Spanish for its controls, encrypted-key/passphrase explanation and local public-key
clipboard failure. Changing interface language preserves focused private-key and
passphrase drafts, pending generation/inspection and returned public metadata.
It never generates, inspects, copies, selects or saves an identity automatically.
Cryptographic identifiers, key bytes, fingerprints and native errors remain verbatim.
The 12-byte UTF-8 generation requirement and explicit connection/OS-store actions
are unchanged. The panel keeps keys in memory; localization does not add storage.

## Cold saved-host desktop launch

With lazysh fully closed, run `lazysh --host SAVED_ID` (or `-host`, including
`--host=SAVED_ID`). Obtain the exact opaque ID using **Edit host → Copy host ID**
in the unlocked app. Display names, SSH configuration aliases and raw hostnames
are not alternate identifiers. IDs contain 1–100 UTF-8 bytes without control
characters. Missing or duplicate IDs fail visibly; the command does not create
or guess a host. Duplicate selectors and mixing `--dir` with a remote selector fail before startup.
A saved-host request may include the explicit multiplexer picker described below. No credentials belong in the command line.

After normal unlock, one native receipt opens the existing connection dialog.
Connect explicitly and verify any unknown host key independently. Password,
private-key, saved-credential, biometric and bastion handling use the existing
connection paths. SSH, Mosh, ET and Auto preferences remain selectable. A
successful initial SSH control connection spends the receipt, including when a
subsequent Mosh/ET bootstrap fails. Cancelling the dialog also spends it.

The receipt is bound to its original access lease and the native target/bastion
credential identities. Only an explicitly verified key-trust action updates the
corresponding frozen fingerprint; changed routing, endpoint, username, agent
forwarding or biometric policy fails closed. Display-label and transport
preference changes do not change credential identity. Lock/reunlock, renderer
replacement and failed preparation never automatically reoffer an old request.
Manual connections and workspace restoration do not consume the launch receipt.
Prepared metadata contains no credentials and is not persisted as a launch queue.

### Already-running app

The same saved-host and optional multiplexer arguments also work while lazysh is
running. One native request waits for normal unlock and for any open dialog,
local-terminal startup, workspace restoration or requested multiplexer picker to
finish. The original connection form and typed credentials are preserved. The
request then opens the normal saved-host dialog and still requires explicit
Connect and host-key/credential checks.

A second request cannot replace a queued, prepared or connecting launch. It is
refused with a localized notice; finish or cancel the current launch and run the
command again. Each distinct accepted receipt is offered once. Failed preparation,
lock/reunlock and renderer replacement do not replay an admitted request. The
singleton handoff exit status confirms delivery only, not authentication or a
terminal. Warm directory requests remain unsupported; close the app before using
`--dir`. Existing desktop URLs retain their prior ingress behavior.

Forwarded saved IDs and multiplexer names containing the Unicode replacement
character `U+FFFD` are refused, even if that character was entered literally:
the singleton's lossy transport cannot distinguish it from replaced OS bytes.
Cold launch keeps the original lossless argument validation and can use a literal
replacement character in a valid Unicode selector.

This independent saved-ID contract does not establish Moshi's undocumented host
grammar; only its help flags were observed. Native admission and frontend tests
do not prove actual OS singleton/GUI delivery or credential prompts. Those gates
and warm directory delivery remain in [issue #86](https://github.com/mihazs/lazysh/issues/86).

Native controlled SSH tests cover changed target metadata before authentication,
unknown-key trust/retry and revocation while waiting for the credential guard.
Frontend tests cover the actual dialog and original-lease transport cleanup,
including held Mosh/ET results across lock/reunlock. GUI CLI invocation on each
OS and platform-specific credential/biometric prompts remain separate acceptance
gates; a Linux test pass alone does not establish them.

### Multiplexer picker launches

Use one of:

```sh
lazysh --host SAVED_ID --mux tmux
lazysh --host SAVED_ID --mux tmux:agents
lazysh --host SAVED_ID --mux herdr
```

Single-dash and `--option=value` forms also work, in either selector order.
`--mux` requires a saved host, cannot accompany `--dir`, and accepts exactly the
three forms above. `tmux` and `tmux:default` select the explicit default server.
Named servers use the existing [literal native validation](multiplexers.md#tmux):
1–64 UTF-8 bytes, no slash/control characters, and neither `.` nor `..`.
Shell quoting belongs to your shell; lazysh does not reinterpret the resulting
literal name as a command or a socket path.

Mux composition explicitly uses an SSH control connection, including when the
saved host normally prefers Mosh, ET or Auto. The dialog explains this choice
and does not change the saved profile. Unlock, credential/biometric policy,
first-key review and explicit Connect remain mandatory. Host-only CLI requests
continue to honor the existing transport selection.

Successful authentication opens the existing requested picker on that exact new
SSH session with the original access owner. Kind and tmux server stay fixed for
that request. tmux lists the requested server's real workspaces; Herdr lists its
real sessions. No first row is selected automatically, and missing tools, empty
lists and host failures remain visible. Choose an exact row to attach through
an independently owned native child PTY. No attach text is sent to the source
terminal's foreground process. The picker exposes existing rows without create
or rename controls; the selected attachment retains its existing native semantics.

Switching back to **Terminal** leaves the authenticated SSH control terminal open.
Returning to its **Sessions** view retains the same fixed picker while this
request context exists. Closing the control terminal uses the normal session
cleanup path. An attached child's ordinary ownership/close behavior is unchanged.
The successful initial SSH creation already spent the CLI receipt; closing the
picker, failed attachment or lock/reunlock does not refill it. The picker context
is ephemeral, is not written into host settings or workspace restoration, and
never rebinds to another active session or a fresh unlock lease. Explicit chosen
attachments retain their existing restoration metadata and fresh-authentication
rules.

Native tests pass for selector bounds, both argument orders, preserved literal
mux metadata across explicit retry, and no host-file mutation. The controlled
OpenSSH/named-tmux fixture feeds the parsed/prepared server into the existing
native child attachment and retains colliding-ID/server-isolation assertions.
Isolated tmux and Herdr lifecycle fixtures also pass. Actual App/picker tests
cover saved transport overrides, exact new-source ownership, explicit trust,
closing/reopening and stale results after lock. The owned OpenSSH/Herdr 0.9.3 fixture additionally verifies explicit non-first
session selection, a separate child TUI while its source foreground stays usable,
and the same pane's advancing workload after detach and pending-child revocation.
The adopted source retains its normal lock policy; the revoked pending worker
finishes while locked, then its generic cancellation notice drains after unlock.
Both owned Herdr servers, the workload and SSH listener are stopped at teardown.

This fixture prepares the Rust launch intent and manually assembles its native
control session over the fixture's freshly authenticated transport. It does not
exercise actual OS argv delivery, GUI startup or credential/biometric prompts;
those remain unexecuted acceptance gates. See the [native command and scope](multiplexers.md#native-checks).

## Transport selection

Choose a host's **Preferred transport** in its editor. New hosts default to **Auto**; existing hosts without a preference keep SSH. The connection dialog starts with that preference and its saved helper paths/ports. A per-connection override does not silently change the saved host.

Auto first completes normal SSH host-key verification and authentication. It then tries Mosh, Eternal Terminal and finally the existing SSH terminal, in that order. It skips transports unsupported by the app build, bastion routes or selected-identity forwarding and displays those reasons. Classified helper, locale or network availability failures can move to the next transport. Host-key, authentication, packet-authentication, cancellation and unclassified errors stop the attempt. Forced Mosh and forced ET report their failure without falling back.

The session displays the chosen transport and observed fallback reasons. Workspace restoration retains the Auto intention and its public bootstrap options, then probes again after fresh verified SSH authentication. It does not save transport secrets or permanently replace Auto with its last SSH fallback.

## Mosh

Mosh starts the configured `mosh-server` through verified SSH and connects its authenticated UDP transport to the verified peer address. The default UDP range is 60000–61000; the configured range can contain at most 1001 ports. The host needs a UTF-8 locale and reachable UDP ports. Session keys stay in native memory and are never saved with host preferences.

The official Mosh core is embedded under GPL-3.0-or-later. Linux interoperability is tested against the official server; macOS builds pass. Android ARM64 and x86_64 native executables link with target-specific dependencies, while Android runtime and roaming acceptance remain pending. iOS and Windows report Mosh unavailable. See [build and provenance notes](../packages/mosh-transport/README.md).

The verified SSH control connection remains available for files and host tools. Mosh does not restore remote scrollback; use a durable multiplexer for remote history and process lifetime. Restoring after process death performs a fresh authenticated bootstrap rather than reusing session keys.

## Eternal Terminal

The ET transport starts the host's `etterminal` helper through the already verified SSH connection, then connects the in-process Rust client to the same server IP on the configured ET TCP port (default 2022). The host must already run a compatible `etserver`. The helper path is configurable; advanced private ET instances can specify an absolute server FIFO path. IPv6 scope information from the verified SSH peer is preserved.

ET bootstrap credentials stay in zeroizing Rust buffers and are not included in errors or saved settings. A missing helper, invalid bootstrap or unreachable ET port reports an ET error when ET is selected. The native ET command does not substitute an SSH terminal. Bastion routes and selected-identity forwarding are rejected before bootstrap for this transport.

Once connected, files and host tools retain their verified SSH control connection even when its initial shell tab closes. ET terminal output uses the same bounded output-credit acknowledgments as SSH. In-memory ET sessions retry interrupted TCP connections with delays increasing from one second to at most 30 seconds. After app/process death, create a fresh verified bootstrap and reattach the durable multiplexer; existing ET secrets are never restored with fresh crypto counters. Development challenge/reset handshakes remain unsupported and fail closed.

ET sends keepalive probes every five seconds and treats 15 seconds without a valid peer packet as a disconnected network, even when TCP writes still succeed locally. Partial incoming frames do not postpone recovery. Bootstrap failures, timeout and cancellation close their SSH helper channel while preserving the verified control connection.

The native interoperability gate uses real OpenSSH and official ET 7.0.0 to verify bootstrap, executed UTF-8 output, terminal resize, retained SSH file access, strict helper failure, forwarding rejection and cancellation. The separate transport tests verify ordered recovery after idle and mid-frame interruptions. Android/iOS device lifecycle, battery use and roaming remain acceptance work; pure-library mobile compilation does not certify them.

## Selected identity forwarding

Agent forwarding is disabled by default. Enable **Forward selected identity** for a host only when its remote programs need to authenticate with the private key selected for that connection. Password-only authentication cannot enable forwarding. Changing this setting invalidates the host's saved credential binding; enter and save the credentials again if needed.

The remote host can request signatures from that selected key while the SSH connection remains open. The private key stays in lazysh's Rust process, and neither the device's general SSH agent nor other identities are exposed. The endpoint supports listing that single identity and signing, and rejects key additions, deletion, lock, and extension requests. RSA signatures require SHA-256 or SHA-512.

Each connection permits at most four forwarding channels, with 256 KiB frames and 1024 total requests. These limits reset on reconnect. Closing the shared SSH transport cancels forwarding and releases the selected key. Multiplexer terminal tabs share their transport, so closing one tab keeps forwarding available while other tabs use it.

The real OpenSSH interoperability test checks `ssh-add -L`, verifies a challenge using `ssh-add -T`, and checks that the default connection has no remote agent socket. No test accesses the user's local agent.

Native Cargo tests establish a real nested SSH connection between two temporary loopback servers and verify that each receives only its own password. Tests also establish that an unknown bastion key and changed destination key receive no credentials for that peer. Physical-device lifecycle, VPN changes, and interrupted-network recovery require native acceptance testing.

# SSH connections and bastions

lazysh connects directly using SSH, with password or private-key authentication. The first connection stops before authentication and displays the server's SHA256 host-key fingerprint. Verify it independently before trusting it. A changed key blocks the connection.

To route through a bastion, first save that bastion as a direct SSH host. Select it in the destination host's **Bastion** setting. A route supports one jump host; recursive routes and cycles are rejected. Remove dependent routes before deleting a bastion.

The bastion and destination have separate credentials and host-key pins. The connection dialog can use credentials previously saved for the bastion or a separately entered bastion password. To use a bastion private key, connect to that bastion directly and explicitly save its credentials in the device credential store first. Destination credentials are never reused for the bastion. The trust dialog identifies which server needs verification.

Routing uses an SSH `direct-tcpip` channel to the destination address and port, then starts a second host-key-verified SSH connection inside that channel. The bastion must permit TCP forwarding to the destination. The destination hostname is resolved by the bastion. Files, agent snapshots, and previews use the resulting destination connection.

This implementation supports SSH routing. Bastion routes and selected-identity forwarding are SSH-terminal features. A bastion's forwarding permission error is reported by the SSH server; lazysh does not change server configuration.

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

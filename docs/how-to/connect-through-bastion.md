# Connect through a bastion

Use one SSH jump host to reach a destination that your device cannot access directly. You need SSH access to both hosts and independent trusted host-key fingerprints. The bastion must permit TCP forwarding to the destination address and port; lazysh does not change server configuration.

1. Add the bastion as a direct SSH host. Connect to it and verify its full SHA-256 fingerprint before trusting it.
2. If the bastion uses a private key, explicitly save its credentials in the device credential store after that successful direct connection. For password authentication, you can instead enter a separate bastion password in the destination's connection dialog.
3. Add or edit the destination host. Select the saved bastion under **SSH bastion**, and choose **SSH** as the preferred transport.
4. Connect to the destination. Review the trust dialog's server identity and independently verify the destination fingerprint as well. The two hosts have separate credentials and pins; destination credentials are never reused for the bastion.
5. Confirm that the resulting terminal is on the destination. Files, agent snapshots and previews use this destination connection.

A route has exactly one jump host. Recursive routes and cycles are refused. The bastion resolves the destination hostname and opens a `direct-tcpip` channel; a second verified SSH handshake takes place inside it. A forwarding refusal requires the host administrator to review server policy. Remove dependent routes before deleting a bastion.

See [credential safety](../credentials.md) for explicit storage and [transport selection](../connections.md#transport-selection) for fallback limits. Return to [documentation](../README.md) for other connection tasks.

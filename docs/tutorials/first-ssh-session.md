# Open your first SSH session

In this tutorial, we will save one host, verify its identity, open a direct SSH terminal, and reconnect. We will run only a small print command on a host you control.

## Before we start

Use an installed **native** lazysh app; the standalone browser/Vite preview cannot make SSH connections. Follow [installation and update](../install-and-update.md) for a package appropriate to your platform. A source build or a version in this checkout does not establish a published download. Apple app distribution and physical-device acceptance remain separate gates.

Have a reachable Unix SSH host you control, its address, SSH port, username and password. Obtain the server's full SHA-256 host-key fingerprint from its administrator or another independently trusted channel before starting. This exercise uses password authentication and does not alter your SSH server. If your host only accepts keys, use the [connection and credential guides](../connections.md) with its existing identity instead.

## 1. Save a direct host

Open **Hosts and connections**, choose **Add host**, and enter a recognizable name, the **Hostname or IP**, **Port**, and **Username** supplied for your host. Enter the hostname without a username prefix.

Select **SSH** for **Preferred transport**, leave **SSH bastion** at **Connect directly**, and leave **Default multiplexer** at **None — normal terminal**. Choose **Save host**.

We now have a saved host entry. Saving the entry does not authenticate or save a password. We selected SSH explicitly so this exercise needs no Mosh, Eternal Terminal or multiplexer installation.

## 2. Verify and connect

Open the saved host's connection dialog, use password authentication, and enter your password. Leave **Save credentials on this device after connecting** off. Choose **Connect**.

On a first connection, the app stops before authentication and displays the server fingerprint. Compare the **entire SHA-256 fingerprint** with your independently obtained value. Only if they match, choose **Trust key and connect**. If they differ or you have no trusted value, cancel and ask the administrator to verify it. A changed pinned key blocks connection; do not bypass it to complete the exercise.

After successful authentication, the terminal shows the host's shell prompt and its transport is **SSH**. If the host is unreachable or authentication fails, check its address, port and account with the administrator before retrying; a saved host alone is not evidence of a connection.

## 3. Run a small command

In the remote terminal, type this command and press Enter:

```sh
printf 'Hello from my SSH host\n'
```

The output contains:

```text
Hello from my SSH host
```

A new shell prompt follows. We have sent input to the remote shell and received its output without installing a companion or creating a cloud account.

## 4. Disconnect and reconnect

Use the terminal tab's **Disconnect** action. Reopen the same saved host and connect again, entering your password when asked. An unchanged trusted key should not need first-use acceptance again. If the key changed, stop and verify it independently.

The host metadata remains saved. The password is not persisted because we left explicit credential saving off. The new terminal is a fresh shell; this exercise does not preserve its previous process or scrollback.

We now have a repeatable direct SSH connection. To keep work on the host across disconnections, continue with [durable workspaces](../multiplexers.md) and read [what survives disconnection](../explanation/session-lifetime.md). For keys or explicit native credential storage, see [credentials](../credentials.md). Other tasks are in the [documentation map](../README.md).

---
name: lazysh-host-setup
description: Prepare or diagnose a remote host for lazysh SSH terminals and its optional host companion, using existing host tools and the user's chosen multiplexer.
---

# lazysh host setup

Separate SSH access, a persistent terminal session, and companion capabilities.
A working terminal does not require the companion. A companion executable does
not establish that lifecycle hooks or a particular agent are reporting.

## Check the chosen host

Use the already authorized host connection. Check the user's existing shell and
chosen multiplexer with `command -v`; inspect that multiplexer before changing
its configuration. Herdr, tmux and Zellij have different session identifiers.
Keep existing work running and preserve the user's multiplexer preference.

Verify that the actual non-interactive SSH environment can find required host
tools. Do not assume an interactive shell's PATH applies to SSH commands. Mosh
also requires a working `mosh-server` and reachable UDP; an installed executable
alone does not verify either transport or session persistence.

## Optional companion

In the native app, connect to the host and use **Agents → Host companion
installation**. The app verifies a published companion before installing it in
the remote user's managed namespace. Check its final verification and cleanup
result; an uncertain result requires inspection before another write.

For an existing companion, inspect its capabilities without changing settings:

```sh
lazysh-agent --version
lazysh-agent installation inspect
lazysh-agent settings show
```

`installation inspect` returns the source, destination, existing identity and
`planSha256`; it does not install anything. For a requested CLI installation,
review that plan and pass its exact hash to `installation install
--expected-plan HASH`. It installs the currently running verified executable,
not a package fetched by this command. Installation does not add PATH entries,
install agent hooks or configure a service.

Settings changes require the current revision and all three explicit feature
values. Keep discovery, recorded usage and device operations separate; do not
change these switches merely to diagnose connection readiness. No daemon or
provider configuration is needed for these checks.

Verify the chosen transport and multiplexer from lazysh after setup. Report
missing tools, unsupported capabilities and untested reconnect/background
behavior explicitly instead of inferring them from a successful install.

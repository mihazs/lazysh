# Sign in on a host from your device

Status: specification, with one workaround that exists today. The automatic tunnel and the device browser are designed in [ADR 0004](../architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md) and tracked by [epic #1504](https://github.com/mihazs/lazysh/issues/1504); none of it is released. Names, limits and defaults are in the [contract reference](../reference/auth-tunnel.md); what each login tool really does is in [Observed sign-in flows](../reference/sso-login-flows.md).

The problem: a command on the host (`aws sso login`, `codex login`, `claude`, `az login`, `gcloud auth login` and others) starts a small web server on the host's `localhost`, sends your browser to the identity provider, and waits for the provider to redirect the browser to `http://localhost:PORT/...`. The browser is on your device, so that redirect reaches your device, not the host. Some tools avoid the problem with a device code or by asking you to paste a code; those need no tunnel.

## Today: forward the port yourself with Preview

This uses [Previews](../previews.md) and was not tested end to end for this page.

1. In the terminal, start the login on the host and leave it waiting.
2. Find the port in the printed address: the part after `redirect_uri=` is the callback, for example `redirect_uri=http%3A%2F%2F127.0.0.1%3A36871%2Foauth%2Fcallback` means port 36871. If the tool printed only `http://localhost:1455`, the port is 1455. `az login` prints no address with a port; **Discover listeners** in Preview should list it (the process is `python`).
3. Open **Preview**, enter the port, choose IPv4, select **Open preview**. lazysh listens on the same port number on your device when it is free, which is what the redirect needs. If the preview chose another number, the redirect will not work: close it, free the port on your device and try again.
4. Tap the sign-in link in the terminal so the device browser opens it. After you sign in, the browser follows the redirect to your device's `localhost:PORT`, which lazysh forwards to the host.
5. Close the preview when the command reports success. Do not leave it open: other apps on your device can connect to the port while it is open, as [Previews](../previews.md) explains.

Opening the preview loads the callback address once, so the host's callback server receives a request that has no code. The AWS CLI's handler ignores a request without `code` and `state` (read from `OAuthCallbackHandler.do_GET`); other tools were not checked, and one that stops on its first request will fail. If that happens, use the tool's device-code option instead (`aws sso login --use-device-code`, `codex login --device-auth`, `az login --use-device-code`, `wrangler login --device`, `firebase login --no-localhost`).

## Planned: automatic

What you will see once the children of the epic have shipped.

1. Run the login on the host. If the output shows a redirect to `localhost:PORT` and the host is listening on it, a banner appears above the terminal: **Sign-in on `<host>` needs `localhost:PORT`** with the command when the companion knows it and the identity provider's host. Choose **Allow once**, **Always for this host** or **Deny**. The banner does not take focus from the keyboard and is announced to screen readers.
2. lazysh binds the port on your device, then opens the page: an in-app browser tab on Android and iOS, your default browser on a desktop. It never opens the page first.
3. After you sign in, the redirect goes through lazysh to the host command. The tunnel closes 15 seconds after the callback, after 10 minutes at most, when you cancel, or when the session ends.
4. If a host program asks to open a browser (after you install the shim with `lazysh-agent browser-shim install` on that host), the same banner offers to open that page on your device.

Settings, per host: **Auto tunnel for auth callbacks** and **Open host browser requests on this device**, each **Ask** (default), **Always** or **Never**. A decision is remembered on this device only and is not synced.

## What it will not do

- Forward a port without a sign-in address pointing to it. Dev servers and everything else stay in Preview.
- Rewrite the redirect to another port. If the port is busy on your device, the sign-in stops and says what holds the port. Free it and run the login again.
- Open pages other than `http` and `https`, or open anything automatically from text that merely appeared in the terminal.
- Make `gcloud auth login` use `localhost` on a host with no display: it chooses the paste-the-code flow by itself, which already works. `gcloud` asks you to copy the verification code from the page it opened.
- Intercept browser requests on Windows hosts: the first shim covers Linux and macOS hosts, because Windows launchers were not measured. It also cannot see a callback listener inside a container, which is not on the host's loopback.
- Tunnel two sign-ins that use the same port at the same time. The second one fails with the reason, because one device port can serve one flow.

## Install the shim (planned)

On a host where tools open a browser themselves, `lazysh-agent browser-shim install` adds the wrappers and one marked block to your shell startup files; `status` shows what was written and `uninstall` removes exactly that. With no lazysh session attached the wrappers hand every request to the real browser opener, so using the same host at its own desktop does not change. Installing the shim changes which flow some tools choose: `az login` starts a localhost callback instead of a device code once it finds a launcher.

One device receives the requests of a host at a time: the one whose session attached last.

## Check it on a real phone (acceptance steps)

These steps are the acceptance criteria of [#1515](https://github.com/mihazs/lazysh/issues/1515). Report what you observed, including a device model and OS version. A result from an emulator or Waydroid is not an iPhone or a phone result.

Prepare a host with the companion, `aws` with an SSO session in `~/.aws/config`, and optionally `codex` and `claude`.

1. **Android phone.** Connect, run `aws sso login --profile NAME`. Expect the banner. Allow. Expect an in-app tab, the identity provider's page, then the CLI's own page "you can close this window" and the CLI printing `Successfully logged into Start URL`. Repeat with the app in the background during the sign-in (switch to another app for 30 seconds before returning) and with the screen off for the first minute. Expect the notification to open the page when the app was not in front.
2. **iPhone.** The same steps. Record whether the app stays active while the in-app tab is shown; whether the tab loads `http://127.0.0.1:PORT`; whether the password manager and a passkey can be used; and what happens after switching apps for 10, 30 and 60 seconds during the sign-in. Expect failure when the page is opened in the Safari app instead of the in-app tab and note it.
3. **Desktop.** The same, once per desktop operating system you have.
4. **Negative checks.** Choose Deny (nothing may start and no page may open). Choose Never (silent). Occupy the port on the device first (`python3 -m http.server PORT`) and expect a clear failure, not a silent one. End the SSH session mid-sign-in and expect the listener to disappear (check with `ss -ltn` on a desktop, or retry the same port). Disable `AllowTcpForwarding` on the host and expect the stated reason.
5. **Secrets.** Search the app log and any exported bug report for the `code=` and `state=` values of the redirect: neither may appear.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The page says it cannot connect to `localhost` | The tunnel was not started (banner dismissed or Never), it closed after its lifetime, or the port was busy on the device. |
| The banner never appears for a login that only prints a device code | Correct: no localhost callback is involved. |
| `az login` asks for a device code, not a browser | The host has no launcher; `az` chose the device code. |
| `gcloud auth login` shows a verification code to paste | The host has no `DISPLAY`; this is the intended flow for that tool. |
| The tunnel is refused with "forwarding disabled" | The host's SSH server has `AllowTcpForwarding no` (see the Previews limits). |
| After a Mosh session lost its SSH connection | The tunnel needs the retained SSH control connection; reconnect (automatic reauthentication does not exist yet, see [Connections](../connections.md)). |

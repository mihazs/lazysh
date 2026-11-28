# Sign in on a host from your device

Status: the tunnel, the question and the settings are available; the host browser shim is not read by the app yet. The design is in [ADR 0004](../architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md) and tracked by [epic #1504](https://github.com/mihazs/lazysh/issues/1504). Names, limits and defaults are in the [contract reference](../reference/auth-tunnel.md); what each login tool really does is in [Observed sign-in flows](../reference/sso-login-flows.md).

The problem: a command on the host (`aws sso login`, `codex login`, `claude`, `az login`, `gcloud auth login` and others) starts a small web server on the host's `localhost`, sends your browser to the identity provider, and waits for the provider to redirect the browser to `http://localhost:PORT/...`. The browser is on your device, so that redirect reaches your device, not the host. Some tools avoid the problem with a device code or by asking you to paste a code; those need no tunnel.

## When no banner appears: forward the port yourself with Preview

The tunnel needs a printed address that names the callback port. A login that prints none (`az login`, `claude auth login`), a host over a local terminal, or an app version without the tunnel can still be finished by hand. This uses [Previews](../previews.md) and was not tested end to end for this page.

1. In the terminal, start the login on the host and leave it waiting.
2. Find the port in the printed address: the part after `redirect_uri=` is the callback, for example `redirect_uri=http%3A%2F%2F127.0.0.1%3A36871%2Foauth%2Fcallback` means port 36871. If the tool printed only `http://localhost:1455`, the port is 1455. `az login` prints no address with a port; **Discover listeners** in Preview should list it (the process is `python`).
3. Open **Preview**, enter the port, choose IPv4, select **Open preview**. lazysh listens on the same port number on your device when it is free, which is what the redirect needs. If the preview chose another number, the redirect will not work: close it, free the port on your device and try again.
4. Tap the sign-in link in the terminal so the device browser opens it. After you sign in, the browser follows the redirect to your device's `localhost:PORT`, which lazysh forwards to the host.
5. Close the preview when the command reports success. Do not leave it open: other apps on your device can connect to the port while it is open, as [Previews](../previews.md) explains.

Opening the preview loads the callback address once, so the host's callback server receives a request that has no code. The AWS CLI's handler ignores a request without `code` and `state` (read from `OAuthCallbackHandler.do_GET`); other tools were not checked, and one that stops on its first request will fail. If that happens, use the tool's device-code option instead (`aws sso login --use-device-code`, `codex login --device-auth`, `az login --use-device-code`, `wrangler login --device`, `firebase login --no-localhost`).

## Sign in with the tunnel

Available for hosts you reach over SSH, Mosh or Eternal Terminal. It covers the logins that print an authorize URL whose redirect is `localhost` (`aws sso login`, `aws login`, `codex login`, `gcloud auth login` on a host with a display, and by their documentation `wrangler login`, `firebase login`, `terraform login`, `vault login -method=oidc`). A login that uses a device code needs no tunnel and shows no banner.

1. Run the login on the host. When its output shows a redirect to `localhost:PORT`, a banner appears above the terminal: **Sign-in on `<host>` needs `localhost:PORT`**. It names the identity provider's host (never the rest of the address), says whether the host is listening on that port, and warns when the sign-in does not use PKCE, when the provider's name uses internationalized characters, or when another user's program holds the port. The first time, it also explains what is about to happen. The banner does not take the keyboard focus, screen readers hear it as a status, and its buttons are at least 44 points high (48 on a touch screen).
2. Choose **Allow once**, **Always for this host** or **Deny**. Allowing makes lazysh listen on the same port number on your device (never anything but loopback), and the banner then says **Tunnel ready**. Deny starts nothing. An unanswered banner shrinks to one line after a minute (**Review** brings it back) and goes away after ten.
3. Tap the sign-in link in the terminal and choose **Open in browser**. lazysh opens it on your device: an in-app tab on Android and iOS, your default browser on a desktop. If you tap before allowing, nothing opens and a message tells you to allow the tunnel first.
4. After you sign in, the redirect reaches your device's `localhost:PORT`, lazysh passes that one request to the host, and the banner reports **Sign-in finished**. The tunnel closes 15 seconds after the callback, after 10 minutes at most, when you press **Stop**, when the session ends or when the app is locked.

**Always for this host** remembers your answer for that host on this device. A later sign-in on it then starts by itself, with a banner that shows **Stop**, but only when the host confirms that a program started listening on the port around the time the URL was printed. It still asks for a database or admin port, for a program that belongs to another user (NetBird's daemon), and after the sixth sign-in on the host within ten minutes.

### Choose what the app may do

**Settings, General, Sign-in on hosts** (apps only):

- **Auto tunnel for auth callbacks** is the default for every host: **Ask** (the default), **Always** or **Never**. Each saved host can override it. **Never** keeps a host's sign-ins from tunnelling: it shows one explanation per host and app run, asks the host nothing, and counts what it kept from starting.
- **Recent sign-ins** lists the last 50 flows since the app opened: time, host, port, your decision and how it ended. It lives in memory, is never stored, and never holds an address, a query, a `code` or a `state`. **Clear list** empties it.

These choices are kept on this device and are not synced, backed up with the hosts or shared between devices.

## Planned: the host browser

What arrives with the host browser shim, tracked in [#1512](https://github.com/mihazs/lazysh/issues/1512) and [#1514](https://github.com/mihazs/lazysh/issues/1514): if a host program asks to open a browser (after you install the shim with `lazysh-agent browser-shim install` on that host), the same banner offers to open that page on your device, with a second setting, **Open host browser requests on this device**, also **Ask** (default), **Always** or **Never**. Logins that print no redirect (`claude auth login` prints a paste-the-code address and opens the `localhost` one in a browser, and `az login` prints an address with no query) are only found this way.

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

1. **Android phone.** Connect, run `aws sso login --profile NAME`. Expect the banner. Allow once. Tap the printed link and choose **Open in browser**. Expect an in-app tab, the identity provider's page, then the CLI's own page "you can close this window" and the CLI printing `Successfully logged into Start URL`. Repeat with the app in the background during the sign-in (switch to another app for 30 seconds before returning) and with the screen off for the first minute. Expect the notification to open the page when the app was not in front.
2. **iPhone.** The same steps. Record whether the app stays active while the in-app tab is shown; whether the tab loads `http://127.0.0.1:PORT`; whether the password manager and a passkey can be used; and what happens after switching apps for 10, 30 and 60 seconds during the sign-in. Expect failure when the page is opened in the Safari app instead of the in-app tab and note it.
3. **Desktop.** The same, once per desktop operating system you have.
4. **Negative checks.** Choose Deny (nothing may start and no page may open). Choose Never in Settings (one explanation, no listener, no page). Occupy the port on the device first (`python3 -m http.server PORT`) and expect a clear failure, not a silent one. End the SSH session mid-sign-in and expect the listener to disappear (check with `ss -ltn` on a desktop, or retry the same port). Disable `AllowTcpForwarding` on the host and expect the stated reason.
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

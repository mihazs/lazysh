# ADR 0004: tunnel SSO and OAuth localhost callbacks to the device and open host browser requests on it

- Status: **Accepted** as the design. The behavior below is not implemented yet: the child issues of [epic #1504](https://github.com/mihazs/lazysh/issues/1504) deliver it (detection, tunnel engine, shim, guest open, policy and UX, end-to-end tests). Date: 2026-11-13.
- Decision makers: repository maintainer. Tracking: [epic #1504](https://github.com/mihazs/lazysh/issues/1504), research issue [#1509](https://github.com/mihazs/lazysh/issues/1509).
- Related: [how-to](../how-to/sign-in-on-a-host-from-your-device.md) · [flow observations](../reference/sso-login-flows.md) · [contract reference](../reference/auth-tunnel.md) · [Previews](../previews.md) · [host browser](../host-browser.md) (a different feature: view the host's browser) · [companion](../companion.md) · [connections](../connections.md) · [ADR 0003](adr-0003-host-side-companion-update.md).

Terms: the **host** is the machine that runs the CLI (the SSH, Mosh or ET peer); the **device** (the epic says "guest") is the phone or desktop that runs lazysh.

## Context

The requirement (2026-11-13): when a CLI on the host starts an SSO or OAuth sign-in that redirects the browser to `localhost`, the app must detect it and let the device reach that callback; and when software on the host tries to open a browser, the page must open on the device, on Android, iOS and desktop.

Why it fails today: the CLI starts a callback server on the host's loopback, prints or tries to open a URL, and the identity provider redirects the browser to `http://localhost:PORT/...`. On the device `localhost` is the device. The page cannot be reached and the CLI waits until it times out.

What the code does today (read at `origin/main` d80fcd50):

- **Previews** (`apps/client/src-tauri/src/previews.rs`) binds device `127.0.0.1`, preferring the host's port number ("keep the remote port when free, so dev-server redirects retain their port") and otherwise a random one, opens an SSH `direct-tcpip` channel per connection through `remote_stream` (waits for one of four channel-opening slots with a 20 ms retry inside a 15 s deadline), and relays raw bytes for up to one hour. Limits: 4 forwards per session, 16 in total, 16 sockets per forward; `serve_connections` owns the cap and drains children on cancellation. Forwarding is manual. Its optional proxy mode has an HTTP head parser (`previews/proxy.rs`: `request_head`, header caps of 64 KiB and 64 fields). It is a general port forward by design.
- **Opening links** (`links.rs`, `open_web_url`): only `http` and `https`, at most 4096 bytes, no credentials, no control characters or backslashes. It calls `tauri-plugin-opener` with no `with` argument. In that plugin (2.7.2) Android sends `Intent.ACTION_VIEW` with `FLAG_ACTIVITY_NEW_TASK` and iOS calls `UIApplication.open`. With `with = "inAppBrowser"` the same plugin uses Chrome Custom Tabs (`CustomTabsIntent.launchUrl(activity, ...)`) on Android and `SFSafariViewController` on iOS; nothing in the repository uses that option yet.
- **Terminal links** (`terminalLinks.ts`) find `http(s)` URLs in the xterm buffer on hover or tap (soft wraps, conservative hard wraps, OSC 8 targets). They do not know what a URL is for.
- **Android keeps the process alive** for sessions with `SessionForegroundService` (foreground service type `specialUse`, a partial wake lock, started and released by native workers through `session_background.rs`). **iOS** declares no background mode (`Info.plist`, `apple/project.yml.hbs`).
- **Mosh and ET** keep the verified SSH control connection after the bootstrap ("files and host tools retain their verified SSH control connection", [connections](../connections.md)). If only UDP survives, dependent tools need a new connection; automatic reauthentication is not implemented.
- **Companion channels**: `transcript-watch` is a long-lived exec channel that prints one JSON frame per line and ends when stdin closes; an older companion answers an unknown subcommand with exit status 2, which the app treats as "update the companion" ([#1441](https://github.com/mihazs/lazysh/issues/1441)).
- **Multiplexer panes** get the environment of the multiplexer server, not of the SSH session that attached ([connections](../connections.md#identify-lazysh-to-the-host): panes keep the server's environment). The app sets `LC_TERMINAL=lazysh` only when the host asks and the server's `AcceptEnv` admits it.

## What the tools really do

Method: each installed tool was run in a pseudo-terminal with an empty, ephemeral `HOME` and configuration directory, no credentials, a scrubbed environment and stand-in browser launchers that record their arguments and open nothing. While the command waited, every TCP listener owned by its process tree was read from `/proc/net/tcp` and the descriptor table. Three environments per tool: no launcher at all, `BROWSER` set to the recorder, and `DISPLAY` set with a recording `xdg-open` and browser names on `PATH`. The AWS CLI used a local stand-in for its OIDC registration endpoint (`AWS_ENDPOINT_URL_SSO_OIDC`), so the authorize URL and listener are the real CLI's and the identity provider is fake. Tools not installed were read from official documentation and source. Full table, sanitized captured output and the method are in [flow observations](../reference/sso-login-flows.md). Versions: aws-cli 2.37.9, gcloud 592.0.0, az 2.90.0, gh 2.103.3, claude 2.1.322, codex-cli 0.167.0, npm 11.18.0 against a fake registry.

| Finding (all measured unless marked) | Consequence for the design |
| --- | --- |
| Flows split in three: **localhost callback** (`aws sso login`, `aws login`, `gcloud auth login` with a display, `az login` with a launcher, `codex login`, `claude auth login`, `netbird up` with PKCE, and by documentation `firebase login`, `wrangler login`, `terraform login`, `vault login -method=oidc`, kubelogin), **device code** (`gh auth login --web`, `vercel login`, `az login` and `netbird up` without a launcher or desktop), and **poll a session URL** (`npm login`, `stripe login`). | Only the first class needs the tunnel. The other two need only "open this URL on the device". Detection must tell them apart by evidence, never assume. |
| Every localhost-callback flow encodes the callback as `redirect_uri=http(s)%3A%2F%2F(localhost\|127.0.0.1):PORT/path`. Ports: random (`aws`, `az`, `claude`, Terraform), fixed (`codex` 1455, `wrangler` 8976, `vault` 8250), first free from a base (`gcloud` 8085, `firebase` 9005, kubelogin 8000 then 18000, NetBird 53000 from a list). | The URL carries the port. Port number must be preserved end to end. |
| The identity provider registers the redirect once and the CLI **repeats the same `redirect_uri` at the token endpoint** (`redirectUri=...` in `awscli/botocore/utils.py`; RFC 6749 section 4.1.3 requires it to be identical). | **A rewritten port breaks the exchange.** The epic's "fall back to a free port with URL rewriting" is rejected (decision 3). |
| The URL a tool **prints is not always the URL it opens.** `claude auth login` prints a URL whose redirect is `https://platform.claude.com/oauth/code/callback` (paste a code) and opens one whose redirect is `http://localhost:PORT/callback`. `az login` prints only `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize`, with no query. `gcloud` headless prints a different, paste-the-code redirect. | Scanning the terminal misses flows. Only a launcher request carries the URL the tool wants. That is the value of the shim (decision 5). |
| **The callback server often binds all interfaces**: `aws` and `az` bind `0.0.0.0`, NetBird `:53000`, Firebase by documentation; `codex`, `claude` and `gcloud` bind `127.0.0.1` (Terraform too, by its source). NetBird's callback server runs in the **root-owned daemon**, not in the user's process tree. | The host side connects to loopback only, which reaches both. Ownership by the session user cannot be a hard requirement (decision 4). |
| **`--no-browser` does not remove the callback**: `aws sso login --no-browser` still printed `redirect_uri=http%3A%2F%2F127.0.0.1%3A36151%2Foauth%2Fcallback` and listened. | Terminal URL detection is needed even when no browser is involved. |
| **How a launcher is chosen differs and decides which flow runs.** Python `webbrowser` (`aws`, `az`, `gcloud`) honors `BROWSER` with no display, but uses `xdg-open` or a browser name only when `DISPLAY` or `WAYLAND_DISPLAY` is set; `gh` (Go) tries `BROWSER` and then `xdg-open`, `x-www-browser`, `www-browser` and `wslview` from `PATH` whatever the display; `codex` honors `BROWSER` and otherwise called a browser name (`chromium`) before `xdg-open`; `claude` launched nothing without `BROWSER` or a display; `npm` ignores `BROWSER` and runs `xdg-open`; `gcloud` also requires `DISPLAY`, `WAYLAND_DISPLAY` or `MIR_SOCKET` before it launches anything. | `BROWSER` alone leaves `npm` out and a `PATH` shim alone leaves `claude`, `codex` and the Python tools out; together they cover everything measured except `gcloud`, which would need a faked `DISPLAY` (rejected). |
| **A launcher flips the flow.** `az login` falls back to a device code when it finds no launcher and starts a localhost callback server (`response_mode=form_post`, so the callback is a `POST`) when it finds one, including a console browser such as `www-browser`. | Installing the shim changes which flow `az` and similar tools choose. The documentation and changelog say so, and the shim is opt-in per host. |
| Launchers receive more than a URL: `gcloud` passed `--new-window URL` to a `chromium` it found. | The launcher takes the last `http(s)` argument and delegates anything else. |
| **In-band terminal escape sequences are not a transport.** tmux 3.8 drops unknown OSC (7777, 1337) with every `allow-passthrough` value and forwards a tmux-wrapped DCS only with `allow-passthrough on` (default `off`); it forwards OSC 8 only with the `hyperlinks` terminal feature and OSC 52 with `set-clipboard on`. Zellij 0.46.0 forwards OSC 8 and OSC 52 and drops unknown OSC and DCS. Herdr 0.9.5 forwards OSC 52 and nothing else of the five probes. `mosh-server` 1.4.0 keeps only OSC 0, 1, 2 and 52 (`Dispatcher::OSC_dispatch`, read from source). | The shim reports over the companion, not through the terminal (decision 6). |

Not examined: `supabase`, `heroku`, `tailscale`, `docker`, `op` and other tools. Not run: `netbird` (its daemon is system-wide, and a login would have changed the live connection; source and documentation were read instead), `firebase`, `wrangler`, `terraform`, `vault`, kubelogin, `vercel`, `fly`, `stripe` (not installed; documentation and, for Firebase and Terraform, source). A claim about those rows is a documentation claim, not a measurement.

## Platform constraints

| Platform | Facts | Consequence |
| --- | --- | --- |
| **Android** | The browser is another app, so lazysh goes to the background while the user signs in and the redirect arrives at the device loopback. The foreground service and wake lock already keep the process, the sessions and therefore a loopback listener alive. Android 10 and later block background activity launches, and a foreground service is **not** on the exemption list; a launch from a notification tap (a system `PendingIntent`) is allowed ([background-starts](https://developer.android.com/guide/components/activities/background-starts)). Android apps run as an unprivileged user and cannot bind ports below 1024 (`ip(7)`). The opener plugin starts a Custom Tab with `CustomTabsIntent.launchUrl(activity, ...)`, which Android's reference describes as launching a Custom Tabs Activity of the user's browser. | Open with Custom Tabs when lazysh is in front; when it is not (a request from a host command while another app is visible), post a notification and open on tap. `POST_NOTIFICATIONS` is already requested. Low ports are refused. Waydroid (Android 13) can exercise the callback path; a real phone must confirm OEM background killers. |
| **iOS** | The app has 5 seconds after entering the background, extendable with `beginBackgroundTask` for a bounded time, then is suspended ([Apple](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)); the app declares no background mode, so a listener does not survive it. `SFSafariViewController` presents Safari inside the app and hides interactions from it; Apple points to `ASWebAuthenticationSession` for sharing data with Safari, which shows a consent sheet naming the domain and completes on a callback URL (Apple's page does not address an `http://localhost` redirect, so the app would have to end the session itself). `WKWebView` is an embedded user agent: RFC 8252 section 8.12 says native apps must not use one for authorization requests. | Use an in-app browser tab (`SFSafariViewController`, already in `tauri-plugin-opener` through `with = "inAppBrowser"`), not the Safari app, so the app stays in front and the listener stays alive. Whether the app stays active while that tab is shown, whether the tab can load `http://127.0.0.1`, and how it treats cookies must be checked on a device. `ASWebAuthenticationSession` is a documented follow-up if cookie partitioning blocks sign-in. Unverified: Apple's local network privacy note for loopback (the page was not readable by the research tool). |
| **Desktop** | The system browser runs on the same machine; the callback goes to the device loopback. A local port may be taken by another program. Linux, macOS and Windows have no special constraint for loopback binds above 1023. | `open_url` as today; a busy port fails closed. |
| **Local PTY sessions** | The device is the host. | No tunnel and no shim. |

## Decision

1. **Three tiers, each useful alone.** Tier 0, no companion needed: the app finds an authentication callback in terminal output. Tier 1, with a companion that has `listeners`: the app confirms that a matching listener exists. Tier 2, with the browser shim: host launcher requests arrive at the app. Detection and tunnel never wait for a newer companion.
2. **One tunnel per sign-in flow, not a port forward.** Same port on the device loopback, host side `direct-tcpip` to the host's loopback through the existing channel code, closed after the callback, with an **HTTP request guard** in front of every connection (decision 7). Previews stays the manual, byte-transparent feature.
3. **The redirect URI is never rewritten.** A busy device port fails closed with a clear message. This amends the epic text.
4. **A tunnel needs a URL.** A new listener without URL evidence never creates a tunnel; it stays in manual Previews (dev servers, watchers). A listener owned by another user is accepted only when a URL names its port, and then never with "Always" (NetBird's daemon).
5. **The shim is a host launcher, installed on request.** `lazysh-agent browser-shim install|status|uninstall` puts wrappers first on `PATH` and sets `BROWSER` in the user's interactive shell startup files, off by default. With no app attached the shim delegates to the next real launcher, so an installed shim never changes a host used at its own desktop. The multiplexer environment problem (panes keep the server's environment) is why the shim is decided at run time, not by `LC_TERMINAL`.
6. **Out-of-band transport only.** The companion's `browser-watch` exec channel (same shape as `transcript-watch`) carries launcher requests. No OSC or DCS sequence carries data. When no watcher can be reached, the shim prints one visible line with the URL so the existing link detection offers a tap target.
7. **The guard.** Before a byte reaches the host the first request must parse as HTTP/1.x (method `GET` or `POST`, `Host` equal to `localhost`, `127.0.0.1` or `[::1]` with the flow's port, target inside the callback path, no `Upgrade`, `Sec-Fetch-Mode` `navigate` when present). Anything else is answered locally and not forwarded. This is the control for "any app on the device can connect to a device loopback port" ([RFC 8252 section 8.1](https://www.rfc-editor.org/rfc/rfc8252#section-8.1)): a hostile app or web page cannot talk Redis, a database wire protocol or a Docker API to a host service through the tunnel.
8. **Consent per host, device-local, never synced.** Auto tunnel for auth callbacks and Open host browser requests on this device are each Ask (default), Always or Never. Ask is a non-blocking banner. Never is silent. Nothing here changes an existing default.
9. **Open on the device with an in-app browser tab on mobile, the system browser on desktop**, after the listener is bound. Android notifies when not in front.
10. **A launcher request, a listener or a printed URL never create a tunnel by themselves.** The policy decision is the only thing that does.

## Detection

Signals, strongest first:

1. **Launcher request** (Tier 2): the exact URL, the launcher's pid and process names, and the listeners owned by that process tree.
2. **Printed URL** (Tier 0): a native scanner in the Rust output path (so it also runs while the WebView is suspended on mobile) strips escape sequences, keeps OSC 8 targets and tolerates a program's own wrapping. It extracts `http(s)` URLs of at most 4096 bytes and URL-decodes, up to twice, the parameters `redirect_uri`, `redirect_url`, `redirectUri`, `callback`, `callback_url` and `redirect`. A hit needs a value of the form `http://localhost|127.0.0.1|[::1]:PORT[/path]` with PORT from 1024 to 65535 (RFC 8252 prefers the IP literals; `localhost` is what tools print). Query text, `code` and `state` are never stored or logged.
3. **Listener evidence** (Tier 1): `lazysh-agent listeners` (Linux `/proc/net/tcp{,6}` plus the descriptor map, macOS `lsof`, Windows `GetExtendedTcpTable`) lists loopback and wildcard TCP listeners with pid, name, uid and age. A hint is **confirmed** when a listener on its port started up to 120 seconds before it or appears up to 30 seconds after it. Without a newer companion the app uses the `ss` or `lsof` discovery Previews already has.
4. **Weak announcements** such as `Starting local login server on http://localhost:1455.` corroborate and never trigger.

Only confirmed hints, or hints from a launcher request, may be tunnelled automatically. A printed URL without a listener asks the user ("The host is not listening on 1455 yet").

False-positive controls: no hint without URL evidence; a redirect to a public host is not a hint; `localhost:3000` in dev-server logs is not a hint; ports below 1024 and the ports of well-known non-HTTP services (SSH, databases, caches, the Docker API) need a separate, stronger confirmation naming the service; a hint for the session's own SSH port is refused. The guard is the backstop for all of them.

## Tunnel

- Device listener: `127.0.0.1:PORT`, plus `[::1]:PORT` when free, so a browser that resolves `localhost` to either address works. Never `0.0.0.0`.
- Host connection: `direct-tcpip` to `127.0.0.1:PORT`, else `[::1]:PORT` when that is the family the listener evidence shows. The host side never connects to anything but its own loopback. A host that forbids TCP forwarding (`AllowTcpForwarding no`) is reported with its reason; a companion relay over an exec channel (which is not forwarding) is a follow-up, not part of the first increment.
- Mosh and ET sessions use the retained SSH control connection. If it is gone, the flow says so. Bastion routes follow the same path as Previews.
- Lifetime: closes 15 seconds after the first relayed callback request (one carrying `code` or `error`, or any `POST` to the callback path), after 10 minutes at most (AWS's own overall wait is 10 minutes, NetBird's is 5), when the user cancels, when the SSH session or the app lock ends, or when the host stops listening (two refused connects). Cleanup runs on every exit path.
- Caps: 4 flows per session and 8 per app, separate from Previews' 4 and 16; 8 concurrent connections per flow; 6 flows per host per 10 minutes; request 64 KiB, response 1 MiB, head 16 KiB read within 5 seconds. The channel-opening gate (four at a time) is shared with Previews, so a flow waits for a free slot instead of failing.
- Secrets: the request line and body are parsed in memory only. Errors and logs carry fixed texts, the port and the decision; a test captures all output and asserts that `code` and `state` values never appear.

## Guest browser

- The shim sends the URL (http or https only, at most 4096 bytes) over the watcher; every other argument is delegated to the real launcher. Rate limit 6 per minute per host, identical URLs deduplicated for 10 seconds, queue of 8, entries expire after 2 minutes. The watcher socket is in a 0700 per-user directory, the peer uid is checked, nothing is written to disk.
- If the URL (or its decoded redirect) needs a tunnel, the tunnel is created and confirmed **before** the page opens. If it cannot be bound, nothing opens and the banner says why.
- Phishing guard: the banner shows the host being opened (never the query), warns on non-https hosts other than loopback, on punycode or mixed-script hosts, and when the host differs from the one the command printed.
- Mobile opens an in-app tab; the setting **Browser on this device** can choose the system browser. Dismissing the tab after success is done where the platform allows.

## Security model

| Threat | Control |
| --- | --- |
| A hostile app on the device connects to the tunnel port and speaks another protocol to a host loopback service | Request guard: HTTP head, `Host`, path, no upgrade; nothing else is forwarded (decision 7). |
| A hostile web page in the device browser makes a cross-origin request to the tunnel | `Host` check and `Sec-Fetch-Mode` `navigate`; one-shot lifetime. |
| A hostile app squats the port first and receives the authorization code | Bind before opening; on a busy port nothing opens. PKCE (every measured localhost flow sends a `code_challenge`, `S256` or `SHA-256`) keeps the code useless without the verifier that stays on the host. Flows without PKCE are labelled at the banner. |
| A host process asks the app to open a phishing page or an arbitrary scheme | Scheme allow-list (http, https), 4096 bytes, no credentials, host shown, per-host policy, rate limit. The existing `web_url` validation is reused. |
| A host process makes the app tunnel a database or admin port | Needs a URL with a loopback redirect, consent per host, a stronger confirmation for sensitive ports, and the guard. Never a persistent forward. |
| Secrets in logs, crash reports, storage | `code`, `state`, `login_hint`, query strings and bodies are never stored or logged; the audit list keeps host, port, command name when known, decision, outcome and time, in memory only. |
| The companion channel is read or written by another local user | Per-user directory 0700, peer uid check, no network listener on the host. |
| Resource exhaustion | Caps above, shared channel-open gate, per-host rate limits. |

## Consequences

Positive: sign-ins that redirect to localhost complete from a phone without `ssh -L`; the printed-URL tier needs no new companion; the shim finds flows no terminal text reveals; the tunnel is far narrower than a port forward.

Negative or risky: the shim changes which flow some tools choose; an HTTP guard can reject a legitimate but unusual callback (an HTTP/2 prior-knowledge client, a callback outside the hinted path), which then fails with a visible reason; `gcloud` stays on its paste-the-code flow on hosts without `DISPLAY`; one device receives a host's launcher requests at a time (the one that attached last); iOS behaviour is a design assumption until a device test; Android OEM background killers may end the process mid-flow, which also ends the session.

## Alternatives considered

| Alternative | Why not chosen |
| --- | --- |
| Tell users to run `ssh -L` (today) | Needs a second terminal on a phone; kept as the documented manual path. |
| Auto-forward every listener (VS Code style) | Too broad: dev servers and databases would be forwarded; unauthenticated host loopback services would become reachable from any app on the device. |
| Rewrite `redirect_uri` to a free device port | Breaks the token exchange, which repeats the original value; most identity providers register the redirect once. |
| Device-code flows only | Not controllable per tool; some tools have none (Codex has `--device-auth`, `aws sso login` has `--use-device-code`, `gcloud` has neither a device code nor a stable alternative besides paste-the-code). Documented as the no-tunnel option. |
| OSC or DCS escape sequences as the browser-open transport | Dropped by tmux, Zellij, Herdr and mosh-server (measured); needs user configuration where it works. |
| A remote browser view of the host (docs/host-browser.md) | A different, later feature for seeing and driving a host browser; it does not make a device-local redirect reach the host CLI. |
| `WKWebView` or an in-app Android WebView for sign-in | Embedded user agents are forbidden by RFC 8252 section 8.12, blocked by large identity providers and cannot use the device's password manager or passkeys. |
| Faking `DISPLAY` for `gcloud` and netbird | Changes unrelated applications; rejected. |

## Work breakdown

Children of [#1504](https://github.com/mihazs/lazysh/issues/1504): A research (this document, [#1509](https://github.com/mihazs/lazysh/issues/1509)); B detection ([#1510](https://github.com/mihazs/lazysh/issues/1510)); C tunnel engine ([#1511](https://github.com/mihazs/lazysh/issues/1511)); D browser interception shim ([#1512](https://github.com/mihazs/lazysh/issues/1512)); E guest open ([#1513](https://github.com/mihazs/lazysh/issues/1513)); F consent, settings and UX ([#1514](https://github.com/mihazs/lazysh/issues/1514)); G end-to-end tests ([#1515](https://github.com/mihazs/lazysh/issues/1515)). Order: B, C and F can proceed in parallel and together give the Tier 0 release (tap the URL, allow, tunnel, in-app browser from E); D follows and needs the newer companion.

## Validation and what is not verified

- Verified in this research: the table of measured findings above (versions given), the multiplexer probes, the source and documentation facts cited.
- Not verified: any behaviour on a real iPhone or Android phone (no iOS hardware; Waydroid not used in this research); the full sign-in round trip (it belongs to [#1515](https://github.com/mihazs/lazysh/issues/1515) with a fake identity provider and a fake CLI); real `aws sso login` and `gcloud auth login` against real identity providers (documented manual checks in the how-to); NetBird, Firebase, Wrangler, Terraform, Vault, kubelogin, Vercel, Fly and Stripe behaviour beyond their documentation; the `Previews` manual workaround end to end.
- Each child states which of these it closes.

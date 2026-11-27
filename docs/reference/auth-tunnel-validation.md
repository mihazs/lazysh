# Sign-in tunnel: what is tested and what you check by hand

Status: the checks of [epic #1504](https://github.com/mihazs/lazysh/issues/1504) that exist on `main`, from the end-to-end test of [#1515](https://github.com/mihazs/lazysh/issues/1515). The design is [ADR 0004](../architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md); the contracts are in [Sign-in tunnel contracts](auth-tunnel.md).

No test here uses a real identity provider, a real account or a credential. Real tools and real phones are **manual gates**: nobody has run them for this change, and a release note must not say they passed until someone has.

## What the automated tests prove

| Layer | Test | Run it with | What it asserts |
| --- | --- | --- | --- |
| Whole sign-in over real SSH | `ssh::tests::openssh_sign_in_completes_through_the_tunnel_with_a_fake_provider_and_fake_clis` | `cargo test --lib -- --ignored --exact <name>` in `apps/client/src-tauri` (needs `sshd` and `python3`) | A fake identity provider (authorize and token with PKCE and an exact `redirect_uri` check) and a fake CLI shaped like `aws sso login` (callback server on `0.0.0.0`, random port, printed authorize URL) run on an owned `sshd`. The app's own terminal path reports the hint and the hint carries no `state` or challenge; nothing listens on the device until the call the Allow button makes; the browser's redirect then reaches the CLI through the tunnel, the CLI exchanges the code with the **unchanged** redirect URI and finishes; the tunnel reports `callback` then `callbackDelivered`, its listener closes and nothing is left registered; no token or `state` appears in any event. A device-code CLI is never reported as a sign-in. |
| Tunnel engine over real SSH | `ssh::tests::auth_tunnel_fixture::openssh_auth_tunnel_*` ([#1511](https://github.com/mihazs/lazysh/issues/1511)) | `bun run test:openssh-auth-tunnel` | Real `direct-tcpip` channels to a fake callback server bound every way, the request guard against other protocols and pages, a host that stops listening or forbids forwarding (`forwardingDisabled`, with its reason), a hundred flows leaving no listener or channel; a Mosh stand-in that keeps its SSH control connection. |
| Host launchers and the shim | `apps/agent/tests/browser_shim.rs` ([#1512](https://github.com/mihazs/lazysh/issues/1512)) | `cargo test -p lazysh-agent --test browser_shim` | A fake CLI reaches the attached device through every launcher it may use (`xdg-open`, `BROWSER`, Python `webbrowser`), with the asking process's listening ports in the frame, and gets the host's own opener when no device is attached. |
| Device opening on Android | `AuthBrowserTest` instrumented on Waydroid ([#1513](https://github.com/mihazs/lazysh/issues/1513), [Open a sign-in page on your device](../guest-browser.md)) | see that page | A fake identity provider and its callback listener on the device loopback, a page opened through the plugin with lazysh in front and not, and the browser following the redirect to the listener. |

## What they cannot prove

- **The banner and the Rust engine in one process.** The decision to allow is the renderer's, the tunnel is Rust. The whole-sign-in test makes the call the Allow button makes. The consent banner and per-host settings ([#1514](https://github.com/mihazs/lazysh/issues/1514)) are not on `main` yet, so no test covers them here.
- **A launcher request through the app.** A CLI that prints no address and only calls `xdg-open` is proved up to the companion (the shim row above) and, separately, device opening after the tunnel is bound (`AuthBrowserTest`, `auth_browser` unit tests). The app command that carries a launcher request from the companion's `browser-watch` is not on `main`, so no test chains them over SSH.
- **Two machines.** The host and the device are one machine in these tests, so the device listener takes another port than the host's callback server (the engine's test override) and the fake browser swaps the port when it follows the redirect. That the app listens on the *same* port number and never rewrites the redirect is asserted through the exact `redirect_uri` the token endpoint receives and by the engine's own tests; it is not observed end to end with a free port on both sides.
- **The whole app on Waydroid or a phone.** Waydroid ran the Android half of [#1513](https://github.com/mihazs/lazysh/issues/1513), not the whole app against a host. No iPhone or Android phone has run any of this; iOS is compile-checked by the CI build only.
- **Real tools.** `aws`, `gcloud`, `gh`, `az`, `codex`, `claude` and `netbird` were measured in the research ([observed flows](sso-login-flows.md)) with fake identity providers, not signed in with.
- **Mosh and Eternal Terminal with a live server**, beyond the engine's stand-in, and hosts that are not Linux or macOS.

## Manual gates for real tools

Run each on a Linux or macOS host with the companion installed, from a phone or a desktop that runs lazysh, over SSH. Report the tool version, the device and its OS version, and what you saw, including failures. Do not paste an address, a `code` or a `state` into an issue.

1. **`aws sso login`**, with an SSO session in `~/.aws/config`. Start the tunnel for the printed callback port, then follow the printed link on the device. Expect the identity provider, then the CLI's page and `Successfully logged into Start URL`; afterwards the port is free on the device. Repeat with the port taken on the device first (`python3 -m http.server PORT`): the tunnel must report which port is busy and nothing may open.
2. **`gcloud auth login`** on a host where a browser is available (`DISPLAY` set, or the browser shim installed so `xdg-open` reaches the app). Expect a redirect to `localhost:8085` or the next free port. Without a display it chooses the paste-the-code flow: no tunnel is correct.
3. **`gh auth login --web`** uses a device code, so **no tunnel** is correct.
4. **`codex login`** (fixed port 1455) and **`claude auth login`** (prints a paste-the-code address and opens the `localhost` one in a browser): the first from the printed address; the second only through the browser shim.
5. **`netbird up`** on a desktop host (its callback server runs in a root-owned daemon): expect the listener check to report another user's program on the port.
6. **Shim**: `lazysh-agent browser-shim install`, open a new shell, run `xdg-open https://example.com` there and expect the request at the device; `uninstall` and expect the host's own opener again.
7. **Secrets**: after each run, search the app log and any exported report for the `code=` and `state=` values: neither may appear.

The phone steps (backgrounding, screen off, the iPhone questions) are in [Sign in on a host from your device](../how-to/sign-in-on-a-host-from-your-device.md#check-it-on-a-real-phone-acceptance-steps).

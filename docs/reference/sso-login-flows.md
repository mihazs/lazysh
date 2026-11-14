# Observed sign-in flows of command-line tools

Status: research record for [ADR 0004](../architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md) and [epic #1504](https://github.com/mihazs/lazysh/issues/1504), measured on 2026-11-13. It describes what the listed versions did on one Linux host; other versions, operating systems and identity providers can differ. Nothing here is a lazysh feature. Rows marked *documented* were read from official documentation or source and were not run.

## Method

Each tool ran in a pseudo-terminal with `env -i`, an empty temporary `HOME` and configuration directory (`AWS_CONFIG_FILE`, `CLOUDSDK_CONFIG`, `AZURE_CONFIG_DIR`, `GH_CONFIG_DIR`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `NPM_CONFIG_USERCONFIG`), no credentials and a time limit of 6 to 20 seconds. Browser launchers were stand-ins. This is the whole recording launcher; the stand-ins were symlinks to it named `xdg-open`, `open`, `sensible-browser`, `x-www-browser`, `www-browser`, `gio`, `gnome-open`, `kde-open`, `wslview`, `firefox`, `google-chrome`, `chromium` and `epiphany`:

```sh
#!/bin/sh
printf '%s\t%s\n' "$(basename "$0")" "$*" >> "$SSO_LAB_LOG"
```

Four environments per tool:

| Name | `DISPLAY` | `BROWSER` | Launchers on `PATH` |
| --- | --- | --- | --- |
| clean | unset | unset | none |
| headless | unset | unset | the recording launchers |
| browser | unset | the recording launcher | the recording launchers |
| display | `:99` (no X server exists) | unset | the recording launchers |

While the command waited, a harness walked the child's process tree, mapped every `LISTEN` socket in `/proc/net/tcp` and `/proc/net/tcp6` to its owner through `/proc/PID/fd`, and recorded address, port, process name and user id. This is the same unprivileged algorithm the planned `lazysh-agent listeners` uses. Terminal queries were answered like a terminal would, and for prompts that wait for Enter the harness sent it.

Stand-ins for services: the AWS CLI's OIDC registration endpoint was replaced with a local server through `AWS_ENDPOINT_URL_SSO_OIDC` (the sign-in page, authorize URL and callback server are the real CLI's; the identity provider is fake), and `npm login` ran against a local fake registry. Everything else contacted the real service without credentials: `gcloud` and `az` fetch public metadata; `gh auth login --web` requested a device code from GitHub that was never approved and expired; `claude` and `codex` build their authorize URLs offline. The `state`, `code_challenge`, `nonce`, port and user-code values below were replaced with placeholders.

## Classification

| Tool and version | Flow | Callback listener | Redirect the identity provider is given | Alternative with no callback |
| --- | --- | --- | --- | --- |
| `aws sso login` (aws-cli 2.37.9) | Authorization code with PKCE (`S256`) | `0.0.0.0`, random port, process `aws`; a 10-minute overall wait (`_OVERALL_TIMEOUT` in `customizations/sso/utils.py`) | `http://127.0.0.1:PORT/oauth/callback`; the same `redirectUri` is sent again to the token endpoint (`botocore/utils.py`) | `--use-device-code`. `--no-browser` still starts the listener and still prints the localhost URL |
| `aws login` (console credentials) | Authorization code with PKCE (`SHA-256`) | `0.0.0.0`, random port, process `aws` | `http://127.0.0.1:PORT/oauth/callback` | `--remote` (paste the code) |
| `gcloud auth login` (592.0.0) | Authorization code with PKCE (`S256`) when a display is set; paste-the-code otherwise | `127.0.0.1`, first free port from 8085 | `http://localhost:8085/`; headless: `https://sdk.cloud.google.com/authcode.html` | `--no-launch-browser`, `--no-browser` (needs a second machine with gcloud) |
| `az login` (2.90.0) | Authorization code with PKCE (`S256`) when a launcher exists; device code when none | `0.0.0.0`, random port, process `python` | `http://localhost:PORT` with `response_mode=form_post` (the callback is a `POST`) | `--use-device-code`, chosen automatically with no launcher |
| `gh auth login --web` (2.103.3) | Device code | none | none: the URL is `https://github.com/login/device` and the code is typed there | not needed |
| `claude auth login` (2.1.322) | Authorization code with PKCE (`S256`) | `127.0.0.1`, random port, process `claude`, started even when nothing can open a browser | **Two URLs.** The one opened has `http://localhost:PORT/callback`; the one printed has `https://platform.claude.com/oauth/code/callback` (paste the code) | paste the code at `Paste code here if prompted >` |
| `codex login` (0.167.0) | Authorization code with PKCE (`S256`) | `127.0.0.1:1455` (fixed) | `http://127.0.0.1:1455/auth/callback`, while the announcement says `http://localhost:1455` | `--device-auth` |
| `npm login --auth-type=web` (11.18.0) | Poll a session URL | none | none: prints `Login at: URL`, polls `doneUrl` | `--auth-type=legacy` |
| `netbird up` | PKCE with a callback when the host has a graphical session, otherwise device flow (*documented*: `shouldUseDeviceFlow` in `client/internal/auth/oauth.go`) | all interfaces (`:PORT`), in the process that waits for the token; the redirect list comes from the management server (commonly `http://localhost:53000/` and `:54000/`) | `http://localhost:53000/` or the first free one of the list | `--no-browser` prints the URL; headless Linux uses the device flow |
| `firebase login` (*documented*) | Authorization code | `localhost`, first free port from 9005, all interfaces by Node default | `http://localhost:PORT` | `--no-localhost` (session id, paste the code) |
| `wrangler login` (*documented*) | Authorization code | `localhost`, 8976 | `http://localhost:8976/oauth/callback` | `--device` (the docs suggest fetching the URL with `curl` on the host) |
| `terraform login` (*documented*) | Authorization code | `127.0.0.1` over IPv4, a random port inside the server's `ports` range (10000 to 10010 in the documented example) | `http://localhost:PORT/login` | create a token in the web UI and paste it |
| `vault login -method=oidc` (*documented*) | Authorization code | `localhost`, 8250 | `http://localhost:8250/oidc/callback` | `skip_browser`, enter the URL by hand (the callback still needs the listener) |
| kubelogin (*documented*) | Authorization code | `127.0.0.1:8000`, then `:18000` | `http://localhost:8000` | `--grant-type=authcode-keyboard` |
| `vercel login` (*documented*) | Device flow (RFC 8628) since the 2026 change | none | none | not needed |
| `fly auth login` and `stripe login` (*documented*) | Open a session or pairing URL and poll | none | none | `stripe login --interactive`, `--non-interactive` prints JSON |

Of the eight commands that were run, six start a localhost callback (`aws sso login`, `aws login`, `gcloud` with a display, `az` with a launcher, `codex`, `claude`) and two do not (`gh`, `npm`).

## Which launcher each tool called

The first launcher recorded, or the outcome, per environment. `BROWSER` is the stand-in; a blank means the environment was not run for that tool.

| Tool | clean | headless | browser | display |
| --- | --- | --- | --- | --- |
| `aws sso login` | prints the URL | `www-browser` | `BROWSER` | `chromium` |
| `aws login` | | | `BROWSER` | |
| `az login` | device code, no listener | `www-browser` | `BROWSER` | `chromium` |
| `gcloud auth login` | | none (paste-the-code) | none (paste-the-code; `BROWSER` is not enough without a display) | `chromium --new-window URL` (with `BROWSER` as well, `BROWSER`) |
| `gh auth login --web` | `exec: "xdg-open,x-www-browser,www-browser,wslview": executable file not found in $PATH`, prints the URL | `xdg-open` | `BROWSER` | `xdg-open` |
| `claude auth login` | prints the URL, listener running | none | `BROWSER` | `xdg-open` |
| `codex login` | prints the URL | `chromium` | `BROWSER` | `chromium` |
| `npm login` | `Browser unavailable. Please open the URL manually` | `xdg-open` | `xdg-open` (`BROWSER` ignored) | `xdg-open` |

What follows from it, with the sources read:

- `gcloud` (`command_lib/util/check_browser.py`) launches only on Linux when `DISPLAY`, `WAYLAND_DISPLAY` or `MIR_SOCKET` is non-empty, and refuses `www-browser`; otherwise it chooses the paste-the-code flow itself.
- Python's `webbrowser` module (`aws`, `az`, `gcloud`) honors `BROWSER` at all times; without a display it falls back to console browsers such as `www-browser`, and with a display it tries graphical launchers and browser names.
- Go and Rust launchers (`gh`, `codex`) honor `BROWSER`, then search `xdg-open`, `x-www-browser`, `www-browser`, `wslview` (the error text above) or a list that includes `chromium`.
- `npm` runs `xdg-open` and does not read `BROWSER`.

## Captured output

Each block is the visible text, with escape sequences removed and the variable values replaced.

`aws sso login`, environment *headless* (the same text with `--no-browser` begins `Browser will not be automatically opened.` and `Please visit the following URL:`):

```text
Attempting to open your default browser. If the browser does not open, open the following URL.
If you are unable to open the URL on this device, run this command again with the '--use-device-code' option.

http://127.0.0.1:18700/authorize?response_type=code&client_id=fake-client&redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Foauth%2Fcallback&state=<state>&code_challenge_method=S256&scopes=sso%3Aaccount%3Aaccess&code_challenge=<challenge>
```

`aws login`, environment *browser*:

```text
https://us-east-1.signin.aws.amazon.com/v1/authorize?response_type=code&client_id=arn%3Aaws%3Asignin%3A%3A%3Adevtools%2Fsame-device&state=<state>&code_challenge_method=SHA-256&scope=openid&redirect_uri=http%3A%2F%2F127.0.0.1%3A<port>%2Foauth%2Fcallback&code_challenge=<challenge>
```

`az login`, environment *headless*, where the launcher call succeeded. The terminal shows the address without its query; the launcher received `https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize?client_id=<id>&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A<port>&scope=...&state=<state>&response_mode=form_post&code_challenge=<challenge>&code_challenge_method=S256&nonce=<nonce>&client_info=1&prompt=select_account`:

```text
WARNING: A web browser has been opened at https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize. Please continue the login in the web browser. If no web browser is available or if the web browser fails to open, use device code flow with `az login --use-device-code`.
```

`az login`, environment *clean*:

```text
To sign in, use a web browser to open the page https://login.microsoft.com/device and enter the code <user-code> to authenticate.
```

`codex login`, any environment (the printed redirect uses `127.0.0.1`, the announcement uses `localhost`):

```text
Starting local login server on http://localhost:1455.
If your browser did not open, navigate to this URL to authenticate:

https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback&code_challenge=<challenge>&code_challenge_method=S256&state=<state>&scope=openid+profile+email+offline_access+api.connectors.read+api.connectors.invoke&id_token_add_organizations=true&codex_cli_simplified_flow=true&originator=codex_cli_rs

On a remote or headless machine? Use `codex login --device-auth` instead.
```

`claude auth login`, any environment. The printed text is an OSC 8 hyperlink whose target and text are both the paste-the-code URL; the launcher receives the other URL (`redirect_uri=http%3A%2F%2Flocalhost%3A<port>%2Fcallback`):

```text
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins&code_challenge=<challenge>&code_challenge_method=S256&state=<state>
Paste code here if prompted >
```

`gcloud auth login`, environment *headless* (no localhost; with a display the redirect is `http%3A%2F%2Flocalhost%3A8085%2F` and the text begins `Your browser has been opened to visit:`):

```text
Go to the following link in your browser, and complete the sign-in prompts:

    https://accounts.google.com/o/oauth2/auth?response_type=code&client_id=32555940559.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fsdk.cloud.google.com%2Fauthcode.html&scope=openid+...&state=<state>&prompt=consent&token_usage=remote&access_type=offline&code_challenge=<challenge>&code_challenge_method=S256

Once finished, enter the verification code provided in your browser:
```

`gh auth login --web`, environment *browser*:

```text
! First copy your one-time code: <user-code>
Press Enter to open https://github.com/login/device in your browser...
```

`npm login`, any environment (the web URL and `doneUrl` came from the fake registry):

```text
npm notice Log in on http://127.0.0.1:18701/
Login at:
http://127.0.0.1:18701/login/abc
Press ENTER to open in the browser...
```

## Terminal multiplexers and Mosh

Probe: each multiplexer ran in a pseudo-terminal that played the outer terminal; a pane printed six sequences and the harness counted which reached the outer terminal. The harness answered terminal queries and used private socket, configuration and `HOME` locations for tmux, Zellij and Herdr; Herdr's first-run dialogs were dismissed with keystrokes; each private server was stopped by its own process id afterwards.

| Sequence printed in the pane | tmux 3.8, `allow-passthrough` off | tmux 3.8, `on` or `all` | Zellij 0.46.0 | Herdr 0.9.5 |
| --- | --- | --- | --- | --- |
| private OSC `7777;...` | dropped | dropped | dropped | dropped |
| OSC `1337;...` | dropped | dropped | dropped | dropped |
| DCS wrapped in `tmux;` | dropped | **forwarded** | dropped | dropped |
| plain DCS | dropped | dropped | dropped | dropped |
| OSC 8 hyperlink | dropped | dropped; **forwarded** after `set -as terminal-features ",xterm-256color:hyperlinks"` | **forwarded** | dropped |
| OSC 52 clipboard write | forwarded | forwarded | forwarded | forwarded |

`mosh-server` 1.4.0 (`Dispatcher::OSC_dispatch`, read from source) acts on OSC 0, 1, 2 and 52 and ignores every other OSC command. `allow-passthrough` defaults to `off` (the tmux manual); OSC 52 is a clipboard write, so it is not usable as a request channel.

## Not measured

macOS and Windows hosts (including `open`, `start`, `osascript`-based launchers and PowerShell); `netbird` (a login would have changed the machine's live connection); `firebase`, `wrangler`, `terraform`, `vault`, kubelogin, `vercel`, `fly`, `stripe` and `supabase` (not installed or not run, documentation and source only); any real identity provider's page; Safari, Chrome and Firefox behavior for a `POST` from an `https` page to `http://localhost`; Android and iOS devices.

## Reproduce

Create the launcher and its symlinks in a scratch directory, point the tool's configuration directory at an empty directory, run the command with `env -i` and the environment of your choice, and list `LISTEN` sockets of its process tree. Anything printed to the terminal is the tool's real output; delete `state`, `code_challenge`, `nonce` and codes before sharing it.

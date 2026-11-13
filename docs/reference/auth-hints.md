# Sign-in hints: what the terminal scanner reports

Status: implemented for SSH, Mosh and Eternal Terminal sessions (not local terminals), as the detection step of [epic #1504](https://github.com/mihazs/lazysh/issues/1504) and ADR 0004 (`docs/architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md`) (#1510). **A hint only tells the app that a sign-in is waiting for a callback on the host's `localhost`. Nothing is tunnelled, forwarded or opened because of one.** The tunnel, the consent banner and opening the page on the device are separate changes.

## Why

`aws sso login`, `codex login`, `gcloud auth login`, `az login` and similar commands start a callback server on the host and print an authorize URL whose `redirect_uri` is `http://localhost:PORT/...`. On the device `localhost` is the device, so the page never reaches the command. The scanner is how the app learns that port, the callback path and who the identity provider is.

## What the scanner does

It reads the bytes a session prints, in Rust before they reach the renderer, so it also runs while the WebView is suspended on a phone. It strips colour, cursor and other escape sequences, keeps an OSC 8 hyperlink only when the text it shows is the address it opens, and reads each URL it finds.

A **hint** needs one of these:

| Evidence | `source` | Example |
| --- | --- | --- |
| An `http(s)` URL of at most 4096 bytes with one of the parameters `redirect_uri`, `redirect_url`, `redirectUri`, `callback`, `callback_url` or `redirect` whose value (decoded once, or twice when it was encoded twice) is `http://localhost`, `http://127.0.0.1` or `http://[::1]` with a port from 1024 to 65535 and an optional path | `url` | `aws sso login`, `aws login`, `codex login`, `gcloud auth login` with a browser, `wrangler login`, `terraform login`, `vault login -method=oidc`, `firebase login` |
| The same URL as an OSC 8 hyperlink whose text is its own target (also when the program wrapped the text across lines) | `osc8` | |
| A bare `http://localhost:PORT[/path]` on a line that talks about signing in (`login`, `sign in`, `OAuth`, `authentication`, `authorize`, `SSO`). It only corroborates: a later step needs a listener to confirm it. | `announcement` | `Starting local login server on http://localhost:1455.`, `Open http://localhost:8000 for authentication` |

A URL a program wrapped over several lines is joined when the line is wide (at least 40 columns), the next line starts at the same indentation and holds only URL characters that look like the rest of a URL (not prose, a bullet or another URL), up to 16 lines. A box border (`│`) around the lines is ignored. Wrapping can report the callback in two steps (the first line holds the redirect, the next adds the code challenge), so the same `port` may arrive twice with more information the second time.

What it never reports: a redirect to a public host or to `https`, a port below 1024 or above 65535, a host that only starts like a loopback name (`localhost.evil.example`, `127.0.0.1.evil.example`, `localhost@evil.example`), a URL longer than 4096 bytes, an OSC 8 hyperlink whose text differs from its target, a bare `http://localhost:3000` in a dev server's log, and a port equal to the host's own SSH port. A hint for a database, cache, remote-access or admin port (1433, 1521, 2049, 2375, 2376, 2379, 3306, 3389, 5432, 5900, 6379, 8500, 9200, 11211, 27017) is marked `sensitive`; it may only ever be tunnelled when the user names it.

Commands that print no URL carrying the redirect are not hinted by this step: `claude auth login` prints the paste-the-code URL and only opens the `localhost` one in the browser, and `az login` prints its address without the query. They need the host's browser launcher (later work) or a listener that appears after the sign-in message.

## The event

The scanner sends the hint with the terminal's own events, so it follows the app lock like terminal output does (while the app is locked it is dropped, not queued). `App` announces each one as a window event:

```ts
window.addEventListener('lazysh-auth-hint', event => {
  const { sessionId, hint } = (event as CustomEvent<AuthHintDetail>).detail;
});
// or: onAuthHint(({ sessionId, hint }) => ...) from src/authHints.ts
```

```json
{
  "id": "uuid",
  "source": "url",
  "host": "127.0.0.1",
  "port": 36871,
  "path": "/oauth/callback",
  "idpHost": "us-east-1.signin.aws.amazon.com",
  "pkce": true,
  "sensitive": false,
  "firstSeenAt": "2026-11-13T10:00:00Z"
}
```

`path` carries no query. `idpHost` is the host of the URL that held the redirect and is absent for an announcement. `pkce` is true when the URL carries a `code_challenge`. There is no field for the query, `code`, `state`, `nonce` or `login_hint`: the scanner reads their shape and never copies them, so they cannot reach an event, a log line or an error. The scanner holds at most 24 KiB of the host's output between chunks and reads 1-byte chunks the same as whole ones.

The same callback (same port and path) is reported once per 10 minutes unless stronger evidence arrives (an announcement followed by the authorize URL, or a URL that turns out to carry a code challenge). At most 12 callbacks are reported per session per 10 minutes; a host that prints more is not a sign-in.

## Limits

- Hints come from text. A command that prints a bare `http://localhost:PORT` with no sign-in word on the line is not reported.
- A URL cut mid-redirect by a program's wrapping is only read correctly when the continuation follows the joining rule above.
- A URL on a line of 40 columns or more whose redirect is its last parameter could be cut short by a wrap, so it is reported when the next line of output arrives. A command that prints exactly that and then stays silent is reported only when it prints again.
- Local terminals are not scanned (the device is the host there).
- Not verified: behaviour with a real identity provider, and with the commands on macOS or Windows hosts. The recorded outputs the tests use are in `apps/client/src-tauri/src/auth_hints/fixtures/`, with their provenance; wrangler, firebase, terraform, vault and kubelogin were written from their documentation.

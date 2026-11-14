# Sign-in tunnel and device browser: contracts and limits

Status: specification. Nothing on this page is implemented or released. It fixes the names, schemas, defaults and bounds that [ADR 0004](../architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md) decides, so that detection ([#1510](https://github.com/mihazs/lazysh/issues/1510)), the tunnel engine ([#1511](https://github.com/mihazs/lazysh/issues/1511)), the shim ([#1512](https://github.com/mihazs/lazysh/issues/1512)), device opening ([#1513](https://github.com/mihazs/lazysh/issues/1513)) and the settings ([#1514](https://github.com/mihazs/lazysh/issues/1514)) agree. A child may refine a value with a recorded reason. User steps are in [Sign in on a host from your device](../how-to/sign-in-on-a-host-from-your-device.md); the observed tool behavior is in [Observed sign-in flows](sso-login-flows.md).

## Settings

Per host, kept on the device, never synced and cleared when the host key changes. The default of both is **Ask**.

| Setting | Values | Effect |
| --- | --- | --- |
| Auto tunnel for auth callbacks | Ask, Always, Never | Ask shows the banner for a confirmed hint. Always starts the tunnel without it and shows a toast with Stop. Never ignores hints and counts them. |
| Open host browser requests on this device | Ask, Always, Never | Applies to launcher requests received over the companion channel. A request that only reached the terminal as text is never opened automatically. |
| Browser on this device | In-app tab (default on Android and iOS), system browser | Desktop always uses the system browser. |

Always never applies to: a port below 1024; a port in the sensitive list (22, 23, 25, 53, 110, 143, 389, 445, 1433, 1521, 2049, 2375, 2376, 2379, 3306, 3389, 5432, 5900, 6379, 8500, 9200, 11211, 27017); a listener owned by another user; a hint that is not confirmed.

## Hint (inside the app)

Produced by the output scanner, the launcher channel or listener evidence.

```json
{
  "id": "uuid",
  "sessionId": "...",
  "source": "url | osc8 | announcement | launcher | listener",
  "host": "localhost | 127.0.0.1 | [::1]",
  "port": 8085,
  "path": "/",
  "idpHost": "accounts.google.com",
  "pkce": true,
  "command": "gcloud",
  "listener": { "bind": "loopback | wildcard", "ownedBySessionUser": true, "ageSeconds": 2 },
  "state": "pending | confirmed | allowed | tunnelling | done | denied | expired | failed",
  "firstSeenAt": "2026-11-13T10:00:00Z"
}
```

`path` has no query. There is no field for a URL query, `code`, `state` or `login_hint`: the scanner does not keep them. `idpHost` is the host of the authorize URL when there is one. `command` is the process name when the companion reports it.

Extraction: the parameters `redirect_uri`, `redirect_url`, `redirectUri`, `callback`, `callback_url` and `redirect`, decoded up to twice, with a value `http://` followed by `localhost`, `127.0.0.1` or `[::1]`, a port from 1024 to 65535 and an optional path. URLs longer than 4096 bytes and OSC 8 targets that disagree with their text are ignored.

## Companion commands

All write one JSON object per line with `"schemaVersion": 1`, ignore unknown fields on read, and answer exit status 2 on a companion that predates them (the app then falls back or asks to update the companion, see [#1441](https://github.com/mihazs/lazysh/issues/1441)).

### `lazysh-agent listeners [--port N]... [--watch] [--interval-ms 250..5000] [--json]`

One `snapshot` event, or with `--watch` one `snapshot` then `listen` and `close` events and a `heartbeat` after 5 seconds of silence; it ends when stdin closes.

```json
{"schemaVersion":1,"event":"snapshot","listeners":[
  {"family":"tcp4","address":"0.0.0.0","bind":"wildcard","port":36871,"uid":1000,"ownedBySessionUser":true,"pid":4029144,"comm":"aws","startedAt":"2026-11-13T10:00:01Z"}
]}
```

Only sockets in the listening state bound to loopback or a wildcard address are listed. At most 256 entries. `comm` is the kernel process name; no argument vector or environment is read or returned. A listener whose owner cannot be read (another user's process) is listed with `pid` and `comm` absent and `ownedBySessionUser` false. Platforms: Linux from `/proc/net/tcp{,6}` and `/proc/PID/fd`; macOS from `lsof`; Windows from the TCP table API.

### `lazysh-agent browser-open URL`

Hands one URL to the attached watcher and exits 0 within 100 ms. Only `http` and `https`, at most 4096 bytes, no control characters. With no watcher attached or an unsupported argument it executes the next real launcher (not itself) or the saved `BROWSER`.

### `lazysh-agent browser-watch [--protocol 1]`

A long-lived exec channel that ends when stdin closes.

| Frame | Fields | Meaning |
| --- | --- | --- |
| `hello` | `protocol`, `companion`, `intervalMs` | First line. A client that does not know `protocol` stops. |
| `open` | `id`, `url`, `launcher`, `pid`, `chain[]`, `listeners[]` | One request. `chain` is the process names from the launcher up to the session shell; `listeners` are the ones owned by that process tree. |
| `heartbeat` | none | After 5 seconds without another frame. |
| `end` | `reason` | The channel is closing. |

The app acknowledges nothing: the launcher has already exited 0. At most one watcher per user is active; a second one receives `end` with reason `replaced`.

### `lazysh-agent browser-shim install | status | uninstall [--json]`

Linux and macOS hosts only in the first increment. Off until `install`. `install` writes wrappers (`xdg-open`, `sensible-browser`, `x-www-browser`, `open` on macOS, `lazysh-open`) into the managed companion directory and one marked block into the interactive startup files of bash, zsh, fish and `~/.profile`; `uninstall` removes exactly those; `status` lists them and says whether a watcher is attached. Nothing outside the home directory is written.

## Tunnel limits

| Bound | Value |
| --- | --- |
| Flows per session, per app | 4, 8 (Previews has its own 4 and 16) |
| Concurrent connections per flow | 8 |
| Flows per host per 10 minutes | 6 (a seventh asks every time) |
| Flow lifetime | 10 minutes; 15 seconds after the first callback request |
| Request head, request total, response total | 16 KiB read within 5 seconds, 64 KiB, 1 MiB |
| Connection lifetime | 60 seconds |
| Device listener | `127.0.0.1` and `[::1]` only |
| Host connection | the host's `127.0.0.1`, else `[::1]`; opening a channel waits up to 15 seconds for a free opening |
| Ports | 1024 to 65535 unless the user confirms; never the session's SSH port |

Guard: the first request on a connection must be HTTP/1.x `GET` or `POST`, with `Host` equal to `localhost`, `127.0.0.1` or `[::1]` and the flow's port, a target inside the hinted path, no `Upgrade`, and `Sec-Fetch-Mode` equal to `navigate` when present. A refused request is answered on the device (`404` or `421`) and never reaches the host.

Flow ends: `callbackDelivered`, `timeout`, `cancelled`, `sessionEnded`, `lockEnded`, `hostStoppedListening`, `portBusy`, `forwardingDisabled`, `controlConnectionLost`, `denied`. These identifiers, the port, the command name when known and the time are all that the in-memory audit list keeps.

## Launcher requests

Per host: 6 per minute, identical URL deduplicated for 10 seconds, a queue of 8, entries expire after 2 minutes. A URL is opened only after the banner is accepted or the host policy is Always, and after the tunnel it needs is bound.

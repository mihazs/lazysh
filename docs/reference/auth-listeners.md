# Confirming a sign-in hint against the host's listeners

Status: implemented as a command and a helper; no screen uses them yet ([#1514](https://github.com/mihazs/lazysh/issues/1514)). Part of the detection step of [epic #1504](https://github.com/mihazs/lazysh/issues/1504) (#1510); ADR 0004 is `docs/architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md`. **Asking the host what listens on a port reads and changes nothing, and tunnels nothing.**

A sign-in hint says a command printed a callback on `http://localhost:PORT`. A printed URL proves little: a dev server also prints `localhost` addresses, and a program can print anything. The stronger evidence is a listener on that port that belongs to the sign-in, and `check_auth_listener` finds it.

## The command

`check_auth_listener(sessionId, port, seenSecondsAgo)` (Tauri command; `checkAuthListener(lease, sessionId, port, seenSecondsAgo)` in `src/authListeners.ts`) asks the host once and answers:

```json
{"state": "confirmed", "listener": {"source": "companion", "bind": "loopback", "ownedBySessionUser": true, "ageSeconds": 2, "comm": "aws", "pid": 4312}}
```

| `state` | Meaning |
| --- | --- |
| `absent` | Nothing listens on the port. |
| `confirmed` | A listener's process started up to 120 seconds before the hint was seen, or up to 30 seconds after it. |
| `stale` | A listener exists but its process started outside that window: a long-running program, such as a dev server or a daemon, not this sign-in's own callback server. |
| `unproven` | A listener exists and its age is unknown, because the host's companion predates `lazysh-agent listeners` (or is missing), so `ss` or `lsof` answered. |

`seenSecondsAgo` is how long ago the hint was seen on the device; `ageSeconds` is how long the host's process had run, read on the host. Both are durations, so a host clock that is wrong does not matter. `listener.ownedBySessionUser` is false for another user's process (the NetBird daemon); the policy step never auto-tunnels such a listener. The port must be 1024 or higher.

The host is asked with `lazysh-agent listeners --json --port N` (the section "Listening ports for sign-in callbacks" of `docs/companion.md`). When that answers with exit status 2 (a companion without the command), fails, answers something that is not the documented snapshot, or the companion is missing, the check falls back to what Previews uses (`ss -H -ltnp`, else `lsof -F`), which names the user's own process but cannot say how old it is. No argument vector or environment is read.

## Confirming over time

`confirmHint(hint, check)` in `src/authListeners.ts` turns a series of answers into one confirmation. It asks about the hint's port once a second, for up to 30 seconds after the hint was seen:

- `confirmed` and `stale` end it at once;
- `unproven` ends it as `unproven`, unless the port was seen `absent` first: a listener that appeared after the port was empty is `confirmed` with `appeared: true`;
- a port that stays empty for 30 seconds after the hint is `absent`.

Only a `confirmed` hint may be tunnelled without asking; the settings and the banner that use this are #1514.

## Limits

- One question is one SSH exec; `confirmHint` asks at most 31 times per hint, and hints are capped at 12 per session per 10 minutes by the scanner.
- `ageSeconds` is the age of the owning process, not of the socket. A long-lived process that opens a new port looks `stale`; such a flow is offered only with an explicit allow.
- Windows hosts report no process age, so their listeners are `unproven`.
- Not verified here: macOS or Windows hosts (the commands were only tested on Linux, and the macOS and Windows parsers on recorded text), and the whole flow with a real sign-in, which is #1515.

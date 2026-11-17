# OpenCode decisions through its local service

OpenCode 2.x runs its TUI against a background service on the host (`opencode service`, started on demand). That service holds the permission requests and question forms of every session and answers them over a loopback HTTP API. lazysh uses it to answer an OpenCode **permission request**, answer a **question form**, and **stop a turn** from the Agent view, instead of pressing keys. The OpenCode TUI marks the highlighted choice of those prompts by background colour only, so a read of the screen's text cannot say which row a key moved to; the service is the safe channel ([#1656](https://github.com/mihazs/lazysh/issues/1656), the OpenCode part of the decision-channel contract of [#1535](https://github.com/mihazs/lazysh/issues/1535)).

Without a usable service nothing changes: the prompt stays in the terminal and the Agent view shows no OpenCode card.

## What the app does

On a tmux pane whose hook report names exactly one OpenCode session, the Agent view lists that session's pending requests above the conversation:

- **A permission request** shows the tool and the exact resources (the command, the paths) with **Reject**, **Allow once**, **Always allow** and **Reject with a message**. **Always allow** keeps the rules OpenCode lists for the request, so it first shows each rule and sends nothing until you confirm; a request that lists no rule has no **Always allow**.
- **A question form** shows one control per field: a choice or free text, several choices, yes/no, or a number. **Send answer** is enabled once the required fields are filled. A form with a field the app cannot show (a conditional or hidden field, an external link, a request too large to read in full) is marked **Answer it in the terminal** and offers no button.
- **Stop** appears while the service says the session is running. It asks twice, like the message box's Stop, and stops the turn once.

Nothing is typed into the terminal, so switching to **Terminal** shows the prompt already closed. Taps are ignored for 400 ms after a card appears or its text changes.

## The contract

Every answer is a call of the host companion, over the existing SSH connection:

```sh
lazysh-agent opencode-service list  --session-id SES
lazysh-agent opencode-service reply --session-id SES --id per_… --expected-hash HASH --expires-at TIME --pane-id %3 --decision once|always|reject [--message TEXT]
lazysh-agent opencode-service reply --session-id SES --id frm_… --expected-hash HASH --expires-at TIME --pane-id %3 --answer '{"field":"value"}'
lazysh-agent opencode-service abort --session-id SES --pane-id %3
```

`list` prints the requests the service holds for the session, with `expectedHash` and `expiresAt` (two minutes ahead). `reply` and `abort` print `{"schemaVersion":1,"accepted":true}` or `{"accepted":false,"reason":…}` and exit successfully for a refusal, so the app can say why. Nothing is sent to the service for a refusal.

| Check | Refusal |
| --- | --- |
| `--expires-at` has passed | `expired` |
| No usable service (see below) | `unavailable` |
| `--pane-id` is given and the host's hook reports do not show exactly one session in that pane, an OpenCode one, this one | `pane` |
| The request is read again from the service immediately before the reply and is gone (answered in the terminal, on another device, or by an earlier tap) | `gone` |
| What the person saw (action, resources, rules, message; or the form's title and fields), the request id, the service identity and `--expires-at` no longer hash to `--expected-hash` | `changed` |
| The request is one the app cannot answer (oversized, unsupported field) or an **Always allow** with no listed rule | `unsupported` |
| A form answer that does not fit its fields (wrong type, unknown or missing required field) | `invalid` |

The companion checks expiry again after the host lock and immediately before writing a decision request to the socket. It checks pane reports again after service revalidation, using the current host time for retention. These are local observations: the service does not atomically enforce the expiry or pane identity, so time or pane state may change after the last check and before the service receives the request. The expiry uses the host wall clock, which can move.

| `abort` and the service says the session is not running | `idle` |

All answers on a host take one exclusive lock, so two resolvers of the same request cannot both read it as pending: the second finds it gone and sends nothing. A reply the service itself rejects with 404 or 409 is `gone`; 400 is `invalid`.

The hash covers exactly what the app shows. OpenCode's own `metadata` is never listed or hashed. Hook events (the OpenCode plugin's `permission.asked` and `form.created` reports) only tell the app that the agent waits; they never answer anything.

## How the service is found and trusted

The companion reads OpenCode's own state file, `$XDG_STATE_HOME/opencode/service.json` (default `~/.local/state/opencode/service.json`), which names the service's `url`, `pid` and `password`. The credentials never leave the host: they are not printed, sent to the app or stored there. The file must be a regular file owned by you and not readable by anyone else (mode 0600), the process must exist, and the URL must be `http://127.0.0.1:PORT`, `http://localhost:PORT` or `http://[::1]:PORT`; the companion connects to the IP literal, with no name lookup and no redirect. The registry's major version must be 2 and `GET /api/session/active` must answer with the 2.x shape. Every other case is reported as `service.available: false` with a reason: `no-service`, `unsafe-registry`, `unsafe-address`, `stopped`, `unsupported` (another version or shape), `unauthorized` or `unreachable`.

Each exchange is one HTTP/1.0 request with a 2 second connect and 5 second read timeout and a 1 MiB response cap; a chunked response is refused.

## Limits, said plainly

- **OpenCode 1.x** has no background service and writes no `service.json` (checked on the real 1.19.5, see Evidence), so its prompts stay in the terminal and the Agent view shows no OpenCode card; the companion reports `no-service`, and `unsupported` for a registry that names another major version. A 1.x TUI started with an explicit `--port` (or `opencode serve`) does listen on that port, but the port and any password come from the launch command, not from a file the companion could read, so lazysh does not look for it. The 1.x permission and question routes were not exercised, and no provider credentials were used.
- **Pane identity is the hook report's.** In OpenCode 2 the lazysh plugin runs inside the service, so a report names the pane of the process that started the service. The app and the companion therefore refuse unless exactly one OpenCode report names the pane and it is the requested session, and a person who runs several OpenCode TUIs against one service may find a pane with no card. A pane that is wrongly claimed by the only reporting session is not excluded; the request text shown is what is answered.
- **Dismissing a form** (OpenCode's Esc) is not offered; use the terminal.
- **Windows and Apple hardware** were not used. The companion code is portable but the registry's file-mode check runs on Unix only.

## Evidence

- Host tests (`apps/agent/tests/opencode_service.rs`) drive the real `lazysh-agent` executable over real loopback sockets against a stand-in for the 2.x routes (`tests/support/opencode_service.rs`) and assert what the stand-in received: one answer per request, and none for a stale, already answered, expired, concurrent, pane-replaced, unsupported or invalid one, nor for an unusable service.
- Client tests (`AgentOpenCodeDock.test.tsx`, `AgentView.test.tsx`) assert the exact identity sent, the 400 ms guard, the confirmation before **Always allow**, no send when the pane or session changed, and the refusal messages.
- Real runtime, 2026-11-15, native Linux: OpenCode 2.2.7 in a real tmux pane with an isolated profile and the real background service. A permission request and a question form created on the service with the TUI showing them, answered with the real `lazysh-agent` binary: the TUI closed each prompt, a replay was refused as `gone`, a tampered hash as `changed`, an answer of the wrong type as `invalid`. A turn on the free model was stopped through `abort` (the TUI left "esc interrupt", the service's active list emptied) and a second `abort` was refused as `idle`.
- Real OpenCode 1.19.5 (the pinned stable 1.x, `opencode-ai@1.19.5` from npm, Linux x64), 2026-11-16, isolated `HOME` and XDG directories, in a private tmux server: the command list has no `service` (`opencode service --help` prints the root help); the TUI started without flags opened no listening socket (`ss -ltnp` empty, only outbound HTTPS) and wrote nothing under `XDG_STATE_HOME`, so there is no registry to read; `opencode serve` and `opencode --port N` listen on loopback but also write no registry and the TUI does not use the former. This is what the V1 side of the "V1 and V2 shapes detected" criterion of [#1656](https://github.com/mihazs/lazysh/issues/1656) rests on: V2 is detected from `service.json` (major 2 and the `/api/session/active` shape), V1 has nothing to detect and falls to `no-service`. The host test `an_unusable_service_is_reported_and_never_contacted_for_an_answer` covers both: a registry naming 1.19.5 (`unsupported`) and a missing registry (`no-service`), with nothing sent to the service.

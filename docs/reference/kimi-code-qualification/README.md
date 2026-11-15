# Kimi Code native hook qualification

Repeatable run of an official Kimi Code release against a synthetic OpenAI-compatible endpoint, for
[#696](https://github.com/mihazs/lazysh/issues/696) and [#1634](https://github.com/mihazs/lazysh/issues/1634).
It records the hook payloads the CLI really delivers. It does not exercise lazysh ingestion, and it is not
a managed install.

```sh
gh release download '@moonshot-ai/kimi-code@2.4.1' -R MoonshotAI/kimi-code \
  -p kimi-code-linux-x64.tar.gz -p kimi-code-linux-x64.tar.gz.sha256
./qualify.sh kimi-code-linux-x64.tar.gz summary.json     # about 90 seconds, exit 1 if a claim fails
```

`qualify.sh` refuses an archive whose SHA-256 differs from its published sidecar, extracts it into a
temporary directory and runs `qualify.py` inside a bubblewrap sandbox with `--unshare-all` (no network, no
host environment, empty `HOME`, read-only `/usr`, private tmux server and `/tmp`). The mock endpoint, the
CLI and its recording hooks (`cat > receipt`) share that one namespace. It needs `bwrap`, `tmux`, `python3`
and a glibc Linux x64 host. `telemetry = false`; no credential, profile or model call leaves the sandbox.

`qualify.py` runs a strict synthetic `config.toml` through nine scenarios (prompt mode, approve, reject,
interrupt, upstream failure, a once-blocked `Stop`, a slowed approval observer, and a foreground and a
background sub-agent) plus four
configuration checks, then asserts each documented claim. `receipts-2.4.1.json` is the retained, redacted
result for 2.4.1 (official SHA-256 `f4a225fb8afe0394151e721bc3cd94d71e314fbea7f75900453556da7d8738de`):
structural fields only, no session or approval ids, no paths, no prompt text.

## Limits

- Linux x64, one OpenAI Chat Completions mock, one run per scenario (the harness was run repeatedly with the same
  verdicts). Receipt order is the start time of each recorder process; the CLI fires observers without
  ordering, so order is observed, not guaranteed.
- Not exercised: a real provider or account, `SessionHeartbeat`, compaction, task and notification events,
  plugin-provided hooks, macOS and Windows.
- Release 2.6.2 (stable on 2026-11-13) was also run once: the sandbox and the recorders work, but no `Stop`
  receipt was delivered in prompt mode or in the terminal UI, with either a recorder or a `sh` hook, so the
  harness stops at the first scenario that waits for it. The cause was not diagnosed. Nothing here is
  evidence about 2.6.2 beyond that, and lazysh stays pinned to 2.4.1.

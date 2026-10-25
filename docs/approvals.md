# Remote decisions for a waiting Claude hook

lazysh supports opt-in decisions for Claude Code's `PermissionRequest` hook. Each decision returns to the originating waiting hook's stdout. It never types into a terminal, chooses a pane by its current title, starts another agent, or changes permission rules.

Print the configuration fragment:

```sh
lazysh-agent approval-config
```

Merge the printed `PermissionRequest` entry with your existing Claude settings yourself. Keep the ordinary lifecycle hooks from `lazysh-agent claude-config` as well. No command edits settings automatically. The fragment gives the hook a 300-second decision deadline and a slightly longer Claude timeout.

The protocol follows the [official Claude hooks reference](https://code.claude.com/docs/en/hooks#permissionrequest). This event runs when a tool needs permission. Its response uses `hookSpecificOutput.decision.behavior` with `allow` or `deny`; this integration sets no updated inputs or persistent permission rules. Other configured policies still apply. PreToolUse, sandbox-network prompts, interactive questions and other agent CLIs are not claimed as supported approval paths.

An immutable request binds a random UUID, SHA-256 content hash, Claude session, project, inherited tmux pane when present, exact tool name/input, creation time and expiration. Plain terminal hooks can also use the direct response path: the originating hook process supplies the identity, so a multiplexer is not required. The UI must display the complete tool input before an explicit decision.

The hook holds an exclusive OS file lock on its private request lease. Listing hides expired requests and removes requests whose originating process has exited. Resolution requires the exact UUID, hash, session and pane and atomically updates a still-pending, unexpired row. Concurrent decisions have one winner. A cancelled hook releases its lease, and its token cannot target another hook even if session, pane and tool input repeat. Timeout returns a denial. A decision accepted immediately before process cancellation may never reach Claude; acceptance is not proof of tool execution.

The companion emits a bounded `PermissionRequest` summary to the normal event store for the agent board and notifications. It does not infer that a tool started from an approval: normal subsequent lifecycle events establish working/done state.

The separate private state directory `approvals/` contains the approval SQLite database and lease files. Unlike lifecycle summaries, pending approvals intentionally contain exact tool arguments, which can include sensitive data. Directory/database permissions are restricted on Unix; SQLite secure-delete is enabled and consumed, expired or cancelled rows are removed. This is not a promise of forensic erasure from storage or filesystem snapshots. The local user's account remains the trust boundary.

Bounds are 32 simultaneous hooks, 16 KiB of encoded tool arguments per request, 20 requests per list, and 1–600 seconds per hook. Oversized or malformed hooks fail with sanitized diagnostics and no decision output; inspect Claude's normal permission surface. Each list entry contains enough identity to resolve:

```sh
lazysh-agent approval-list --limit 20
lazysh-agent approval-resolve --id REQUEST_UUID --expected-hash HASH --session-id SESSION_ID --pane-id '%7' --decision deny
```

Omit `--pane-id` only when the listed pane is null. A stale or mismatched resolution exits unsuccessfully with no success JSON. Integration tests use fixture hook subprocesses to verify exact identity, concurrent resolution, cancellation, timeout, replay refusal and payload removal. No real Claude session was used to certify host-version behavior.

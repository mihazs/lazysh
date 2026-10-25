# Recorded token usage

The Usage view inspects counters from an explicitly selected host transcript over its existing SSH connection. Collection runs only when you inspect, refresh, or request the next records. It does not read provider credentials, contact a billing endpoint, or enable background collection.

```sh
lazysh-agent usage --agent claude --path /absolute/path/session.jsonl --offset 0
lazysh-agent usage --agent opencode --path /absolute/path/opencode.db --session-id ses_selected --offset 0
```

The command reuses the supported [transcript adapters](companion.md), their file/database validation, and their opaque cursors. It examines one bounded window of at most 100 normalized transcript records and returns the last 20 usage samples within that window. `nextOffset` and `hasMore` let the caller inspect later records. The first window is not necessarily the newest part of a large transcript. A source with no counters returns an empty sample list; absence is not zero consumption.

The response has `schemaVersion: 1`, `scope: "transcript_window"`, `agent`, `observedAt`, `nextOffset`, `hasMore`, `samplesAvailable`, `samples`, `context`, and `quota`. Each sample has a source record `id`, optional `recordedAt`, `freshness`, and nullable `inputTokens`, `outputTokens`, `cacheReadTokens`, and `cacheWriteTokens`. `samplesAvailable` counts distinct records with recognized counters in this window, before the 20-sample display limit. Missing counters remain JSON `null`; an explicitly recorded zero remains zero. Counter values outside JavaScript's safe nonnegative integer range are rejected.

Counters are **never added together**. Streaming assistant records can repeat the same provider request's usage across several content blocks. Different providers also account for cache tokens differently. Exact repeated record IDs keep their last report within the inspected window, but different IDs are not assumed to identify different billable requests. No total cost, cumulative consumption, or remaining allowance is inferred from these samples.

`observedAt` is when the host inspected the records. `recordedAt` is the transcript's message/event timestamp when present and parseable; a recently modified file does not establish a fresh counter. A report older than 15 minutes is labeled stale. Missing or future report times have unknown freshness. The client also ages displayed reports without fetching more data, using elapsed time since receipt plus the host's reported age. Refresh updates the inspected window; it does not make an old report fresh.

Context used, context window size, context remaining, provider quota and quota reset are currently unknown (`null`). A recorded input-token count is not proof of the current live context, the model's maximum context, or remaining account capacity. Some native logs contain additional context metadata, but it has not been wired into this usage protocol or independently established as the active runtime's state. Usage samples therefore do not establish which agent is currently running in the selected terminal.

Supported counters depend on the selected adapter: Claude, Pi, OMP, jcode and current OpenCode projections can carry recorded request counters; Copilot's persisted message may carry only output tokens. Other supported transcript formats can legitimately produce no samples. Per-provider/account rate-limit windows, current runtime context, provider quota APIs, opt-in background collection, nested-agent settings and independent companion settings remain [issue #18](https://github.com/mihazs/lazysh/issues/18) acceptance work.

Native Cargo tests cover duplicate/streaming counters, unknown versus zero, stale/future/undated reports, numeric bounds, cursor preservation, bounded samples and absence of prompt retention or state writes. Vitest covers protocol validation, explicit collection, stale labels, opaque pagination and discarding results from an old SSH session. These checks verify recorded-data handling; they do not validate an account's live usage or provider limits.

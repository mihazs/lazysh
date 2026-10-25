# Antigravity step-record fixtures

These JSONL records were independently authored from the pinned writer's JSON field/type contract. They contain synthetic text, no account transcript, copied implementation or executable fixture. They describe physical records, not a reconstructed conversation.

Evidence: [issue 5, comment 6395985462](https://github.com/mihazs/lazysh/issues/5#issuecomment-6395985462), official Antigravity CLI **1.4.7**, build **5900205422411776**, Linux x64. [Publisher archive](https://storage.googleapis.com/antigravity-public/antigravity-cli/1.4.7-5900205422411776/linux-x64/cli_linux_x64.tar.gz); publisher SHA-512 is recorded in `docs/remaining-agent-format-research.md`. Extracted binary length **227,840,232**, SHA-256 **40349135371a8ed1f1af1e9f8b741de99174ae9fce6380b96c2d1f543480af7a**, independently rechecked for this implementation.

Read-only ELF/Go runtime descriptor recovery identifies the record struct at virtual address `0xb65e3d8`, tool summary at `0xb0ca378`, and media summary at `0xb0ca2e8`:

- Required `source`, `type`, `status`: strings. Optional `step_index`: uint32.
- Optional `created_at`, `content`, `thinking`, `error`: strings; `exit_code`: int32; `error_code`: uint32.
- Optional `input_tokens`, `cache_read_tokens`, `output_tokens`: uint64. The reader emits decimal strings so the frontend never rounds them.
- Optional `tool_calls`: array of `{name: string, args?: object}`. No invocation/result identifier is established.
- Optional `media`: array of `{mime_type?: string, uri: string}`. The reader emits an attachment placeholder and does not open or return media URIs.
- Optional `truncated_fields`: array of strings. These are producer truncation flags, independent of reader resource limits.

The shipped documentation byte span `[0x5bc2eec, 0x5bc364a)` has SHA-256 `38de7e457b35f43ac5246ea17e785ae063fdee25698c9860e8012b250d473be8` (independently rechecked). It describes `USER_INPUT` and `PLANNER_RESPONSE` and compact versus full records. Static writer callsites connect `AppendStep`/`SetStep` to append operations and `Branch`/`WriteFullTranscript` to replacement writes. REA `inspect_go_binary` evidence `ev_2fa2455a28954f8b9597d311401870f029df6197d98f0ac9a2cf4cf341ac6286` establishes embedded Go build metadata only; the struct/writer recovery is separate static evidence.

Fixtures deliberately include repeated step indices/status changes, unknown string enums, absent step index, zero exit/error/token values, u64 counters above JavaScript precision, optional tool arguments, compact flags and inert media. Tests independently construct malformed, partial, oversized, appended and rewritten files. No Antigravity CLI, hook, account API, user transcript or media target was executed/read. Tests establish this bounded contract only, not real-file/device compatibility, enum completeness, branch semantics, crash consistency, cross-version compatibility or full conversation support.

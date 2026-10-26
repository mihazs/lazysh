# Grok ACP records fixture

These synthetic records were independently created from public serialization contracts. They contain no account data, actual transcript, copied implementation, or executable instruction. They are records, not a completed conversation.

Primary source: official `xai-org/grok-build`, commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, monorepo `SOURCE_REV` `559751fdcec02d413e4c57c8832ab275e4f44980` (inspected 2026-10-25).

- [`session/storage/mod.rs:721`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/mod.rs#L721) defines the disk envelope and its UNIX-second timestamp; lines 2669 onward contain independent upstream envelope/content fixtures. Retrieved file SHA-256: `11b3ab6208b9216d610344c102e954d582eb4a831c68c5794ff7da38d45ff3a4`.
- [`session/storage/jsonl/mod.rs:634`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs#L634) writes that envelope followed by a newline. Retrieved file SHA-256: `477c92b5bba72df345b86dd5f1884a80654bc8ea06c9d1de101cd376a1bdb083`.
- [`extensions/notification.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L517) defines the snake-case xAI extension tags/fields, including `plan_kept`, `turn_completed`, and append-only `rewind_marker`. Retrieved file SHA-256: `5923a0091d2b9661e98c86e65e439ee29388559ef2591622e119f00c3ef5a56f`.
- The pinned Grok `Cargo.lock` selects `agent-client-protocol` 0.10.4 and `agent-client-protocol-schema` 0.11.4. The [schema crate](https://crates.io/crates/agent-client-protocol-schema/0.11.4) archive checksum matches that lockfile: `ca68e7e55681ce56546c0cecc6bc8f20493d24b44c6d93ec46174f310730bba2`. Its `client.rs`, `content.rs`, `tool_call.rs`, and `plan.rs` define the standard camel-case payload fields, content chunks, optional shared `messageId`, replacement tool updates, and complete plan snapshots.

This establishes the pinned public source contract. It does not establish equivalence to the previously inspected Grok 1.0.70 binary or compatibility with every installed release. No Grok CLI, exporter, plugin, hook, account API, or user transcript was executed/accessed. Stateful chunk assembly, tool replacement, turn reconstruction, active-branch rewinds and live-agent control remain outside this reader. Metadata-only discovery is separately implemented with the existing bounded walker and does not parse file contents or infer live bindings.

Recorded tool-status fixtures in `tests/grok_acp_transcript.rs` are independently
constructed from the same pinned schema. `tool_call.rs:420–433` defines the
snake-case `pending`, `in_progress`, `completed`, `failed` enum;
`ToolCallUpdateFields.status` at line 217 is optional and does not require output.
These fixtures intentionally retain explicit values only, not protocol defaults
or inferred live state. They cover status-only records, original arguments/output,
missing/null/unknown values, tool-linked attachment placeholders and existing
999/1000-block boundaries. Status-only cards are generated metadata descriptions,
not fabricated tool output. No new artifact/version compatibility is claimed.

## Metadata-only discovery provenance

The same pinned `session/storage/jsonl/mod.rs:185–212` computes `sessions_cwd_dir_in(root, cwd)/<id>/updates.jsonl`; `storage/mod.rs:38` defines the exact filename. These files retain the checksums above. [`xai-grok-config/src/paths.rs:139`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-config/src/paths.rs#L139) appends `sessions/<encoded-cwd>` (retrieved SHA-256 `87870fd5436f0504d313abba97a515c6a5eb2736470a46288d30b6d4c689bf1e`). [`xai-dirs/src/lib.rs:46–65`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-dirs/src/lib.rs#L46) selects nonempty `GROK_HOME` verbatim, otherwise the user's `.grok` (retrieved SHA-256 `b047017fd856744eeee09fecb6abc38399982c82ecac0c42572e372ee53df665`). Its empty-override source test confirms fallback; relative paths and whitespace are preserved by its unmodified `PathBuf` conversion.

`tests/grok_discovery.rs` creates only owned synthetic directories. Discovery verifies exact depth/filename, literal environment roots, missing-root no-create behavior, result/entry budgets, symlink/nonregular rejection and absent `sessionId`. No `.cwd` decode, provider directory creation, Grok executable, account API or user transcript is involved. Compatibility with other releases remains unverified.

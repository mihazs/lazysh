# Grok ACP records fixture

These synthetic records were independently created from public serialization contracts. They contain no account data, actual transcript, copied implementation, or executable instruction. They are records, not a completed conversation.

Primary source: official `xai-org/grok-build`, commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, monorepo `SOURCE_REV` `559751fdcec02d413e4c57c8832ab275e4f44980` (inspected 2026-10-25).

- [`session/storage/mod.rs:721`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/mod.rs#L721) defines the disk envelope and its UNIX-second timestamp; lines 2669 onward contain independent upstream envelope/content fixtures. Retrieved file SHA-256: `11b3ab6208b9216d610344c102e954d582eb4a831c68c5794ff7da38d45ff3a4`.
- [`session/storage/jsonl/mod.rs:634`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/jsonl/mod.rs#L634) writes that envelope followed by a newline. Retrieved file SHA-256: `477c92b5bba72df345b86dd5f1884a80654bc8ea06c9d1de101cd376a1bdb083`.
- [`extensions/notification.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L517) defines the snake-case xAI extension tags/fields, including `plan_kept`, `turn_completed`, and append-only `rewind_marker`. Retrieved file SHA-256: `5923a0091d2b9661e98c86e65e439ee29388559ef2591622e119f00c3ef5a56f`.
- The pinned Grok `Cargo.lock` selects `agent-client-protocol` 0.10.4 and `agent-client-protocol-schema` 0.11.4. The [schema crate](https://crates.io/crates/agent-client-protocol-schema/0.11.4) archive checksum matches that lockfile: `ca68e7e55681ce56546c0cecc6bc8f20493d24b44c6d93ec46174f310730bba2`. Its `client.rs`, `content.rs`, `tool_call.rs`, and `plan.rs` define the standard camel-case payload fields, content chunks, optional shared `messageId`, replacement tool updates, and complete plan snapshots.

This establishes the pinned public source contract. It does not establish equivalence to the previously inspected Grok 1.0.70 binary or compatibility with every installed release. No Grok CLI, exporter, plugin, hook, account API, or user transcript was executed/accessed. The original records reader remains stateless. The optional recorded-conversation reducer below adds bounded display grouping/tool replacement/proven rewinds; exact model-context reconstruction and live-agent control remain unsupported. Metadata-only discovery is separately implemented with the existing bounded walker and does not parse file contents or infer live bindings.

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

## Recorded-conversation fixture provenance

`tests/grok_conversation.rs` independently constructs synthetic events from the same pinned contracts; no upstream reducer or replay implementation is copied. The ACP schema `client.rs:332–351` defines shared UUID message IDs; `tool_call.rs:201–236` defines optional field updates and replacement collections.

Additional pinned official writer evidence (retrieved 2026-10-26):

- [`session/acp_session_impl/turn.rs:888–902,959–977`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/turn.rs#L888) stamps the current zero-based `promptIndex` on each prompt block and persists the user echo. SHA-256 `d1c7dc450b72c2ba7f5ee00ea975d586189a9f56b94492fad78063887bf52283`. Lines 327–337 and 896–900 describe persist-only echoes and explicit hidden scrollback metadata.
- [`session/acp_session_impl/rewind.rs:118–120,403–407`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/rewind.rs#L118) defines “rewind to N” as keeping prompts before N and appends a durable marker. SHA-256 `9134f07f7177c8679192e96c46ac0fa83fcff30f0b2637e8478d4b1d0d49fd41`.
- The already-pinned extension contract `notification.rs:1414–1465` distinguishes compacted model-context checkpoint references from display history. Checkpoint paths are never read by this implementation.

Fixtures test replacement/clear/unknown status, hidden and multimodal chunks, repeated/zero rewinds, discarded tool patches, compaction-crossing indexes, incomplete tails, mixed sessions, unknown controls, missing boundaries, duplicate/orphan tools and scan/cardinality/output limits. CLI/component/browser fixtures use owned synthetic files/IPC only; they do not establish installed-release or physical WebView compatibility. Identifier-free chunk grouping is an explicit adjacent-run display policy, not a claim of recovered message identity.

## Work-record provenance

`work.jsonl` and `tests/grok_work.rs` independently construct the sub-agent, background-command and edit records of the
conversation view from the same pinned source (commit `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`, retrieved 2026-11-16);
no Grok CLI, hook, exporter or account was used and no upstream reader is copied. The fields are the snake-case Rust field names
the writer serializes (the enum renames only the variant tags), and every xAI record carries the `_meta` event id the writer stamps.

- [`extensions/notification.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/extensions/notification.rs#L729) (same file and SHA-256 as above): `TaskCompleted` (729), `SubagentSpawned` (739), `SubagentFinished` (818), `TaskBackgrounded` (850) and the last-wins `BackgroundTasks` snapshot (880).
- [`session/storage/jsonl/tests.rs:593`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/storage/jsonl/tests.rs#L593) round-trips `SubagentSpawned` and `SubagentFinished` through `updates.jsonl` and asserts `method` `_x.ai/session/update`, `sessionUpdate` `subagent_spawned` and `subagent_id`. SHA-256 `2c09535753684c5a4d124ff85f49949c2d3ee2b8f37d7f463e4bca1e1dd48ce7`.
- [`tools/notification_bridge.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/tools/notification_bridge.rs#L326) persists `TaskBackgrounded` (326) and `TaskCompleted` (587) with `PersistenceMsg::Update` before it forwards them; [`agent/mvp_agent/mod.rs:1285`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs#L1285) (`find_orphaned_background_tasks`) reads `task_id`, `command` and `cwd` of the first and `task_snapshot.task_id` of the second back from `updates.jsonl`. SHA-256 of `mvp_agent/mod.rs` `06425152d72ffc5a8e857ddc7817fe59d158bf5dc4397194fa45379d0e006c16`.
- [`xai-grok-tools/src/computer/types.rs:207`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-tools/src/computer/types.rs#L207) defines `TaskSnapshot` (`completed`, `exit_code`, `signal`, `explicitly_killed`, `output`, `description`, `kind`) and the `session_restart` signal for a lost task (line 200). SHA-256 `0c6369e3fb29fdc148a97b530034d84e827e039914e66cfe539b81101a83cdc0`.
- [`session/acp_session_impl/tool_calls.rs:2342`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_session_impl/tool_calls.rs#L2342) builds an edit call (title ``Edit `<path>` ``, `ToolKind::Edit`, one `Diff` with `old_text`) and line 2599 a write (``Write `<path>` ``, an empty `old_text`); [`session/acp_conversion.rs:201`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/acp_conversion.rs#L201) builds the completed update's one `Diff` from the applied edit, and a failed edit's content is plain text. SHA-256 of `tool_calls.rs` `f444abf8188d529e535041838e36445f618979261d7e8b48227f362fa5b4d44e`, of `acp_conversion.rs` `7a86d60daece97a2dadb6e5f99973c0764397f7e82f1929c38971ba7c445dc3b`.

`background_tasks` snapshots are written by the same bridge (`request_background_tasks_snapshot`); the fixture uses the clearing
form (`tasks: []`) because the row shape is not needed to read the session. Whether the shipped 1.0.70 binary writes the same
fields remains unverified, as above.

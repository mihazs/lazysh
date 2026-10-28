# Remaining agent transcript formats

Read-only primary-source and shipped-artifact research, 2026-10-24. This records unresolved evidence rather than declaring reference client parity. No target application, installer, agent CLI, actual account transcript, or database was executed/read. Native REA analysis providers were unavailable; their configuration was left unchanged. Selected JavaScript was parsed statically where available, and native strings/disassembly are treated only as bounded structural anchors.

| Agent | Verified source/artifact | Supported outcome and remaining gap |
| --- | --- | --- |
| Amp | [Official threads/export docs](https://ampcode.com/docs/threads), [External API](https://ampcode.com/api/external), official npm distributions | `amp-json` explicitly selected export reader supports the historical pinned schema documented in companion.md. Latest native cache layout remains unverified. The current External API stabilizes message ID/version/timestamp but explicitly leaves other message fields unstable; that schema cannot establish tools/role normalization. No authenticated API request was made. |
| Devin | [Official command reference](https://docs.devin.ai/cli/reference/commands), [official installer](https://cli.devin.ai/install.sh), checksum-matched 3000.11.205 Linux artifact; official reference client companion v0.4.37 (source URL omitted) shipped API/hooks documentation | `devin-atif` reads selected ATIF-v1.7 exports and discovers existing candidates under `$XDG_DATA_HOME/devin/cli/transcripts/<id>.json` (fallback `~/.local/share`). Discovery validates metadata only; schema validation occurs on selection. Native binary contains `message_nodes(session_id,node_id,parent_node_id,chat_message,created_at)` SQL and session `main_chain_id`, but native chat-message serialization/replay semantics remain unverified. `--export` runs alongside the agent after turns, so lazysh does not invoke it. See companion.md for pinned export/discovery evidence and bounds. |
| Grok Build | [Official source snapshot](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8), inspected 2026-10-25; [CLI reference](https://docs.x.ai/build/cli/reference), official stable 1.0.70 Linux artifact | `grok-acp` now reads explicitly selected modern disk envelopes verified against the official writer and source fixtures, using pinned ACP types. Metadata-only discovery now follows the same pinned source store layout without reading contents or inferring a live session. Records remain the default; an explicit bounded recorded-display conversation view now groups chunks, replaces tool snapshots and applies only proven prompt-index rewinds. Compacted model-context replay and live control remain unimplemented; actual installed-release compatibility remains unverified. This does not establish that the source snapshot matches the 1.0.70 binary. No exporter, provider CLI or account API was invoked. See companion.md and the synthetic fixture provenance. |
| Antigravity | [Hooks](https://antigravity.google/docs/hooks), [download page](https://antigravity.google/download), [CLI installer](https://antigravity.google/cli/install.sh), app 2.26.0 and CLI 1.4.7 official Linux artifacts | `antigravity-jsonl` now reads explicitly selected bounded JSONL step records, using pinned CLI 1.4.7 runtime struct descriptors and static writer callsites. Hooks document `.system_generated/logs/transcript.jsonl` under the conversation brain directory, but lazysh performs no discovery. Literal source/type/status, optional step index, thinking and compact truncation flags remain physical records; tool result links, enum completeness, branch reconstruction and real-file/device compatibility remain unverified. See companion.md and the independent fixture provenance. |

The documented Amp CLI export could be offered as an explicit operation in future, but constructing a safe subprocess wrapper requires proving startup does not run workspace plugins/hooks or agent turns. The same limitation applies to a Grok exporter wrapper. Reading an existing, explicitly selected export avoids those unresolved effects. JSON export readers do not claim native-cache discovery or continuous agent control.

Artifact identities retained for reproducibility:

| Artifact | Official origin | SHA-256 |
| --- | --- | --- |
| Amp latest Linux CLI 0.0.1792886472-ge1e052 | `registry.npmjs.org/@ampcode/cli-linux-x64` | Binary `2b391996e9a56470e5a476f0d985aa80da70805bc2bad20092a625ad85125d47`; primary application logic is bytecode-backed. |
| Antigravity app 2.26.0 build 6546645232517120 | `storage.googleapis.com/antigravity-public/antigravity-hub` | Archive `9f79730372f685d849b935187231edea5b38c5269e855e345e68b5c6071f7884`; ASAR `8ce27ff7c2defa10ed1ed2817288a61c546690f4cae1b1a8c91d4e69e0851e4d`. |
| Antigravity CLI 1.4.7 build 5900205422411776 | Official installer manifest at `antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json` | Extracted binary SHA-256 `40349135371a8ed1f1af1e9f8b741de99174ae9fce6380b96c2d1f543480af7a`; publisher SHA-512 matched: `beda760587589f5827b0b516c3ec2c5bd5cd2e91eb0e2533807ba1e990a27dcd63aef0191e0b76fb60feab0d16eaa8210fb79842c34dd4809e257e1712edd152`. |
| Grok Build 1.0.70 Linux x86-64 | `storage.googleapis.com/grok-build-public-artifacts/cli/grok-1.0.70-linux-x86_64`, official installer's fallback host | Binary `22d281c5964c5444147328096ba2a221f3f0874c6858e27c825656a80f6e58e9`; no independent publisher checksum was obtained. |
| Devin CLI 3000.11.205 | `static.devin.ai/cli/3000.11.205` | Archive `2e65c8b93682258fc91f5e4cead92e3698338cebf1b31dbc32a3201cb63705c4`, matching publisher manifest. |

Versioned adapter fixture provenance, limits and native test commands are recorded in [companion.md](companion.md). Real exported file compatibility, authenticated provider behavior, current native-cache formats and live end-to-end runtime parity remain unverified.

Antigravity evidence is stronger than symbol presence: static Go function-table,
ELF relocation/runtime struct/JSON-tag and writer callsite recovery connects step
updates to JSON marshaling and append/replacement operations. The separately
retained REA Go metadata record does not itself establish those writer details.
The exact artifact, struct locations, independently rechecked documentation byte
span and complete bounded field types are recorded with the [synthetic
fixtures](../apps/agent/tests/fixtures/antigravity-jsonl/README.md). No provider CLI,
private transcript, hook or account API was run. This is a versioned record reader,
not a claim of complete Antigravity conversation semantics.

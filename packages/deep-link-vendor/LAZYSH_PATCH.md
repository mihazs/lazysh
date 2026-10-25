# Native-only URL payloads

Based on the crates.io `tauri-plugin-deep-link` **2.6.2** release from
<https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/deep-link>.
Original MIT/Apache-2.0 licenses and notices are retained. This is not Moshi code.
Published source revision: `44293a5722efcaf27060504e63b17aeba721b40f`.
Crates.io archive SHA-256:
`1b3c64e24ebcbc63aaa2d88a9c51e2507084b46620baf39ecb0baa0738a08bb4`.

The upstream plugin broadcasts full URLs through `deep-link://new-url`. lazysh
must retain a link arriving while locked without delivering its data to a stale
renderer. Denying plugin get-current IPC alone does not protect event payloads.
Tauri `EventTarget::App` also is not a native-only channel: JavaScript listeners
can select that target.

Three ingress paths now publish **unit metadata only** after updating bounded
native state: Android's plugin channel, desktop CLI/single-instance delivery,
and macOS/iOS `RunEvent::Opened`. Each native update advances a generation.
Rust `on_open_url` reads native cached URLs at most once per listener/generation;
forged renderer metadata cannot replay that generation. A later genuine OS open
of the identical URL advances the generation and is delivered. Cold retrieval
uses `get_current` separately: each listener starts at the cache's current
generation. A metadata-only reconciliation after registration catches a genuine
native update in the baseline/registration gap. Native callback execution holds
neither the cache mutex nor the listener-generation mutex.
Native listener `EventId`/unlisten behavior remains available. Rapid events
may coalesce to the latest native snapshot; lazysh intentionally has one pending
theme review, not a replay queue. Rust event caches retain at most eight URLs of
16 KiB each. Android cold-start string retrieval and desktop CLI ingress also
bound raw strings before URL parsing; Apple callbacks already contain typed URLs.
JavaScript deep-link IPC permissions are not granted by the app.

An additional `..Default::default()` initializes two newly added `rust-ini`
`ParseOption` fields, both defaulting to false, under the resolved 0.21.3 release.
The original quote/escape behavior is preserved. Unmatched command-line URLs
are no longer included in upstream debug log messages.
Two upstream Kotlin trailing-whitespace lines are trimmed for repository checks.

The application Cargo regression uses the real patched plugin with Tauri's mock
runtime to cover metadata payloads, forged-event replay, same-URL native
reopening, public `get_current`/`on_open_url` and unlisten. Further application
Cargo tests cover strict route parsing, pending receipt replacement and
stale-access read/serialization/ack rejection.

Review this patch on every upstream plugin upgrade. Do not grant its frontend
APIs or restore URL event payloads without preserving lazysh's lock boundary.

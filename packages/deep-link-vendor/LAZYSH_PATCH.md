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
bound raw strings before URL parsing; Android also checks both cold and warm
intent inputs in Kotlin before `toUri()`, `currentUrl` retention or channel
serialization. A quick UTF-16 character bound keeps the subsequent UTF-8 byte
check allocation bounded to at most 48 KiB; accepted input is at most 16 KiB.
Apple callbacks already contain typed URLs.
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

The Android JUnit `DeepLinkInputTest` covers ASCII, multibyte and surrogate-pair
byte boundaries in the shared pre-parse ingress guard. `DeepLinkInput.kt` and
`DeepLinkInputTest.kt` are new lazysh-authored files under GPL-3.0-or-later;
existing upstream files retain their original licenses and notices. The CLI-specific mock
regression is gated to Linux and Windows, where that ingress API is active.

The Android intent-filter renderer is moved from `build.rs` to `src/manifest.rs`
with its upstream copyright and license notices intact. It omits empty optional
lines before Tauri indents the generated block, preventing trailing-whitespace
source changes when the canonical application manifest already contains the
paired `DEEP LINK PLUGIN` block. Nonempty XML, including the ChromeOS action and
all associated-domain attributes, is preserved. The updater and URL validation
are unchanged.

The application's standard Cargo `deep_link_manifest` integration target includes
the actual renderer and configuration source, exercising custom-scheme and
fully populated domain output without new dependencies. The inclusion wrapper
`tests/manifest.rs` is lazysh-authored under GPL-3.0-or-later; upstream source
retains its original notices. Android app JUnit separately parses canonical XML,
whose file is registered as a native Gradle test input to invalidate cached
results when routing declarations change.

The existing optional-host deserializer uses equivalent nested `if let` blocks
instead of a Rust 2024 let-chain so the same source compiles in the application's
Rust 2021 integration target. No package edition changes. Positive, omitted/null
and rejected scheme-prefixed host cases check the original behavior and error
wording; no host or route validation is relaxed.

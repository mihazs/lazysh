# Headless extraction patches

The original source layout is retained where possible so parser, credential,
locking, private-cache and refresh behavior remain traceable to upstream.

- `Cargo.toml`: rename the library to `ai-usagebar-core`; remove all binaries,
  the upstream build script, tray/WebView/ratatui/MCP/notification dependencies,
  and platform GUI bindings. Retain provider/storage/HTTP/crypto dependencies.
- `src/lib.rs`: expose only configuration data, provider identities, read-only
  availability, and opaque quota target/refresh/projection primitives. Provider
  modules stay private. Dead-code/import allowances preserve unmodified
  upstream reexports without opening login or configuration mutation APIs.
- `src/tui/app.rs`: extract only target identity, account routing, refresh
  dispatch and freshness. Remove UI state, event/render code and notification
  execution. Existing per-provider credential/cache locking remains intact.
- `src/tui/panels.rs`: retain pure quota section projection; remove ratatui
  imports and rendering. The directory name reflects provenance, not a TUI
  dependency or frontend.
- `src/report.rs`: retain schema-one quota projection and JSON rendering;
  remove transcript/context/activity scanning, history/ranking and CLI output.
  Expose bounded target enumeration and individual target refresh so the
  first-party service can own deadline/concurrency/cancellation policy.
- `src/detect.rs`: retain only `has_local_credentials` and its local read-only
  helpers. Remove persisted detection state, configuration edits and command
  entrypoints.
- `src/config.rs`: make the original mutating convenience loader crate-private;
  expose only data validation, path expansion, and secret-variable registration
  inputs required by the first-party bounded read-only loader. The first-party
  service never calls the original loader or its chmod helper. Expose the pure
  inline-secret predicate on every platform for reporting-profile admission;
  filesystem ownership and permission mutation remain Unix-only.
- `src/anthropic/cli_account.rs`: retain only read-only CLI identity helpers
  needed for named-account routing; remove credential switching/adoption.
- `src/claude_desktop/mod.rs`: retain only paths and read-only profile/account
  metadata. Remove capture, account switching and history merge modules.
- `src/widget/cli.rs`: retain provider formatter metadata types, substitute
  literals for three unused ranking defaults so the ranking module is omitted.
  No parser/executable entrypoint is exposed by this crate.
- Original `src/antigravity/fetch.rs` and its three include-only macOS launcher
  source fixtures are retained byte-for-byte, allowing its trusted-system-tool
  structural guard to compile. The launcher files are never compiled or
  exported by this crate. `config.example.toml` is an unchanged parser fixture.
- Adapted quota projections and configuration helpers share repeated fixture
  builders and scalar-validation code. Tests retain their original assertions.
- The extracted custom-provider dispatch attaches the API-key redactor to its
  cache, matching the built-in key providers and preventing echoed keys from
  being persisted as diagnostics.

No provider endpoint or authentication protocol is replaced by a mock in
production. Platform limitations of upstream credential stores remain; an
unavailable credential source yields an error rather than an invented quota.

- `src/cline/creds.rs`: adapt default store selection to Cline CLI 3.0.74,
  source `071e1b25b48f9ef5dff7fc32085e6a16f02bf02e`,
  `sdk/packages/shared/src/storage/paths.ts`: provider-settings file override,
  data-directory override, then profile-directory override and the normal home
  default. Preserve ECMAScript trimming, configured auth paths and API-key
  precedence; selected stores never fall through to a different default login.
  Paths are bounded and invalid encodings/NUL fail without exposing the input.
  Restrict shared-store credentials to `cline`/legacy `cline-pass` entries before
  extracting tokens; reject an explicit settings.provider from another family.
  Cline 3.0.74's `sdk/packages/core/src/auth/provider-auth-registry.ts` stores
  `openai-codex` and `oca` credentials separately and maps `cline-pass` to `cline`.
  Preserve older Cline-family records without settings.provider. Unrelated tokens
  cannot outrank Cline credentials or select another account's quota cache.
  Factor its two identical existing test-store constructors for zero duplication.
  This file is adapted and scanned normally, not an unchanged-source exclusion.

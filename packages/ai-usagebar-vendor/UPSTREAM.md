# Upstream provenance

Source: https://github.com/akitaonrails/ai-usagebar
Revision: `7b0da9a774358283328850620509404e29262431` (1.46.0).
License: MIT; the complete upstream license is retained in `LICENSE`.

This is a source extraction of the provider authentication, response parsers,
cache/refresh guards, and quota projection. It does not embed or execute an
upstream binary. The crate has no executable targets or build script.

`UPSTREAM_FILES.json` records SHA-256 hashes of files that are byte-for-byte
unchanged at the pinned revision. Files omitted from that list are adaptations
or local metadata and must not be treated as unchanged third-party source.
See `PATCHES.md` for the compiled surface and extraction changes.

The first-party account-usage service, deadline/concurrency policy, CLI adapter,
output normalization and UI live outside this directory.

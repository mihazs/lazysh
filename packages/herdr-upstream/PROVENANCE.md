# Optional Herdr source baseline

This began as an unmodified source/build prerequisite for [#269](https://github.com/mihazs/lazysh/issues/269), under [#268](https://github.com/mihazs/lazysh/issues/268). The optional local derivative now advertises the guarded protocol only when explicitly requested; lazysh Chat integration is not yet enabled. It does not install Herdr or alter an existing server. Stock Herdr and lazysh's Stage/terminal fallback remain unchanged.

## Source identity

- Official upstream: <https://github.com/herdrdev/herdr>.
- Version: **0.9.3**. Unsigned annotated tag object: `7eaf574ba6362c36c3d8fe89f411bb7d5bb34660`.
- Peeled source commit: `7b116c05bfda646af39d2524c54e70c751f57ee8`; tree: `17ff0e2ba59b2d8a99c0ca9c898af901d23d8928`.
- [Commit-addressed archive](https://codeload.github.com/herdrdev/herdr/tar.gz/7b116c05bfda646af39d2524c54e70c751f57ee8) SHA-256: `a8d914d60ae728deec9902ec29d706d305ba51c731424d6ffbf2a8af0b170124`.
- The archive digest identifies observed download bytes; it is not signed publisher provenance. The GitHub tag API reports the tag unsigned.

The complete commit tree has no Git submodules. The original selected import contains 1,828 upstream files (31,545,868 bytes), all originally byte-identical to the archive. `SOURCE-MANIFEST.sha256` records each selected file; its fixed SHA-256 is `1aedd80ed6f09c8421df38bcdac64ec07a089e8f54350f4b198f221d282231a9`, anchored in the native project test. `PROVENANCE.md` and the manifest are lazysh packaging additions, not upstream source. Upstream `README.md`, licenses, Cargo metadata and source comments retain their original attribution.

The import keeps the Rust source, native Cargo tests/fixtures, Ghostty binding and vendor sources, plus assets required by compile-time includes: sounds, API schema, skill text, Windows installer and update fixture. It omits upstream automation/instructions, all `scripts/` directories, Git attributes/ignore files and symlinks. None of that automation is needed by the documented native Cargo entrypoint. The optional guarded-input changes tracked in [#283](https://github.com/mihazs/lazysh/issues/283) are explicit local modifications. Modified paths lose their unchanged-vendor scan exemptions; the original manifest stays fixed and continues to identify upstream bytes. No Zig source has been edited.

## Local changes in preparation

`src/main.rs` and `src/client/shell.rs` load the scanned owned modules from `../herdr-guard`. `Cargo.toml` adds exact portable `getrandom = "=0.3.4"`; `Cargo.lock` references its pre-existing package entry. The modified Linux source has passed focused core/API, runtime identity and owned real-server/client acceptance. Those tests do not establish native lazysh SSH/access-lease integration or provider identity. Modified source files carry a change notice. See the owned [contract](../herdr-guard/README.md) for the explicit startup claim and connection-lifetime ownership join and two-stage cutoff.

The baseline build commands below describe the unmodified import only. A modified build must copy the `herdr-upstream` and `herdr-guard` sibling directories plus the exact current `common/src/hex_digest.rs` and `common/src/guarded_target.rs` sources outside the repository, preserving their relative paths. The pure validators remain re-exported by lazysh-common and are included directly by the guard, without another implementation or Cargo dependency. The shared hex validator retains the repository GPL-3.0-or-later notice, and the target validator retains the owned protocol’s Apache-2.0 notice; original Herdr Apache-2.0 and bundled notices remain intact, and the combined derivative must not be represented as Apache-only. A full original-manifest checksum is expected to report the documented local modifications; do not update the original manifest to bless them. The native provenance test still enforces original bytes on every effectively excluded path.

## Optional build and verification

This nested workspace is explicitly excluded from lazysh's root Cargo workspace and has no Bun package. Default lazysh builds/tests do not build or install it. Use a private target; never point it at another active worktree's mutable target.

Verify the import, then build a private source copy **outside the repository/worktree**. Zig 0.16.0 creates `zig-pkg/` beside `build.zig` for fetched dependencies, even when its cache environment variables point elsewhere. Some dependencies include `scripts/` directories; they must not enter this imported project tree. No source-provenance exception is made for that cache.

```sh
cd packages/herdr-upstream
sha256sum --check SOURCE-MANIFEST.sha256
herdr_build_root="$(mktemp -d "${TMPDIR:-/tmp}/lazysh-herdr-build.XXXXXX")"
cp -a . "$herdr_build_root/source"
cd "$herdr_build_root/source"
sha256sum --check SOURCE-MANIFEST.sha256
export CARGO_TARGET_DIR="$herdr_build_root/target"
export ZIG_LOCAL_CACHE_DIR="$CARGO_TARGET_DIR/zig-local"
export ZIG_GLOBAL_CACHE_DIR="$CARGO_TARGET_DIR/zig-global"
export ZIG=/absolute/path/to/zig-0.16.0
cargo build --locked
cargo test --locked --bin herdr client::handshake::
cargo test --locked --bin herdr server::clients::
cargo test --locked --bin herdr protocol::endpoint::
cargo test --locked --bin herdr server::client_transport::
```

Running Cargo from the copied workspace preserves Rust's toolchain selection and upstream `.cargo/config.toml`. The original `rust-toolchain.toml` pins **Rust 1.96.1** with Clippy/rustfmt; `clippy.toml` preserves upstream's argument-count lint configuration. The Ghostty binding requires **Zig 0.16.0**, invokes `zig build -Demit-lib-vt`, and retains upstream target/SIMD/optimization settings. Provisioning tools is a separate explicit operation; these commands may otherwise cause rustup or dependency fetching. They do not install the resulting Herdr binary or start a server. Real attachment acceptance must use only isolated owned PTYs, private config/runtime directories and temporary servers.

This is not an offline dependency closure or a promise of bit-identical binaries. Cargo registry packages remain governed by `Cargo.lock`. Ghostty's Zig manifests also name hash-addressed external dependencies, including required `uucode` and build/platform-selected packages. Their availability and toolchain compatibility require actual build evidence. Never silently substitute tool versions, remove dependency hashes or disable terminal features to obtain a pass.

The optional `herdr-native` CI job downloads exactly the observed uucode, Highway and wuffs' pixels archives once each with finite transfer bounds, checks gzip integrity, and uses this same Zig to admit each local archive against its unchanged package hash before building. Native YAML anchors share only the two command bodies; the three URL/hash records remain explicit. Real matching-hash, wrong-hash and truncated-archive controls execute the exact decoded admission body for each archive through the existing Bun tests. Transfer and local admission are separate observations: this does not establish the cause of earlier hosted `ReadFailed` or `HttpConnectionClosing` failures, close the other dependency downloads, or add automatic retries. All generated packages remain in the external source copy; no user host is modified.

### Executed Linux baseline

The external source copy at `/home/mihazs/.cache/lazysh-herdr-toolchains/source-7b116c05` passed all 1,828 manifest checks before `cargo build --locked`. The build used private Rust 1.96.1/Cargo 1.96.1 and Zig 0.16.0, with the isolated target `/home/mihazs/.cache/lazysh-herdr-toolchains/target-7b116c05`. Its dependency file names that external source path. The resulting debug binary reports `herdr 0.9.3`, SHA-256 `d25acea6d9fa9796d3d451b07fd1009b8e7f73ff086879cac8f7a8691235ceb7`. Selected native endpoint tests passed **10** cases; local socket/client transport passed **29**. These are baseline native tests, not a full suite or guarded Chat acceptance.

An earlier build directly in the import worktree also passed, followed by 42 selected cases, all-target Clippy with `-D warnings` and upstream formatting. That first build generated source-local Zig packages and made the root provenance test fail (18 other CI fixture cases passed). The owned generated package cache was moved outside the project; the test was not weakened. The external-copy build above validates the corrected build entrypoint. No user Herdr installation, existing server or provider account was used.

Official tool archives were checked before private provisioning. Zig 0.16.0 Linux x86-64 archive SHA-256: `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`, from the official download index. Rust's 1.96.1 channel manifest matched its official SHA-256, and all five selected component archives matched that manifest before rustup consumed them. No global default toolchain was changed. These observations do not establish Windows/macOS, physical-device, provider, release-optimized or byte-reproducible binary acceptance.

## Licenses and vendor patches

Herdr's original [Apache-2.0 license](LICENSE) remains intact. The bundled Ghostty source is MIT (`vendor/libghostty-vt/LICENSE`), based on commit `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`; its original vendor manifest and patch notes remain in `vendor/`. The bundled `portable-pty` 0.9.0 is MIT (`vendor/portable-pty/LICENSE.md`), with upstream Herdr's documented ConPTY-loading, raw-command-tail and Windows-environment patches. All nested notices are retained. Downloaded build dependencies retain their own licenses; this import is not a completed binary redistribution audit.

Future modifications must carry prominent change notices and patch provenance. Do not imply this derivative is an official Herdr release or that upstream accepted a lazysh capability.

## Duplicate-scan boundary

`.jscpd.json` excludes only the pinned, unchanged upstream copy by explicit paths/subtrees. The first scan intentionally included nine anticipated integration files and found 46 existing upstream clones. Those files are still byte-identical third-party source in this baseline, so they are now explicitly included in vendor scope. This is not permission to exclude future modifications.

`tests/herdr-source.test.ts`, included in the existing root `test:ci` command, checks unchanged excluded files against `SOURCE-MANIFEST.sha256` and rejects excluded files absent from that manifest. The only modified generated exception is `docs/next/api/herdr-api.schema.json`, produced by the unchanged `src/api/schema/tests.rs` generator. The normal `herdr-native` CI job compiles the actual optional crate and executes `api::schema::tests::generated_protocol_schema_artifact_is_current` with update mode disabled; a digest-only receipt does not replace that check. It considers all root scan patterns, including generic generated-path patterns such as `**/dist/**`, not just vendor-prefixed entries. Changing an excluded integration file therefore fails the native project check. Remove every matching exclusion before modifying it, then refactor its detected duplicates under the unchanged zero-clone rule. Keep the manifest as the original source receipt; do not rewrite it to bless modified excluded code.

Substantial owned guard modules and tests belong outside those exclusions, for example `packages/herdr-guard/`, and can be loaded into real upstream crate scopes with narrow Rust module wiring. Compare the actual diff against the pinned archive and manifest; do not rely on vendor folder placement or assumed glob negation. All detected clones in owned or modified files must be addressed without a baseline, threshold change or authored-source exclusion. The manifest itself, this provenance file and the validation test are not excluded. The external build copy keeps Zig's generated package directories out of the project source receipt.

## Guarded derivative verification entrypoint

After the source/exclusion test, copy both Herdr siblings and the one shared validator into an owned external build root and compare each against the checkout before Cargo. Set the private Rust/Zig tools and target as above. The normal `herdr-native` job follows this path and adds the original handshake/client/endpoint/transport filters; it is a required verification job for this optional component, not part of default application builds.

```sh
cargo +1.96.1 build --locked
cargo +1.96.1 build --locked --example guarded_ssh_fixture
cargo +1.96.1 test --locked --bin herdr guarded_input::
cargo +1.96.1 test --locked --bin herdr terminal::runtime_registry::guard_identity_tests::
HERDR_GUARD_SSH_FIXTURE="$CARGO_TARGET_DIR/debug/examples/guarded_ssh_fixture" cargo +1.96.1 test --locked --test guarded_input acceptance:: -- --nocapture
cargo +1.96.1 test --locked --bin herdr api::schema::tests::generated_protocol_schema_artifact_is_current -- --exact
```

The example is a native Cargo process fixture that only writes its owned invocation marker and exits. It never implements SSH or opens a network. Its current-source build must precede the explicit path passed to acceptance; an arbitrary existing absolute binary is not provenance. Real-server cases use only private temporary sockets/config, two owned servers, an owned shell workload, and tracked child cleanup. They do not establish lazysh's future SSH/access-lease adapter, provider identity, GUI/physical-device or Windows guarded acceptance. Unsupported socket receive deadlines fail closed for guarded attachment while ordinary attachment retains upstream behavior.

## Stock Android navigation CI artifact

The `herdr-native` job also builds the original commit-addressed archive above in
a fresh external `stock-source` directory after copying and sealing the guarded
executable. It verifies all 1,828 original manifest records before and after the
stock build. Stock compilation and artifact retention use a separate `stock-target`
Cargo directory. Only the Cargo registry/toolchain and generated, hash-admitted Zig
dependency packages are reused; compiled crates, fingerprints and guarded outputs
are not copied. Additional compile cost is unmeasured; the existing Rust/Zig and
30-minute producer limit remain unchanged.

The short-lived `stock-herdr-<run>-<attempt>` artifact includes the original license,
stock executable and a receipt binding source commit, archive/manifest digests,
original-file count, workflow checkout and executable SHA-256. Its consumer checks
that receipt and the same-run producer output before invoking the dedicated stock
Android navigation task. This is a distinct artifact from guarded Herdr; neither
is substituted for the other. The hosted stock build and Android result must be
observed on the new workflow before claiming execution; local baseline binary
`d25acea6…` is a functional reference, not an expected reproducible CI digest.

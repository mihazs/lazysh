# Optional Herdr source baseline

This began as an unmodified source/build prerequisite for [#269](https://github.com/mihazs/lazysh/issues/269), under [#268](https://github.com/mihazs/lazysh/issues/268). The optional local derivative now advertises the guarded protocol only when explicitly requested; lazysh Chat integration is not yet enabled. It does not install Herdr or alter an existing server. Stock Herdr and lazysh's Stage/terminal fallback remain unchanged.

## Source identity

- Official upstream: <https://github.com/herdrdev/herdr>.
- Version: **0.9.5** (`v0.9.5`). Unsigned annotated tag object: `7573e821895d32c8d1f78b3f6c9a2f85a46df4ac`.
- Peeled source commit: `2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01`; tree: `8aa25836bb7c8d14ffa866a852dbc724098ca088`.
- [Commit-addressed archive](https://codeload.github.com/herdrdev/herdr/tar.gz/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01) SHA-256: `cbd4354f1c44530d9f094c2797380208c50f19b4d6350b6e5206e220133c3168`.
- Previous baseline: 0.9.3, commit `7b116c05bfda646af39d2524c54e70c751f57ee8`, archive SHA-256 `a8d914d60ae728deec9902ec29d706d305ba51c731424d6ffbf2a8af0b170124` (re-downloaded and matched before the 0.9.5 re-import, [#1117](https://github.com/mihazs/lazysh/issues/1117)).
- The archive digest identifies observed download bytes; it is not signed publisher provenance. The GitHub tag API reports the tag unsigned.

The complete commit tree has no Git submodules. The selected import contains 1,843 upstream files (32,178,896 bytes), all originally byte-identical to the archive. `SOURCE-MANIFEST.sha256` records each selected file, sorted by byte order; its fixed SHA-256 is `c303652ea2d310b78fdc9222cb30b405915890c0522239c9daf734591cb08e8a`, anchored in the native project test and the `herdr-native` stock receipt. `PROVENANCE.md` and the manifest are lazysh packaging additions, not upstream source. Upstream `README.md`, licenses, Cargo metadata and source comments retain their original attribution.

The import keeps the Rust source, native Cargo tests/fixtures, Ghostty binding and vendor sources, plus assets required by compile-time includes: sounds, API schema, skill text, Windows installer and update fixture. It omits upstream automation/instructions, all `scripts/` directories, Git attributes/ignore files and symlinks. None of that automation is needed by the documented native Cargo entrypoint.

The 0.9.5 selection applies the same rule to the new tree: every 0.9.3 manifest path that still exists (upstream removed `src/input/encode.rs`), plus the 16 new upstream files under the already selected `src/`, `crates/`, `tests/` and `vendor/patches/` trees. Documentation, including the new `docs/versions/0.9.2` and `0.9.3` snapshots, stays omitted except the generated API schema. The compile-time `include_str!`/`include_bytes!` set is unchanged, and Ghostty's vendored source and Zig package hashes are identical to 0.9.3. The optional guarded-input changes tracked in [#283](https://github.com/mihazs/lazysh/issues/283) are explicit local modifications. Modified paths lose their unchanged-vendor scan exemptions; the original manifest stays fixed and continues to identify upstream bytes. No Zig source has been edited.

## Local changes in preparation

`src/main.rs` and `src/client/shell.rs` load the scanned owned modules from `../herdr-guard`. `Cargo.toml` adds exact portable `getrandom = "=0.3.4"`; `Cargo.lock` references its pre-existing package entry. The same 21 upstream paths as in 0.9.3 carry local changes, and the managed namespace below adds `src/config/io.rs`; the 0.9.5 re-import three-way merged them from the 0.9.3 base and kept every change notice. Upstream 0.9.4 sets up the host terminal before the handshake so it can ask about SGR pixel mouse support. A guarded client's output must start with its private ticket frame, so `src/client/mod.rs` still sets up the terminal after the guarded handshake and tells the server the host has no pixel mouse (cell coordinates). Ordinary clients keep the upstream order. The test constructor in `src/server/headless.rs` now takes upstream's `ServerStop`. New upstream test duplicates in modified files share small test helpers rather than being excluded. The modified Linux source has passed focused core/API, runtime identity and owned real-server/client acceptance. Those tests do not establish native lazysh SSH/access-lease integration or provider identity. Modified source files carry a change notice. See the owned [contract](../herdr-guard/README.md) for the explicit startup claim and connection-lifetime ownership join and two-stage cutoff.

The baseline build commands below describe the unmodified import only. A modified build must copy the `herdr-upstream` and `herdr-guard` sibling directories plus the exact current `common/src/hex_digest.rs` and `common/src/guarded_target.rs` sources outside the repository, preserving their relative paths. The pure validators remain re-exported by lazysh-common and are included directly by the guard, without another implementation or Cargo dependency. The shared hex validator retains the repository GPL-3.0-or-later notice, and the target validator retains the owned protocol’s Apache-2.0 notice; original Herdr Apache-2.0 and bundled notices remain intact, and the combined derivative must not be represented as Apache-only. A full original-manifest checksum is expected to report the documented local modifications; do not update the original manifest to bless them. The native provenance test still enforces original bytes on every effectively excluded path.

### Android targets for libghostty-vt

`crates/ghostty-vt/build.rs` is a 22nd locally modified upstream file, tracked in [#2098](https://github.com/mihazs/lazysh/issues/2098) as part of [#1312](https://github.com/mihazs/lazysh/issues/1312). Upstream maps the Zig target for Linux, macOS, iOS and Windows triples and panics on any other, so a Rust build for Android never reached Zig. The change adds `aarch64-linux-android` and `x86_64-linux-android`, mapped to the Zig targets of the same name, and makes Cargo rerun the script when `ANDROID_NDK_HOME`, `ANDROID_HOME` or `ANDROID_SDK_ROOT` changes. Everything else is upstream's: the vendored `libghostty-vt` build already selects the Android NDK (`pkg/android-ndk`, 16 KiB page size) and no Zig source, patch, dependency pin or archive hash changed. Zig's own default Android API level applies to the library (the `-Dtarget` triple carries none), and the CI link step uses the NDK's API 24 sysroot, the app's `minSdkVersion`.

The file left the unchanged-source exclusion of `.jscpd.json`, which now lists the other binding files one by one, so `tests/herdr-source.test.ts` keeps proving that every excluded path is byte-identical to the manifest and the modified file is scanned for duplicates. `SOURCE-MANIFEST.sha256` still records the upstream bytes of `build.rs` and was not edited; the integrity checks around source acquisition (#384) are untouched. The `herdr-native` job runs the Android build with the Zig, archives and caches it already admits: `cargo check` and `cargo test --no-run` of `lazysh-terminal-runtime` for both ABIs against the pinned NDK (r29.0.14206865), which links every test executable. It links; nothing executes on Android there. arm64 is the release ABI and x86_64 is what Waydroid and the CI emulator run.

### Managed application namespace

The opt-in Cargo feature `lazysh-managed` ([#1754](https://github.com/mihazs/lazysh/issues/1754), under [#1522](https://github.com/mihazs/lazysh/issues/1522)) makes `config::io::app_dir_name` return the fixed name `lazysh-herdr` in every profile, instead of upstream's `herdr-dev` (debug) and `herdr` (release). Configuration, state, the default and per-session API and client sockets, logs, plugins and the saved session all derive from that name, so a managed server on the same host shares none of them with a stock Herdr. Namespace isolation does not override `HOME`, `XDG_CONFIG_HOME` or `XDG_STATE_HOME`: pane children inherit those variables and keep their provider and hook profiles.

Default builds, including the debug CI artifact, keep upstream's names on purpose. At least fourteen upstream test and fixture files hardcode them, and the original manifest must keep identifying upstream bytes. The feature is therefore enabled only for the managed build and its acceptance. `src/config/io.rs` is the one new modified path; it carries a change notice, leaves the unchanged-vendor scan exemption (the other `src/config/` files keep theirs) and was refactored for the zero-clone rule without behavior change: the two non-Windows directory functions and the Windows variants share one helper each, and two upstream tests share one config-loading helper. The Windows branch was type-checked in isolation only; no Windows build has run.

The `herdr-native` job ends with `cargo +1.96.1 test --locked --features lazysh-managed --test guarded_input acceptance::`. It runs the owned real-server acceptance with the feature on, plus one case that starts a real server and client under private `HOME` and XDG roots and asserts that `config/` holds exactly `lazysh-herdr`, that the session socket is inside it, and that no entry named `herdr`, `herdr-dev` or `.herdr*` exists anywhere below any root. That step runs after the guarded and stock artifacts are retained because the feature rebuilds `target/debug/herdr`; the retained debug artifact is not a managed build.

This establishes the namespace for a Linux debug build only. It does not make the managed build self-contained: `herdr update`, `herdr channel set` and the background update check can still replace the executable with a stock release ([#1755](https://github.com/mihazs/lazysh/issues/1755)). A release-profile build, its libc floor and receipt ([#1756](https://github.com/mihazs/lazysh/issues/1756)), publication ([#1758](https://github.com/mihazs/lazysh/issues/1758)) and other operating systems remain open. The notice inventory of the Linux x86-64 managed build is generated and checked by CI ([#1757](https://github.com/mihazs/lazysh/issues/1757), see [Redistribution notices and audit result](#redistribution-notices-and-audit-result)). Nothing here installs or distributes a binary.

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

The optional `herdr-native` CI job downloads exactly the observed uucode, Highway and wuffs' pixels archives once each with finite transfer bounds, checks gzip integrity, and uses this same Zig to admit each local archive against its unchanged package hash before building. Native YAML anchors share only the two command bodies; the three URL/hash records remain explicit. Real matching-hash, wrong-hash and truncated-archive controls execute the exact decoded admission body for each archive through the existing Bun tests. Transfer and local admission are separate observations: this does not establish the cause of earlier hosted `ReadFailed` or `HttpConnectionClosing` failures or establish that a download will not fail again. All generated packages remain in the external source copy; no user host is modified.

The other Ghostty dependencies (wuffs, zlib, translate-c, aro, the bundled themes) are still fetched by Zig itself, and each of those transfers has failed on a hosted runner with `ConnectionResetByPeer`, `HttpConnectionClosing` or `ReadFailed` ([#384](https://github.com/mihazs/lazysh/issues/384)). The job therefore restores Zig's compressed package tarballs (`zig-global/p`, about 7 MB) with `actions/cache`, keyed on the Zig version and every `build.zig.zon` under `vendor/libghostty-vt`, and `.github/scripts/retry-zig-fetch.sh` reruns the two Cargo builds up to three times when their output shows Zig failing to download or unpack a dependency. Both are bounded and weaken nothing: Zig compares every package with its pinned hash each time it unpacks a tarball, so a changed cache entry fails the build with a hash mismatch; a compile error or hash mismatch is never retried; no compiled object is cached; and a cached tarball that gzip cannot read is deleted before the build, because Zig 0.16.0 would otherwise fail or stall on it instead of downloading it again. Executed on 2026-11-13 with Zig 0.16.0: a cold `zig build -Demit-lib-vt` populated eight tarballs, and with only that `p` directory restored and the network namespace removed the same build unpacked all eight and succeeded; a tarball with one changed hashed file was rejected with a hash mismatch. The Bun tests execute the retry helper, the scrub step and a small hash-pinned package against real Zig. Whether a hosted run now avoids the original failures is only observable on `herdr-native` itself.

### Executed Linux baseline

The 0.9.5 guarded copy at `/home/mihazs/.cache/lazysh-herdr-toolchains/source-guarded-1117` used the same private Rust 1.96.1 and Zig 0.16.0 with the isolated target `target-guarded-1117`. It passed `cargo build --locked`, upstream `cargo fmt --check`, all-target Clippy with `-D warnings`, the `herdr-native` filters (`guarded_input::` 24, guard identity 3, owned acceptance 4 with 1 ignored, handshake 1, clients 2, endpoint 10, transport 29, schema currentness 1) and the `app::api`, `server::`, `client::`, `protocol::`, `api::` and `cli::` module filters. Upstream's own suite runs under nextest. A single-process `cargo test --bin herdr` aborts with SIGPIPE from unchanged clipboard tests, and two plugin tests race when run in parallel there; each passes alone. The resulting debug binary reports `herdr 0.9.5`. A stock build of the unchanged archive in `stock-source-095` passed all 1,843 manifest checks after the build and reports `herdr 0.9.5`.

The 0.9.3 baseline record follows. The external source copy at `/home/mihazs/.cache/lazysh-herdr-toolchains/source-7b116c05` passed all 1,828 manifest checks before `cargo build --locked`. The build used private Rust 1.96.1/Cargo 1.96.1 and Zig 0.16.0, with the isolated target `/home/mihazs/.cache/lazysh-herdr-toolchains/target-7b116c05`. Its dependency file names that external source path. The resulting debug binary reports `herdr 0.9.3`, SHA-256 `d25acea6d9fa9796d3d451b07fd1009b8e7f73ff086879cac8f7a8691235ceb7`. Selected native endpoint tests passed **10** cases; local socket/client transport passed **29**. These are baseline native tests, not a full suite or guarded Chat acceptance.

An earlier build directly in the import worktree also passed, followed by 42 selected cases, all-target Clippy with `-D warnings` and upstream formatting. That first build generated source-local Zig packages and made the root provenance test fail (18 other CI fixture cases passed). The owned generated package cache was moved outside the project; the test was not weakened. The external-copy build above validates the corrected build entrypoint. No user Herdr installation, existing server or provider account was used.

Official tool archives were checked before private provisioning. Zig 0.16.0 Linux x86-64 archive SHA-256: `70e49664a74374b48b51e6f3fdfbf437f6395d42509050588bd49abe52ba3d00`, from the official download index. Rust's 1.96.1 channel manifest matched its official SHA-256, and all five selected component archives matched that manifest before rustup consumed them. No global default toolchain was changed. These observations do not establish Windows/macOS, physical-device, provider, release-optimized or byte-reproducible binary acceptance.

## Licenses and vendor patches

Herdr's original [Apache-2.0 license](LICENSE) remains intact. The bundled Ghostty source is MIT (`vendor/libghostty-vt/LICENSE`), based on commit `44f2a44df7e8c4a0c6df3f7d872ef3d7ead88e51`; its original vendor manifest and patch notes remain in `vendor/`. The bundled `portable-pty` 0.9.0 is MIT (`vendor/portable-pty/LICENSE.md`), with upstream Herdr's documented ConPTY-loading, raw-command-tail and Windows-environment patches. All nested notices are retained. Downloaded build dependencies retain their own licenses; [Redistribution notices and audit result](#redistribution-notices-and-audit-result) below records the audit of the Linux x86-64 managed build and what it does not cover.

Future modifications must carry prominent change notices and patch provenance. Do not imply this derivative is an official Herdr release or that upstream accepted a lazysh capability.

## Redistribution notices and audit result

[#1757](https://github.com/mihazs/lazysh/issues/1757), under [#1522](https://github.com/mihazs/lazysh/issues/1522). After it builds the derivative, the `herdr-native` job runs `.github/scripts/herdr-notices.ts` and retains its two outputs as the `herdr-notices-<run>-<attempt>` artifact (14 days): `notices.json`, the inventory, and `NOTICES.txt`, the text bundle meant to travel with an executable. For the same inputs they are the same bytes (no timestamps or host paths), and they are bound to the lazysh checkout, the SHA-256 of `Cargo.lock` and the SHA-256 of the original `SOURCE-MANIFEST.sha256`.

**What the inventory is for.** The executable the managed build ships: Linux x86-64 (`x86_64-unknown-linux-gnu`) with the `lazysh-managed` feature. The job takes its Cargo packages from `cargo metadata --locked --filter-platform x86_64-unknown-linux-gnu --features lazysh-managed` (so `Cargo.lock` and the platform filter decide, never a hand-kept list) and its Zig packages from the `zig-pkg` directory that build populated. Windows, macOS and other architectures resolve other packages and need their own inventory.

| Section | Contents |
| --- | --- |
| `cargo` | every resolved package, split into `linked` (reachable through normal dependencies) and `build` (build scripts only): version, crates.io download URL, `Cargo.lock` checksum, SPDX expression, repository and the license and notice files its package ships |
| `zig` | every package the Ghostty build fetched: name, URL, archive hash, license and shipped license files, and whether the `libghostty-vt` archive links it |
| `ghostty`, `embedded` | the pinned Ghostty commit and its MIT license, and linked third-party code inside the vendored tree that ships no license file (simdutf) |
| `modified` | every upstream file whose bytes differ from the original manifest, with both digests and where its change notice is |
| `owned` | every lazysh Rust file compiled into the executable (`packages/herdr-guard` and the two shared validators in `packages/common/src`) with its SPDX license |

`NOTICES.txt` opens with the source identity, the corresponding-source URLs of the lazysh parts at the checkout, the original manifest digest, the modified files and the lazysh files, and states that the derivative is not an official Herdr release and not Apache-only. Every distinct license text follows once, with the components that rely on it.

**What fails the job** (each problem is reported, nothing is written): a package or Zig package with no recorded license; a license identifier that is not in the reviewed set; a package that ships no license text when none is recorded; a registry package without a `Cargo.lock` checksum or a source other than crates.io; a Zig package fetched but not recorded, or recorded but no longer fetched; a linked Zig package without a text; a recorded text whose bytes changed; a modified upstream file without a `Modified by lazysh` notice (outside the two generated files named in `.github/herdr-notices/reviewed.json`); a lazysh Rust file without an `SPDX-License-Identifier` in the reviewed set; and a Herdr version that differs from the reviewed one. `tests/herdr-notices.test.ts` runs the script against controlled trees for each of these.

**Reviewing a failure.** `.github/herdr-notices/reviewed.json` is the reviewed record: the allowed SPDX identifiers, each Zig package by its content hash with its license, whether it is linked and its license files, and the texts supplied by lazysh (`.github/herdr-notices/*.txt`) with the exact upstream URL and SHA-256 each came from. Read the license a new dependency actually imposes before adding an identifier; the check is deliberately stricter than "some alternative of an `OR` is fine", so an unreviewed alternative also needs a decision. Regenerate nothing by hand: the job output is the inventory.

### Audit result

Herdr 0.9.5 as imported here, Linux x86-64, `lazysh-managed`; the numbers are what the generator printed for this checkout.

- **Cargo.** 241 packages: 234 linked and 7 build-only (`autocfg`, `cfg_aliases` twice, `phf_codegen`, `rustc_version`, `semver`, `version_check`). 238 come from crates.io, each with its `Cargo.lock` checksum; the other three are `herdr`, its `ghostty-vt` binding crate and the vendored `portable-pty`. No dependency is under a copyleft license: the identifiers are `0BSD`, `Apache-2.0` (once with the LLVM exception), `BSD-2-Clause`, `BSL-1.0`, `MIT`, `Unicode-3.0`, `Unicode-DFS-2016` (three packages carry Unicode data terms), `Unlicense`, `WTFPL` (`terminfo` 0.9.0) and `Zlib`.
- **Shipped texts.** Every package ships a license or notice file except seven (`ratatui`, `ratatui-core`, `ratatui-crossterm`, `ratatui-termwiz`, `ratatui-widgets`, `vtparse`, `wezterm-input-types`), whose MIT text lives only in their repository root. Their crates record the exact commits in `.cargo_vcs_info.json`; the two texts are stored in `.github/herdr-notices/` from those commits and pinned by SHA-256. The `ghostty-vt` binding crate has no license file of its own and uses Herdr's `LICENSE`.
- **Zig.** The build fetches eight packages. `zlib`, `highway` (Apache-2.0 OR BSD-3-Clause), `wuffs` (Apache-2.0 OR MIT) and `uucode` (MIT, with the Unicode License V3 and a Hoehrmann UTF-8 decoder notice) are treated as linked: the 0.9.5 debug executable built on 2026-11-09 contains `hwy`, `simdutf` and `wuffs` symbols. `uucode`'s own license file points to a `licenses/` directory that its Zig package does not include, so those two texts come from its pinned upstream commit. `pixels` (CC0-1.0, Wuffs test images), `iterm2_themes` (MIT; the Ghostty application's theme data, and its package ships no license file) and the build-time `aro` and `translate_c` are fetched by the build graph but are not inputs of the `libghostty-vt` archive; they are listed, and their texts are bundled where the package ships one. This reading comes from the vendored build files and that symbol search, not from a binary analysis of the release executable, so a `linked` judgement is conservative rather than proved.
- **Embedded in vendored Ghostty.** `simdutf` 9.0.0 (Apache-2.0 OR MIT) is linked and ships no license file in its vendored directory; the MIT alternative is bundled from its `v9.0.0` tag. `stb_image` and `stb_image_resize` (MIT or public domain, with the text in the header) are compiled only for Ghostty's application build: the executable has no `stbi_` symbol from them. The only SPDX tags in the vendored tree are HPND (fontconfig override headers, which only application builds use) and Apache-2.0 and BSD-3-Clause (two Highway source files, whose package texts are bundled).
- **Modified upstream files.** 23 differ from the original manifest (among them `crates/ghostty-vt/build.rs`, the Android target mapping above). Twenty-one carry a `Modified by lazysh` notice in the file; `Cargo.lock` (the pinned `getrandom` reference) and the generated `docs/next/api/herdr-api.schema.json` (the guarded methods, which a currentness test checks) cannot carry one and are the two paths `.github/herdr-notices/reviewed.json` names as documented here.
- **lazysh files.** 16 Rust files compiled into the executable, 15 under Apache-2.0 and `packages/common/src/hex_digest.rs` under GPL-3.0-or-later. That file is why `NOTICES.txt` includes the GPL text, offers the corresponding source and says the combined work is not Apache-only. Which terms apply to the combined executable is a legal question this audit does not decide; it records the licenses of each part.

### Not established

- This is an engineering inventory of one build, not legal advice, and not a statement that any platform is supported or any binary is released.
- Nothing is published or attached to a release: binding `notices.json` and `NOTICES.txt` to the release executable's digest and receipt ([#1756](https://github.com/mihazs/lazysh/issues/1756)) and shipping them as public assets beside it ([#1758](https://github.com/mihazs/lazysh/issues/1758)) are separate slices. The source URLs in `NOTICES.txt` use the CI checkout; a published copy must name the release tag.
- The release-profile build must use the same target and feature as the inventory step (`HERDR_TARGET`, `HERDR_FEATURES` in the job); a different feature set changes the dependency set.
- The hosted run of the new job step is only observable on the pull request that introduced it; locally the same commands ran against a copy of this tree with the Zig packages of an earlier build.

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
# Last, because it rebuilds target/debug/herdr with the managed namespace:
cargo +1.96.1 test --locked --features lazysh-managed --test guarded_input acceptance::
```

The example is a native Cargo process fixture that only writes its owned invocation marker and exits. It never implements SSH or opens a network. Its current-source build must precede the explicit path passed to acceptance; an arbitrary existing absolute binary is not provenance. Real-server cases use only private temporary sockets/config, two owned servers, an owned shell workload, and tracked child cleanup. They do not establish lazysh's future SSH/access-lease adapter, provider identity, GUI/physical-device or Windows guarded acceptance. Unsupported socket receive deadlines fail closed for guarded attachment while ordinary attachment retains upstream behavior.

## Stock Android navigation CI artifact

The `herdr-native` job also builds the original commit-addressed archive above in
a fresh external `stock-source` directory after copying and sealing the guarded
executable. It verifies all 1,843 original manifest records before and after the
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

Hosts can still run Herdr 0.9.3: lazysh relies only on commands, exact IDs,
snapshot fields and error codes that 0.9.3 and 0.9.5 share.

# F-Droid source-build validation

This is an initial, manual-update recipe for the public source revision in
`metadata/app.lazysh.client.yml`. It does not create tags, publish APKs, sign
anything, or submit metadata to F-Droid. Automatic updates stay disabled until
the separate release/tagging gates under #333 are complete.

The recipe follows the official [metadata reference](https://f-droid.org/docs/Build_Metadata_Reference/).
Run it with the official `fdroidserver` tools from this directory. Its
`srclibs/esbuild.yml` and `srclibs/rollup.yml` definitions match the official
fdroiddata definitions; the selected category entry is copied unchanged from
[fdroiddata's category configuration](https://gitlab.com/fdroid/fdroiddata/-/blob/master/config/categories.yml).
The [How2Vote recipe](https://gitlab.com/fdroid/fdroiddata/-/blob/master/metadata/au.how2vote.app.yml)
provides the source-built esbuild/Rollup precedent. Lazysh's pins match its own
Bun lockfile rather than that application's versions.

## Inputs and boundaries

- The app revision, product version and Android version code are literal and
  fixed. Final APK inspection must agree with them; no version-check bypass is
  used. The initial ABI is ARM64 only.
- Bun remains the package manager. The official Bun 1.3.14 baseline Linux
  archive has SHA-256
  `a063908ae08b7852ca10939bbdc6ceed3ddabce8fb9402dce83d65d73b36e6c7`,
  verified before extraction. This is a **prebuilt build tool**, not an app
  payload. The digest is published by the corresponding GitHub release asset.
  Its acceptance under F-Droid's FLOSS toolchain policy is not implied merely
  by hash verification or a successful build and remains subject to review.
- Debian supplies host dependencies; rustup selects Rust 1.99.0 and the Android
  target. Android uses the official SDK and NDK 29.0.14206865. Toolchain
  provisioning is separate from app compilation.
- Bun installs with scripts and optional binaries disabled. esbuild 0.28.2 and
  Rollup 4.65.0's host native binding are compiled from their exact source
  library tags during the build. Go is used only to compile upstream esbuild;
  lazysh's native implementation remains Rust.
- Tauri CLI 2.12.4 is compiled from its Cargo source package using its lockfile.
  The existing Gradle callback is changed in the disposable build checkout to
  use that same Cargo CLI, avoiding the npm native CLI binary. Normal source
  checkout/build behavior is unchanged.
- F-Droid removes the upstream Gradle wrapper before source scanning. During
  the build, the recipe points Tauri at the buildserver's `gradlew-fdroid`,
  which verifies Gradle distributions against its transparency checksums.
- The `fdroid` feature excludes the normal Google push project. That unused
  source directory is removed from the disposable source snapshot so the
  source scanner still examines every remaining input without an ignore rule.
  No source or binary scan bypass is authorized.
- Mosh/Whisper and other app-native libraries must be compiled from source.
  Android's normal feature graph does not enable Parakeet/ONNX Runtime. No
  speech models or provider accounts are required for this build.

This recipe is not offline or hermetic. Preparation downloads the pinned Bun
tool and public source dependencies. The build also fetches Tauri CLI's Cargo
dependencies and Gradle/Maven inputs, and upstream build tools may resolve
their locked source dependencies. A successful run does not establish that
these inputs or the Bun bootstrap have received F-Droid policy approval.

## Native validation

Use an isolated tools environment, for example a private Python venv with
`fdroidserver==2.4.5`, and the official buildserver image. Do not install tools
globally or change signing configuration. The metadata commands are:

```sh
fdroid readmeta
fdroid lint app.lazysh.client
fdroid scanner --exit-code app.lazysh.client:12002
fdroid build --test --stop --scan-binary app.lazysh.client:12002
```

`--test` retains unsigned outputs in the test directory; it is not a scan
bypass. The recipe's ordinary `output` identifies the unsigned release APK.
Do not use `--force`, `--skip-scan`, `novcheck`, or source/binary ignore rules
to turn a failed acceptance into a pass.

The initial scanner invocation also prepares the pinned Git checkout. This
matters when running this embedded directory directly: fdroidserver 2.4.5
otherwise asks for a source timestamp before creating the checkout and has
no fdroiddata-root Git history to use as a fallback. No fabricated timestamp
or tool patch is used. Supply the actual SDK location through `ANDROID_HOME`;
non-login container commands do not automatically source the image's SDK
environment setup.

`LAZYSH_FDROID_CLI=/path/to/private/venv/bin/fdroid bun run test:fdroid`
exercises the official parser/linter, the pinned app commit's version metadata
and a real owned Git scanner fixture. The fixture must report its deliberately
included archive, then clear it after source removal; an empty report is not
accepted as evidence of a completed scan. The dedicated CI workflow runs
these native tools without models, an emulator or signing credentials; it is
not a release-APK build gate.

The generated `build`, `logs`, `repo`, `stats`, `tmp` and `unsigned`
subdirectories are official fdroidserver caches/receipts and are excluded from
Git and duplication scanning. Recipe metadata, source-library declarations,
configuration, documentation and native tests remain scanned. These exclusions
do not affect F-Droid's source or binary scanner.

An APK build alone is not official repository inclusion or reproducibility
acceptance. Retain the exact source/image/tool receipts, source scanner report,
binary scanner report and unsigned APK identity/ABI/Google-free inspection.
F-Droid policy review, app assets/licensing, stable tags, a repeat build and
the actual submission remain separate gates.

## Executed checkpoint

The initial recipe was executed against app source
`1f890f6c5e2f11f16f28ac0b5a5bf8a0e3e6f2fa` (0.12.2 / 12002) using
fdroidserver 2.4.5 in official buildserver-trixie image
`sha256:1ea8bef1820bff06c2974e31b4fc4c79c364cd24231b86e71fa4b926797e0dac`.
The declared Debian dependencies were provisioned inside that isolated
container before its ordinary local `fdroid build`; the VM `--server` path
and its privileged preparation were not executed.

The actual source scan reported zero errors and retained one warning for
`packages/herdr-upstream/vendor/libghostty-vt/pkg/freetype/res/FiraCode-Regular.ttf`,
a font-data asset tracked with executable permission. Its bytes and original
attribution were not removed or ignored. No speech models were downloaded.

Source esbuild, Rollup, Tauri CLI and the ARM64 application compiled. The
native build completed with one success, including the non-free class scan
and extra signing-block scan. The unsigned release APK has SHA-256
`a84c6cd582a67c6c0e31b89603ad1f3c8f326d903dfd7a2f5137ccc069096c57`.
The existing Android artifact test passed 15 assertions: exact application
ID/version/code, non-debuggable release and all eight checked Google push
project/dependency/class/manifest indicators absent. ZIP/ELF inspection found
only ARM64 native libraries: the compiled application and the official NDK's
`libc++_shared.so` runtime.

Resolved source-library commits were esbuild
`609683d892977362a0f99026cb74b96263d728a9` and Rollup
`9aac09a39dc1fa297a7b06f1ad6907f7bd41b310`. The source Tauri CLI 2.12.4
Cargo archive SHA-256 was
`9966558da94fd1c9485d0d78f12233bea5fd4235826fb78e930fe7a26910b956`.
These receipts describe that executed recipe and source revision. They do
not establish a later main version, official inclusion, Bun tool approval,
physical-device acceptance or a reproducible second build.

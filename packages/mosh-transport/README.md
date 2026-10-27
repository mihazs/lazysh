# Headless Mosh transport

This Cargo workspace package embeds the official Mosh protocol core behind a Rust API. The Tauri application offers an explicitly selected Mosh transport on Linux, macOS, Android and iOS, while SSH remains the default. Linux protocol and SSH-bootstrap interoperability are verified; macOS runtime behavior, network roaming, and battery behavior still require acceptance checks. Android and iOS library simulator interoperability are verified; the iOS app now enables the same native handoff and embeds the upstream privacy resources. Actual app IPC/resource tests and physical-device acceptance remain separate checks. Windows remains unavailable.

The root Cargo workspace owns the lockfile. Bun/Turborepo tracks this package through `@lazysh/mosh-transport`; native build/test tasks use Cargo's cache and bypass Turbo artifact caching. Unsupported targets do not compile or link the C++ core.

See [IOS.md](IOS.md) for the shared dependency build, SDK/deployment settings, native Cargo simulator fixture, and remaining iOS acceptance checks.

## Source identity and licensing

Vendored files come from [mobile-shell/mosh](https://github.com/mobile-shell/mosh/tree/decd9b705eb81626f694335b8d5940538beb06da), commit `decd9b705eb81626f694335b8d5940538beb06da`. The source archive from `https://codeload.github.com/mobile-shell/mosh/tar.gz/decd9b705eb81626f694335b8d5940538beb06da` has SHA-256 `053743cd9c35ad6aa379652aa54be77108856d5282882ebb59888f2d3bc653ed`. `vendor.sha256` pins every included original file and the native build verifies those hashes before compilation. Only the protocol, crypto, state synchronization, terminal model/display, three protobuf schemas, and required utility files are included. No CLI, launcher, signal loop, shell scripts, or server entry point is linked.

The component and lazysh are GPL-3.0-or-later; the component additionally retains the upstream OpenSSL linking exception in its source headers. [vendor/COPYING](vendor/COPYING), [vendor/COPYING.iOS](vendor/COPYING.iOS), and [vendor/AUTHORS](vendor/AUTHORS) preserve the license, official Apple App Store statement, and attribution. Linked distributions must comply with the GPL's whole-work, notices, corresponding-source, and applicable installation-information requirements. The App Store statement addresses the conflict with Apple's terms and does not remove the other GPL requirements. This implementation does not publish an application release.

The alternative `Arunjay4213/mosh-rs` 0.1.3 was inspected but is not used: its platform crate fails Android compilation at `nl_langinfo/CODESET/getutxent`, and no matching App Store exception was found in that port's supplied license files.

## Native build and checks

Use Cargo's standard test/build structure. The current build requires a C++17 compiler, matching `protoc` and target `protobuf-lite`, target OpenSSL `libcrypto` with AES-128-OCB support, target zlib, and `pkg-config`. It has no build-time network fetches. On a Linux development host these are the usual protobuf/compiler, OpenSSL development, and zlib development packages.

```console
cargo test --manifest-path packages/mosh-transport/Cargo.toml --locked
cargo test --manifest-path packages/mosh-transport/Cargo.toml --test official_server --locked official_server_utf8_input_resize_shutdown_and_parallel_isolation -- --ignored
cargo clippy --manifest-path packages/mosh-transport/Cargo.toml --all-targets --locked -- -D warnings
cargo fmt --manifest-path packages/mosh-transport/Cargo.toml -- --check
```

The ignored integration test requires the official `mosh-server` 1.4.0 binary on PATH. It starts temporary loopback-only server processes with a 20-second network timeout and cleans up their recorded PIDs. It tests two parallel clients, UTF-8 input, PTY resize, and graceful shutdown, and checks that the calling process's locale, SIGWINCH disposition, and stdin flags are unchanged. It does not contact user hosts or accounts. Unit tests cover malformed protobuf, oversized authenticated resize/state, input limits, invalid authentication tags, authenticated fragment bounds, scoped IPv6 address preservation, a hostile reference-state deletion attempt, and recovery after bounded state flooding. An unauthenticated datagram one byte larger than the actual native receive buffer must reach the receiver on every platform and be dropped independently of stale `errno`; a subsequent authenticated packet must update the screen. The IPv4 maximum-size datagram is also exercised wherever the OS permits it; Darwin may reject that send with `EMSGSIZE`, which is explicitly checked before verifying normal authenticated recovery.

`bun run test:mosh` also runs the application's ignored OpenSSH/Mosh interoperability test. That fixture verifies real host-key authentication and remote bootstrap, closes the initial SSH PTY after handoff, sends UTF-8 input, resizes, uses the retained SSH connection for SFTP, and disconnects through the shared session/output-acknowledgment path.

Android uses pinned protobuf-lite 36.2, Abseil 20250512.1, utf8_range, matching generated messages, and the OpenSSL 3.6.3 Cargo source package; see [ANDROID-SOURCES.md](ANDROID-SOURCES.md). Set `NDK_HOME` (or `ANDROID_NDK_HOME`), target-specific `CC`/`CXX`/`AR`, and Cargo's target linker to the NDK tools. `ANDROID_API_LEVEL` defaults to 24 and must match the compiler/linker API. `NDK_HOME` takes precedence, matching Tauri when CI also exports an older `ANDROID_NDK_HOME`. The build explicitly selects that NDK's `llvm-ranlib` for OpenSSL instead of an inferred GNU-prefixed tool. No host protobuf, OpenSSL, pkg-config, or protoc is used for Android. The NDK's `libc++_shared.so` must accompany standalone executables and the APK's native library. ARM64 and x86_64 native Cargo test executables link with NDK29/API24; this does not establish device execution, app bootstrap, background/resume, or roaming behavior.

The native Cargo `android_peer` integration test exercises two clients, UTF-8, resize, and shutdown against an ephemeral official host server. With the NDK environment above, the `x86_64-linux-android` Rust target installed, and an accelerated Android emulator running, use `bun run test:android-mosh`. The native host fixture cross-compiles the peer in `target/android-mosh-tests`, reads the exact executable from Cargo's JSON artifact report, and selects the matching NDK runtime. It stages only a unique temporary device directory, runs the library unit suite on Android, starts temporary loopback mosh-server processes, and runs the Android test against the emulator's documented `10.0.2.2` host-loopback alias. `ANDROID_SERIAL` selects the emulator; `LAZYSH_ANDROID_ADB` optionally selects adb. For an already built peer, set both `LAZYSH_ANDROID_TEST_BINARY` and `LAZYSH_ANDROID_CXX_RUNTIME` to override compilation; `LAZYSH_ANDROID_UNIT_BINARY` optionally supplies the matching library test executable in that mode. Build steps have a 600-second deadline; adb steps have a 45-second deadline. Timeout kills the owned process group, retained subprocess output is bounded, device files are removed, and server processes have a 20-second network lifetime plus fixture cleanup. No custom runner script is used.

Without an emulator, validate the same native fixture's cross-build and artifact selection with `cargo test -p lazysh-mosh-transport --test official_server --locked android_fixture_cross_compilation -- --ignored`. This checks the resulting executable's ELF64/x86_64 identity and matching runtime existence, without claiming Android runtime interoperability.

`PROTOC` can select a matching host compiler for desktop builds. Cross compilation must supply actual target-native libraries through the conventional target-specific pkg-config/toolchain environment. Host libraries must never be passed off as mobile artifacts. Portable vendored dependency builds and Windows socket support remain unresolved; there is no pretend mobile fallback.

## Runtime contract

Create `Client::new(key, remote_socket_address, cols, rows)` inside the worker that will own it. `Client` is intentionally neither `Send` nor `Sync`. Its `write`, `resize`, `poll`, `wait`, and `shutdown` methods return Rust errors; C++ exceptions are caught before the C ABI returns. `poll` returns ANSI display bytes, authenticated-connection status, input capacity, terminal shutdown status, and a suggested polling delay. `wait` blocks only on this client's owned UDP sockets and never holds the shared native lock. The app bounds each wait to 20 ms for input/cancellation responsiveness. Shutdown initiates the Mosh shutdown exchange; the app polls for up to two seconds for an acknowledgment before dropping its client.

All native operations serialize access to Mosh's process-wide clock cache, nonce counter, compression buffer, and terminal conversion state. UTF-8 conversion uses a scoped thread-local locale, without changing process locale, stdin, signal handlers, or environment. The display uses fixed xterm capabilities and does not initialize ncurses/terminfo. Keys cross the constructor only, the Rust temporary is zeroized, native key copies are cleansed on destruction, and no session key is logged or serialized.

The application bootstraps `mosh-server` through its existing host-key-verified SSH connection and keeps that connection for files, agent events, previews, and multiplexer operations. The UDP destination uses the actual native SSH TCP peer, including IPv6 scope; only the validated UDP port is replaced from the reply. The server's `-s` option binds to its SSH-side local interface. NAT setups must forward the selected UDP range to that same host.

Bootstrap output is limited to 8 KiB, requires exactly one valid `MOSH CONNECT` line, and is never copied into error messages or terminal output. The key is kept in zeroizing memory. The connection resolves only after an authenticated UDP state arrives, with an eight-second handshake deadline. Parent-session cancellation aborts bootstrap/handshake; cancellation after handoff uses the new session's own lifetime. There is no silent SSH fallback when Mosh is forced. Bastion/routed sessions and unsupported platforms return an explicit error before starting a server. SSH remains the default transport.

Server executable and UDP range are connection preferences; no Mosh key is stored in workspace intent. If UDP is unreachable, the official server's initial no-client timeout cleans up an uncontacted bootstrap process after approximately a minute. If the SSH control connection later drops while UDP survives, the terminal can continue, but dependent SSH tools require a new authenticated control connection; automatic reauthentication is not implemented.

## Embedding changes and bounds

Original vendored files remain unchanged. `build.rs` applies the following dated lazysh embedding changes to their verified build copies:

- Preserve assertion checks and convert their failures into caught C++ exceptions, including upstream fatal aborts. No blanket `NDEBUG` bypass is used. The crypto destructor always performs upstream's unconditional successful cleanup without throwing from a destructor.
- Reject malformed/oversized host messages, over 4096 host instructions, and invalid dimensions before terminal allocation. Limits are 512 columns, 256 rows, and 32768 total cells.
- Reject fragment indices at or above 4096 before growing fragment storage; upstream bounds decompression at 4 MiB.
- Drop unauthenticated oversized datagrams and transient receive-network errors; genuine local socket errors still fail the operation.
- Require a throwaway state number no greater than the reference state, preventing deletion of a referenced iterator. Cap retained receiver states at 32 by declining to acknowledge additional states until older references can be discarded. This bounds memory and allows recovery when acknowledgements resume; severe one-way loss can temporarily stall screen updates at the cap.
- Bound queued input to 64 KiB of events and one returned ANSI frame to 8 MiB. The caller must apply its own bounded output delivery/backpressure before forwarding frames to a WebView.
- Use `OPENSSL_cleanse` on native raw key copies and fixed xterm display initialization.

The iOS native fixture's timeout diagnostics retain only the owned process group's
PID/parent/group IDs, executable image, and opaque process state/flags before
attempting bounded sampling. The same one-second inventory and five-second total
diagnostic budgets remain in effect; no argv/environment or broader process list
is collected. The [Apple ps manual](https://keith.github.io/xcode-man-pages/ps.1.html)
documents these fields. A retained state is an observation, not proof of native
entry, a blocked function or the cause of #45's intermittent empty `--list` timeout.

Before timeout diagnostics run, the existing pipe readers also expose a capped
retained-byte count, observed EOF and first/last successful-read milliseconds
relative to reader setup. A nonblocking per-stream snapshot retains coherent
metadata or a fixed busy/unavailable marker, without waiting for a reader lock.
Stdout and stderr snapshots are separate observations, not an atomic global
timeline; their timestamps describe reads, not when the child wrote or exited.
The formatted snapshot is frozen before sampling, so later output cannot rewrite
it. The existing 16 MiB retained-output cap, launch/diagnostic deadlines and
cleanup behavior remain unchanged. No new raw data or process is collected.

Prediction/local echo, reconnect indicators, automatic control-connection reauthentication, Android app acceptance, iOS native/app acceptance, Windows support, app background/resume hooks, and native roaming/performance measurements remain open. Basic protocol and desktop bootstrap interoperability do not establish complete Mosh parity.

Native application regression peers enable the development-only `test-fixtures`
feature through their Cargo dev dependency. It exposes bounded packet/ACK helpers
for a fixed public test key, serialized by the same native core mutex as clients.
The ACK decoder's C symbol and Rust helpers are absent from default builds; this
feature adds no production IPC or network service.

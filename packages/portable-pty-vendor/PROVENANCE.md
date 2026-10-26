# portable-pty 0.9.0 provenance

This directory contains the published [portable-pty 0.9.0 crate](https://crates.io/crates/portable-pty/0.9.0), released by Wez Furlong. The upstream MIT license and copyright remain in `LICENSE.md`. This vendored dependency is excluded from lazysh's own GPL workspace package defaults; it remains an upstream MIT component linked into the GPL application.

Source archive: https://static.crates.io/crates/portable-pty/portable-pty-0.9.0.crate

Archive SHA-256: `b4a596a2b3d2752d94f51fac2d4a96737b8705dddd311a32b9af47211f08671e`, verified against the cached release archive and its former crates.io entry in the root Cargo.lock. The packaged Cargo.lock is omitted because lazysh resolves this dependency through its single root lockfile.

The initial source change is in `src/win/psuedocon.rs`: remove `PSUEDOCONSOLE_INHERIT_CURSOR` from `CreatePseudoConsole` flags while preserving the existing resize and Win32 input flags. lazysh creates a new independent terminal at its own initial cursor position; it does not inherit a parent console's cursor. Microsoft's [ConPTY lifecycle documentation](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session) describes the shutdown deadlock possible when an inherited-cursor query has not been answered.

The application also reserves a shutdown output-drain worker before spawning any Windows child and keeps it alive through HPCON destruction. Microsoft's [ClosePseudoConsole documentation](https://learn.microsoft.com/en-us/windows/console/closepseudoconsole) requires closing or draining output during teardown on Windows versions before Windows 11 24H2. That application lifecycle logic is in `apps/client/src-tauri/src/local.rs`, not a second vendor modification.

Update this archive identity and inspect the complete upstream diff when upgrading. Run the app's native `test:local` Cargo task on Linux, macOS and Windows; Windows versions before 24H2 need separate runtime acceptance. A test on the current hosted Windows image does not certify every supported historical build.

Explicit working-directory selection in `src/cmdbuilder.rs` now reaches the native process-creation API even when the directory has disappeared. It no longer silently substitutes HOME after an explicit `cwd` request; unset working directories retain upstream HOME/default behavior. The application native PTY suite verifies literal selected working directories and failure after removal between validation and spawn. The original MIT notices remain intact.

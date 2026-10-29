# Android startup CPU budget diagnostic

Issue #379 has SystemUI startup ANRs before runtime compilation starts. This
manual-only workflow tests sensitivity to the guest CPU setting; it changes no
acceptance gate and establishes neither root cause, a fix, nor platform parity.

Run **Android startup CPU budget diagnostic** manually after reviewing its source.
Temurin JDK 21 is set up explicitly before SDK use. One GitHub-hosted Ubuntu 24.04 VM cold-boots fresh AVDs in order **2, 4, 4, 2**.
Pixel2, API36/default/x86_64, swiftshader, 3072M, imagefile camera, disabled unlock,
and KVM remain fixed. Emulator build 16428233 matches the observed 37.2.12 build.
There is no application, Rust or Gradle work. The runner admits at least four
actual host CPUs from affinity, ancestor cpusets and ancestor CPU quotas; it
retains numeric quota/usage/throttle snapshots before and after each sample.

The pinned action forces `$HOME/.android/avd`; it does not honor a private AVD
home. The runner requires the fixed-name AVD and both emulator ports to be absent
before creating it. Existing QR ownership attestation verifies the exact owned
PID/start time, executable, AVD, serial and reviewed camera bytes. Fresh directory,
config and index inodes are recorded. Only that verified AVD is removed, after
the emulator has retired. After the action requests shutdown, a read-only wait
allows up to ten seconds for that same PID/start identity to exit; identity changes
fail immediately. No emulator is signalled or force-killed by the runner. If boot fails
before ownership can be proved, its failed action outcome is retained, unknown
state is left intact, and subsequent samples stop.

Each sample observes 60 seconds from ownership admission in the post-boot action script, then
reads finite framework diagnostics: filtered SystemUI ANR events, CPU usage,
last ANR/traces, guest uptime/load and online CPU count. Every foreground capture
has a 10-second deadline and 1 MiB stdout bound. Startup records are retrospective
buffer reads: `not-observed` means no matching retained event, not proof that no
ANR occurred. Stack-frame flags only describe the matching SystemUI process block
in the retained dump; they establish neither an ANR nor its cause. A boot timeout may lack guest traces and remains inconclusive.

Emulator/image trees and camera bytes are fingerprinted before each launch, with
a shared 60-second hashing deadline. Image installation is performed by the
pinned action before that check. Drift, changed host/guest identity, repeated
guest boot identity, unexpected core count, unavailable capture, overflow, timeout
or cleanup failure makes the sample inconclusive and stops the remaining boots.
Only hashed host/guest boot identities enter the artifact. Internal PID/ownership
proofs remain outside the upload directory. Framework text captures contain only
the fresh system guest, with no installed app or private user session.

Review `summary.json` and the per-sample bounded framework captures together.
Both two-core startup ANRs with neither four-core sample showing one would support
further investigation, not a causal conclusion. Four boots are a small sample;
host page-cache warming, scheduler noise, quota throttling and graphics threads
sharing the same host CPUs remain confounders. No host caches or kernel settings
are reset. The pinned action can still launch after its pre-launch hook fails;
the earlier pre-action host admission remains mandatory, and a failed seal makes
that boot unusable and stops subsequent cases. Historical system-image revision
equality is not established: this
experiment requires equality within its own four samples.

Local owner: `bun test tests/android-startup.test.ts`. This tests admission,
classification and real foreground-child failure/overflow/deadline cleanup;
it does not boot an emulator. Existing acceptance CI remains separate.

Admission failures include an `observationFailure` with a closed checkpoint for
camera ownership, AVD proof/seal matching, process identity, guest CPU/boot reads
and validation, freshness, or later observation operations. When the failure
originates in camera attestation, a second closed `cameraCheck` category identifies
the rejected check. The existing generic error message and all admission checks
are unchanged. Capture status/byte counts survive later validation failures;
checkpoint fields contain no underlying error, PID, path, argv, or raw boot UUID.
They locate a failed operation, not its root cause. Existing observation evidence
survives a subsequent cleanup failure. Missing PID fields in the summary do not
locate failure: PID/start proofs are internal and never uploaded.

## AVD serialization and closed field observations

Upstream qemu commit `ae9d18d2b6261179fbd57fffec720a04f7bfb053` writes
[`key = value` assignments and atomically replaces INI files](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/android-emu-base/android/base/files/IniFile.cpp).
That file's SHA-256 is
`806aa822a42a8d6065de655f8078d4ecd8ae09e0f4827eec5cbcd2c8007885ce`.
The [C INI writer](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/emu/files/src/android/utils/ini.cpp)
delegates to it. [First-boot partition configuration](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/emu/avd/src/android/avd/info.c)
can rewrite config.ini. These source contracts justify parsing whitespace around
assignments while retaining exact key/value and unique index-path checks.
They do not identify which field changed in the failed hosted sample or establish
the exact source revision of SDK emulator build 16428233.

Run 40825846679 artifact 12875968930, SHA-256
`b99e21eba8872de8a2cdc1cd2094f3a03690624558de15f60e18aa5bd4974699`,
passed camera attestation and stopped at `avd-proof`, before inode comparison.
The next probe retains only closed directory/config/index inode-stability flags,
core/device/image/index validity, RAM encoding, and assignment-format categories.
A failed subcheck has a closed `avdFailure.check`; no raw config, path, UID or PID
is retained. The observation phase distinguishes seal, post-boot and retirement
snapshots; a later cleanup failure preserves the original observation.

RAM `3072M` versus integer `3072` remains an unverified runtime distinction.
The [hardware definition](https://android.googlesource.com/platform/external/qemu/+/ae9d18d2b6261179fbd57fffec720a04f7bfb053/android/emu/avd/src/android/avd/hardware-properties.ini)
declares integer megabytes. This probe leaves the configured RAM and allowed RAM
value unchanged pending actual flags. UID, link, canonical path, RAM/core/device/image and directory/index inode checks
remain strict. After camera attestation and all those checks pass, post-boot
admission may replace the sealed config inode once with its freshly proved
config inode. Retirement compares all three inodes exactly against that admitted
baseline; a later config replacement still prevents deletion.

Branch probe 40827477335 artifact 12877695809, SHA-256
`56546a7d29d52233d9587e33fbfbd9724e59352d9838d1f6b1e2172f444d64b4`,
retained valid core/RAM/device/image/index fields, unchanged directory/index
inodes, spaced assignments, and a changed config inode. RAM remained `3072M`.
It stopped at the original inode comparison. This observed replacement matches
the documented SDK atomic writer. The one-time admission handoff addresses that
setup contract; it does not establish an ANR cause or CPU-budget outcome.

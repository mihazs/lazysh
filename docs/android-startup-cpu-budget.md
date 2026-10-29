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

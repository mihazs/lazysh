# Published Android APK smoke

The **Published Android ARM64 APK smoke** workflow accepts a stable public
release tag on manual dispatch (currently `v1.0.0`). Narrow same-repository PR
changes to this gate also exercise that stable public tag before merging. Each Google/FOSS case receives a separate owned
hosted VM and fresh Google APIs API35 x86_64 revision9 guest. It downloads the
nominated public APK; it never rebuilds, resigns or enables debugging in that APK.

The gate binds the tag's resolved source commit to `release.json`, and compares
its nominated signed Android receipt with the GitHub asset's size/digest and the
actual downloaded bytes. It checks application ID, version/code, nondebuggable
manifest, the reviewed public certificate pin (set as `ANDROID_SIGNER_SHA256`, without secret
or signing-key access) and every packaged
native library's ARM64 path/AArch64 ELF header. This verifies the nominated APK,
not completeness of today's release inventory: the initial 0.23.0 release predates
the newer companion asset set. Existing public assets and tags are never changed.

A separately debug-signed, self-instrumenting UI Automator APK targets its own
`app.lazysh.acceptance` package. Its isolated Gradle project uses the existing
wrapper and test/toolchain versions; the workflow checks a driver-only dry run
before building. It does not depend on or configure the Tauri application project.
The production application is another process, observed through normal Android
accessibility actions. No production certificate, root, `run-as`, native IPC,
WebView debugging, injected JavaScript or app automation flag is used.

Admission requires the reviewed image revision and actual guest API35,
`x86_64,arm64-v8a` ABI list, `libndk_translation.so` bridge and ARM64-to-x86_64 ISA
mapping. The guest's boot identity and build fingerprint are hashed observations,
not invented fingerprint pins or proof of a physical ARM64 CPU. The existing
QEMU PID/start-time/executable/argv/camera attestation is reused unchanged. Its
fixed ownership name remains `lazysh-runtime-api36`; this name is a nomination
only, while the image/API admission here explicitly requires 35. The AVD must be
absent before creation; an existing application or driver package is rejected.

The external driver saves a unique synthetic `.invalid` host, without connecting
or supplying credentials. It opens Edit and checks the name, address and username.
The host then stops/relaunches the application, verifies the same fields,
rechecks the APK digest, runs ordinary `adb install -r` with those identical bytes,
and relaunches/reads the fields again. Successful durable save/list commands pass
through the shipping protected native bridge and Rust configuration path, giving
JNI/startup evidence beyond a surviving window. A locked guest or unexpected UI
fails the phase; there is no fallback input path or retry.

Only finite receipts are uploaded: nominated public identity/digests/certificate,
hashed guest identities, sampled admission and completed phase booleans, and
closed failure/cleanup stages. The parent UI phase and the whitelisted existing
driver assertion stage are separate; missing, conflicting or unrecognized driver
results remain unavailable. Original child output is discarded. Raw hierarchy, screenshots, APK bytes, local paths,
input values and child output are not uploaded. Only successfully installed owned
packages are uninstalled. A lost install acknowledgement is an unconfirmed
cleanup outcome, never permission to adopt or remove an unknown installation.
Original failure and cleanup failure remain separate. Foreground children and UI
phases have finite deadlines and output limits.

This is translated ARM64 install/JNI/UI/same-version persistence evidence. It does
not establish physical Galaxy/Samsung behavior, ARM64 performance, graphics,
battery/audio, cross-version migration or full native feature parity. First hosted
execution of both flavors is required before calling this gate verified.

Sources: [external release UI Automator contract](https://developer.android.com/training/testing/other-components/ui-automator),
[AOSP self-instrumentation example](https://android.googlesource.com/platform/docs/source.android.com/+/7409ec325d2ac879e4630701ce238089c3bd2b0b/en/compatibility/tests/development/instr-self-e2e.md),
[official Google API image catalog](https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml),
[ARM translation scope](https://android-developers.googleblog.com/2020/03/run-arm-apps-on-android-emulator.html).
Refs #467.

The pinned action resets `ANDROID_AVD_HOME` to `$HOME/.android/avd` before creating
the AVD ([immutable installer source](https://github.com/mihazs/lazysh-android-emulator-runner/blob/46beb5d59b664ea61462125a023549a5a7b0418b/src/sdk-installer.ts#L39)); the absence check uses that exact location. No private-AVD-home support is assumed.

The first closed driver-stage run admitted translation for both variants, then
failed FOSS at `NAME` and Google at `WORKSPACE`. These are distinct observations,
not proof of one JNI or accessibility cause. Chromium's Android accessibility
[`GetHint`](https://github.com/chromium/chromium/blob/49ec12cc413ffec766028509968b31d7d65fa0b7/content/browser/accessibility/browser_accessibility_android.cc#L790)
can append an AX placeholder when present. The earlier audit incorrectly inferred
that an HTML placeholder guarantees that AX attribute. Actual admitted Google and
FOSS samples instead report label-only hints: `Name`, `Hostname or IP`, and
`Username`. The strict selectors now use those observed exact labels. Observation
categories retain independent literals for label/placeholder variants, so changing
a selector cannot silently redefine the evidence. No substring, positional or
JavaScript fallback is used. Nested owned failures
keep their nearest closed stage rather than being hidden by an outer workspace
stage. The workspace wait, overall deadline, actual UI actions and exact saved
field readback remain unchanged. Successful hosted completion remains required.

The composite-hint revision still failed FOSS at `NAME` and Google at `WORKSPACE`;
that hypothesis alone did not resolve either run. Failure receipts now separate
the input field and lookup/click/set/readback operation. The readback flag is the
result of the original comparison, not an extra read or replacement assertion.
One failure-only accessibility sample caps editable nodes at 8 with explicit
overflow and classifies hints only against the known labels/placeholders, empty,
other or unavailable. It never retains actual hint/value strings. Foreground,
screen and keyguard flags are sampled observations, not proof of startup cause.
Missing queries remain null/unavailable; malformed or unexpected host report
fields are discarded wholesale. Observation failure cannot replace the original
UI failure, and diagnostic metadata cannot satisfy the success protocol.

The public 0.23.0 APK predates the later branding and viewport repairs. A genuine
old-public startup or clipping defect may legitimately fail this gate until a
corrected version is published; the driver must not bypass normal UI to obtain
a passing receipt.

At driver head `9d966d2`, both flavors failed `WORKSPACE` before input, with the
target foreground, screen on/unlocked and zero sampled editable fields. That
stage did not distinguish its initial readiness wait from the final unique
Add-host lookup. Those unchanged operations now report `WORKSPACE_READINESS`
and `WORKSPACE_ADD_HOST` separately. A failure-only sample additionally projects
exact Add-host/Open-host accessibility matches as zero, one, multiple or
unavailable, and target WebView accessibility presence as a nullable boolean.
The sample checks the original remaining driver deadline before each query;
expired or failed queries remain unavailable. It does not retain labels or
hierarchies and does not prove what was present throughout an earlier wait.
That diagnostic revision kept the 0.23.0 nomination, selectors, actions, waits and
success protocol unchanged.

Both diagnostic cases then passed workspace readiness and exact input/readback
but failed `KEYBOARD` on public 0.23.0. The receipt does not distinguish Back
rejection from an IME accessibility window that remained present; the cause is
unproven. Current qualification nominates actual public `v1.0.0`, released from
`55a52e01bcf37c600d1a9877b190e85eb3141ff9`, without changing the keyboard action,
selectors, waits, certificate pin or any integrity/UI/persistence requirement.
Current-version KEYBOARD and full install/relaunch/repair results remain
unverified until actual hosted completion for both flavors.

Both first 1.0.0 cases failed initial `WORKSPACE_READINESS`; later samples had an
Open-host control and WebView but no editable fields. That later sample does not
reconstruct the earlier wait. A separate six-field readiness trace now records
the original wait's true/false return, exception or unentered/unavailable state,
monotonic elapsed milliseconds capped at60,000, poll count capped at64 with
overflow, and the last Add/Open categories from the exact original predicate
queries. Each poll resets both categories; short-circuited Open remains
unavailable. No additional query or ownership guard is introduced. At the elapsed
cap the value means at least60,000ms, without further latency precision; poll
overflow means more than64 polls.

The exact [UI Automator2.4.0 sources](https://dl.google.com/dl/android/maven2/androidx/test/uiautomator/uiautomator/2.4.0/uiautomator-2.4.0-sources.jar)
(SHA256 `be710c5b295357f7e0deb652f1aa192b4fa6f2245af361743b402ce88ab8ec21`)
show that `WaitMixin` evaluates immediately, polls null/false at its existing
100ms interval and returns the last result; predicate exceptions propagate.
Blocking queries can make elapsed time exceed the nominal wait. The driver
keeps that original wait, cadence, OR short circuit, caption selectors, launch
admission and assertions. It has no foreground-package query inside the predicate,
so the trace does not add one or claim an ownership-guard race. Unknown/private,
inconsistent or out-of-bound trace fields make the failure observation unavailable
without replacing the original failure. No startup fix is claimed.

The original readiness trace then returned true for both1.0 variants (10,404ms /
four polls and11,659ms / five polls), followed by later `SAVE_HOST` failures.
Neither case completed a save or exercised relaunch/reinstall. Save now records
lookup/click/complete progress and raw-versus-visible exact caption categories
from the original query collections and their original bounds reads. Each lookup
resets both categories; a query/property failure leaves the unfinished part
unavailable. No extra query, bounds read, click, wait or scroll is added. Complete
means the original click returned, not that durable save was acknowledged.
The host accepts only the exact three closed fields with consistent count
categories; raw labels, coordinates, exceptions and arbitrary fields are rejected.
The scrollable form footer remains a hypothesis until actual match evidence
distinguishes absence, ambiguity, empty visible bounds and click failure.

At the Save-trace revision, FOSS still failed lookup with zero query matches;
Google instead returned false from readiness while another package was foreground.
UI Automator's `ByMatcher` discards invisible subtrees before matching, so even
the original raw query collection cannot rule out an offscreen form footer.

Current fixture preparation now follows the [Android UI Automator launch
contract](https://developer.android.com/training/testing/other-components/ui-automator-legacy):
after the single original launch, require a visible target-package root and
target foreground before starting the unchanged functional-caption wait. This
uses only the remaining original45-second flow budget; it adds no numeric budget
or launch retry. A missing first owned window fails `LAUNCH_WINDOW`.
[`startActivitySync`](https://developer.android.com/reference/android/app/Instrumentation#startActivitySync(android.content.Intent))
cannot replace this external-process precondition because it cannot start a
different process. This does not establish Google's earlier startup cause.

If Save host is not already uniquely visible, form navigation anchors on the
exact owned Name field and its synthetic value, traverses at most16 same-package
parents up to the WebView, and requires exactly one scrollable ancestor below
that WebView. It never chooses a global first scrollable view. With target and
container ownership rechecked, at most four normal native DOWN gestures of0.8
container lengths may reveal the footer. Ambiguity, foreign/stale ownership or
an exhausted original deadline fails closed. The exact visible,
unique Save-host lookup and single click still follow, with every durable-save,
relaunch and same-byte reinstall assertion intact. No random tap, input retry,
sleep, fallback or deadline extension is introduced. Runtime verification of
these fixture actions remains required; no product footer repair is claimed.

The first owned-navigation cases both failed inside `FORM_SCROLL`. That outer
stage also includes checks before owner admission, so it does not establish that
the nested owner check or a particular gesture ran. The lower-form failure
samples are consistent with movement, not proof of its count or cause.

UI Automator2.4.0 `scroll` returns false for either a detected end or a missing
accessibility scroll event. `pressBack` returns whether a content-changed event
arrived, not whether the IME is absent. The fixture therefore ignores these event
booleans: scroll preparation still permits at most four owned gestures and exits
early on exact Save visibility, then always hands off to the ORIGINAL named Save
wait and single click. Keyboard dismissal still uses one ordinary Back and the
ORIGINAL IME-absence wait. No actual UI-state assertion, flow deadline, input,
launch count or persistence requirement changes. These are source-contract
repairs; the historical KEYBOARD/FORM_SCROLL causes remain unproven until runtime
evidence, and full both-flavor qualification is still required.

The event-contract revision then had a pre-guest Google preparation failure and
a FOSS create failure without a classified driver result. The existing receipt
now separately records the latest driver-command invocation's closed outcome
(completed, deadline, nonzero, start, teardown, output-bound or unavailable) and
elapsed milliseconds capped at60,000. Timing includes its original ownership/
budget preflight; the cap means at least60,000ms. Cleanup cannot overwrite this
primary invocation sample. Completed plus unavailable driver data means only
that the command returned unclassified instrumentation, not a guessed crash or
timeout. Original success requirements remain unchanged.

The CLI failure line now emits only existing allowlisted asset stage codes or
static environment/AVD/state/admission/acceptance labels. Asset codes come from
the module's typed error, not arbitrary error text. Unknown, malformed, private
or nonmatching errors produce unavailable. No raw message, command argument,
path, stdout or stderr is retained. Driver actions and all budgets are unchanged.

The existing stage wrapper also emits finite entry and normal-return exit markers,
without querying the UI or changing its actions. On command failure,
`driverProgress` retains only the last complete allowlisted `{stage,event,depth}` status
frame, separately from the original command outcome, UI failure and cleanup.
A complete frame ends with its own `INSTRUMENTATION_STATUS_CODE: 0`; unfinished
later data cannot replace an earlier complete marker. Missing or malformed data,
NUL bytes, unknown/extra/duplicate fields, more than 256 records, or output beyond
the unchanged 64KiB limit make progress unavailable. No partial output or raw
exception is retained. Entry proves only that a wrapper was entered; exit proves
its action returned normally. Neither identifies the currently blocked operation
or the cause of a timeout, and even COMPLETE progress cannot grant a phase pass.
Depth is zero-based wrapper nesting, balanced in `finally` even after failure.
The current deepest paths are FORM_SCROLL→SCROLL_OWNER→input and
WORKSPACE→DRAWER→named, so only integer depths 0–2 are admitted; other values make
progress unavailable. A READBACK exit at depth 1 can be a nested lookup before
its text/equality check, while depth 0 identifies the outer three-field action's
normal return. Legacy two-field records remain readable with explicit null
(unknown) depth; no stack inference, clamping or fabricated zero is used.
The 45-second command and 240-second overall budgets remain unchanged. Refs #525
and #555. This diagnostic does not establish the current timeout cause or close
public-package qualification.

## Verified qualification: public v1.0.0

Both Google and FOSS completed the actual gate at driver head
`ee79d4a12e76f992c31bd5802752a71350998a30` in
[run40929887367](https://github.com/mihazs/lazysh/actions/runs/40929887367).
The public signed APKs bind to source
`55a52e01bcf37c600d1a9877b190e85eb3141ff9` and the reviewed certificate pin.

| Variant / job | Artifact | Verified archive SHA256 |
| --- | --- | --- |
| [Google123645191141](https://github.com/mihazs/lazysh/actions/runs/40929887367/job/123645191141) | 12922497226 | `176f1818bc5d29bcb33dca2cd40cf32057b76ce63ee24c09c70337ec425a7616` |
| [FOSS123645191392](https://github.com/mihazs/lazysh/actions/runs/40929887367/job/123645191392) | 12922013862 | `f4587d315239041055ace93ba9127794d93571143d1ce1b53f2623c1eb14a1b4` |

Both receipts report guest admission, UI host creation/readback, process relaunch,
identical-byte reinstall and preserved fields as true, with cleanup passed and
all failure/driver observation fields null. Both final verification commands
completed; their 14,295ms and 14,753ms timings cover only that last invocation.
Owned uninstall commands completed without reported error; package absence was
not independently queried afterward.

This qualifies these public v1.0.0 APKs on admitted Google API35 revision9
x86_64 guests using ARM64 translation. Physical Galaxy/Samsung behavior,
cross-version migration, later releases and full feature parity remain separate.
The successful result does not establish the causes of the historical failures
or which conditional scroll/keyboard branches executed.

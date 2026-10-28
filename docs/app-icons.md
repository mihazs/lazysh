# iOS Home Screen icons

Preferences → App icon offers Default (the existing lazysh artwork) and Amber
(an original alternate `l_` mark). Apply app icon asks UIKit to change the actual
Home Screen icon. Refresh app icon reads the actual selection back from UIKit;
returning to the foreground also refreshes it. iOS may show its own confirmation.
The default remains unchanged until you explicitly apply an alternate.

The setting belongs to iOS on this installation. It is not saved in terminal
preferences, exported in settings sync, or applied to other devices. Resetting
terminal preferences does not reset the Home Screen icon: select Default and
apply it. Desktop, Android and the browser report unavailable; changing a window
icon is not a substitute for this feature.

Only two bundled choices are accepted. Native code checks UIKit support and the
current device's icon declarations, runs on the main queue, serializes changes,
rejects background requests, and reports the selection UIKit actually returned.
A rejected or unchanged request never becomes a success label. Refresh recovers
the current state after an error. No key, host, transcript, resume-lock policy or
unlock authority is exposed by these cosmetic commands. With the #47 renderer
ownership contract, keep the explicit local-main capability and do not broaden
protected command admission to enable cosmetic operations.

The asset catalog and custom Tauri iOS project template declare the alternate for
iPhone and iPad. The PNG is rendered from the original repository-owned vector
[amber.svg](../apps/client/src-tauri/apple/IconArtwork/amber.svg); no vendor artwork
is used. Bundled keys and actual native IPC readback are checked by
`AppIconIntegrationTests` in the existing hosted iOS app test target. The existing
out-of-process UI runner owns valid changes and native readback: apply Amber,
handle system confirmation, relaunch, restore Default and attempt original-icon
cleanup. Unsupported execution fails acceptance instead of silently passing. State tests
cover no support, missing bundle declarations, invalid names, background/busy
requests, delayed completion, unchanged readback, rejection and restoring Default.
Frontend tests cover pending UI, unsupported platforms, errors and native readback.

Native compile, hosted simulator tests and physical Home Screen behavior are
separate gates. Run the existing iOS app and status test jobs on macOS; then on
both iPhone and iPad: apply Amber, inspect the Home Screen, relaunch to confirm the
reported selection, restore Default and inspect the Home Screen again. Test
failure/recovery without losing the actual reported icon. A passing controller
fixture or bundle/IPC test alone does not certify physical Home Screen changes.

Observed native limitation: [run 40205323991](https://github.com/mihazs/lazysh/actions/runs/40205323991)
compiled the iOS app and passed all three controller tests, but the first real
icon mutation IPC promise did not reply within 20 seconds and the hosted app
step ultimately exceeded eight minutes. No bundle/valid-change success was
observed. Launch metadata had `OS_ACTIVITY_DT_MODE=YES`; no sampled stack proved
the cause. A fresh run includes the independently merged hosted-logging marker
fix and a status-only preflight before attempting mutation. Safe stage attachments
record callback receipt and icon state, not credentials. The marker is not evidence
of a successful icon change until the controlled runtime checks actually pass.

References: reference client personalization (source URL omitted),
[UIKit alternate icon API](https://developer.apple.com/documentation/uikit/uiapplication/setalternateiconname(_:completionhandler:)).

The second controlled run, [40208351521](https://github.com/mihazs/lazysh/actions/runs/40208351521),
passed native status preflight (`available=true`, `current=default`) with duplicate
mirroring absent, then the valid Amber setter failed to complete. A retained
stackshot shows the alternate-icon LaunchServices queue waiting for synchronous
XPC; the hosted test's later direct readback waited behind that queue. This is
not evidence of the earlier WebPrivacy logging stall. Valid changes now run in
the existing out-of-process UI runner, where system confirmation can be handled,
with Amber/readback/relaunch/Default and original-icon cleanup. Hosted tests retain
status preflight, invalid-input rejection and bundle-resource checks. Native
success remains pending execution of this corrected test boundary.

That run also found missing `CFBundleIconFiles` beneath a manually supplied icon
dictionary. The initial explanation that the manual dictionary caused the missing
files was not established. In [run 40211520800](https://github.com/mihazs/lazysh/actions/runs/40211520800),
head `380a2bc` still reported only `CFBundleIconName=LazyshAmber` after the manual
dictionaries were removed. The manual-overwrite cause is therefore retracted.

Apple's current [alternate-icon configuration guide](https://developer.apple.com/documentation/xcode/configuring-your-app-to-use-alternate-app-icons)
requires compiler build settings rather than manual icon dictionary overrides,
and its [asset catalog guide](https://developer.apple.com/documentation/xcode/configuring-your-app-icon)
supports generated variants from one 1024-pixel source. The archived alternate-key
reference describes file arrays, so actual compiled rendition evidence was needed
before changing the universal external-PNG assumption.

[Diagnostic run 40214525104](https://github.com/mihazs/lazysh/actions/runs/40214525104),
head `f048def`, retained [artifact 12606494985](https://github.com/mihazs/lazysh/actions/runs/40214525104/artifacts/12606494985)
immediately after build. Native `assetutil` identified the following actual
`Assets.car` renditions, not merely source filenames or plist declarations:

| Name | Asset type | Idiom | Pixels | Opaque | Rendition |
| --- | --- | --- | --- | --- | --- |
| LazyshAmber | Icon Image | phone | 1024 × 1024 | true | amber.png |
| LazyshAmber | Icon Image | pad | 1024 × 1024 | true | amber.png |

The catalog also has matching phone/pad MultiSized Image entries. Both compiled
icon dictionaries reference `CFBundleIconName=LazyshAmber` without an alternate
Files array; primary icon dictionaries do contain file arrays. The tool header
scopes this observation to Xcode 26.6 (17F113), CoreUI 975, schema 2, iOS deployment
16.0. Raw catalog JSON SHA-256:
`c700a5523906be7bb80164b8f87e6027fd8d669e17335311aa71561b5fef0213`.
This establishes the observed catalog-backed representation, not a claim about
all past or future SDKs.

Hosted tests retain exact name assertions for both icon dictionaries. Declared
external file arrays must be nonempty, resolve to bundled PNGs and decode. A
Name-only reference instead requires the actual nonempty bundled `Assets.car`.
CI retains native catalog diagnostics at fixed app paths with step deadlines;
there is no arbitrary output-byte cap. Catalog existence alone is not icon
acceptance: the real out-of-process UIKit roundtrip, native current readback,
relaunch persistence and Default restoration remain hard gates. No ad-hoc
rendition-parser script or parallel test framework is added.

Run 40211520800 also failed the separate Mosh hosted navigation readiness check,
then attempted IPC despite that failure and saw an undefined JavaScript bridge.
That follow-on exception does not establish another native command defect. The
hosted tests now record only native view-presence/loading/visibility and a bounded
URL scheme, then stop on failed readiness before invoking. The existing 30-second
readiness deadline is unchanged. No valid UI icon roundtrip ran in that workflow;
it remains a separate pending gate.

[Run 40215610334](https://github.com/mihazs/lazysh/actions/runs/40215610334),
head `3ffe16a`, reproduced the compiled phone/pad opaque catalog renditions in
[artifact 12608285803](https://github.com/mihazs/lazysh/actions/runs/40215610334/artifacts/12608285803)
and passed raw native Mosh unit/protocol interoperability. Hosted icon acceptance
failed before status preflight: the first effective `CFBundleIcons` declaration
passed, but requesting the literal `CFBundleIcons~ipad` through Bundle returned
nil. The raw compiled plist retained both declarations. UI acceptance was skipped.

Apple documents [device-qualified key selection](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/AboutInformationPropertyListFiles.html#//apple_ref/doc/uid/20001431-111453):
Bundle chooses the value for the current device. Production now queries the
effective base icon key once, preserving actual UIKit support/current readback.
The native resource test instead reads the fixed bundled `Info.plist` with a
256 KiB bound and validates both literal phone and pad declarations independently.
This corrects API usage without dropping either declaration assertion. Actual
phone UIKit roundtrip remains pending; no iPad UI execution is claimed.

The corrected lookup run [40217999219](https://github.com/mihazs/lazysh/actions/runs/40217999219),
head `e3d71cb`, passed hosted compiled-resource, native icon status and invalid-input
checks. Its actual UI roundtrip failed before selection: the supported-current
predicate expected a combined static text label, but retained native accessibility
trees contain adjacent `Current icon:` and `Default` StaticText elements. This
establishes rendered native readback, not a failed status request or a successful
setter. [Artifact 12609107625](https://github.com/mihazs/lazysh/actions/runs/40217999219/artifacts/12609107625)
retains that distinction. The paragraph now emits one coherent text node and the
UI test stops after a failed predicate rather than querying a missing element.
Full actual current-label and restore assertions remain unchanged.

Main's merged resume protection is integrated: icon requests use the mounted
view's original protected invoke lease, native commands wrap results/errors in
`AccessLease.run`, and stale completion/error/finally callbacks cannot update a
new view. Hosted icon tests capture one original initialized, unlocked lease
inside the page, acknowledge native readiness, and never project its nonce or
retry a protected request with a new nonce. The icon UI runner uses main's
separate-app logging marker. A UIKit icon mutation already dispatched to the OS
cannot be recalled on lock; its stale result is rejected, and it grants no access
to protected data or lock-policy changes. New integrated native execution remains
required. Physical iPhone/iPad Home Screen acceptance is still unexecuted.

Focused same-mount regressions rotate lock/unlock before settling an old success
or error, assert no stale repaint/error/refresh, then verify a new mount can read
and change normally. Temporarily removing only the original-lease condition from
the result guard made both regressions fail on a stale error alert; restoring it
passed all 23 focused access/shell/icon/preferences tests. No mutation remains.

A pending native mutation also needs a safe concurrent status path. The retained
LaunchServices stack from run 40208351521 shows actual `alternateIconName` readback
waiting behind the mutation queue. Source review found status and a second setter
could make that same getter call while the controller already owned a mutation.
The controller now returns unavailable/unknown with an in-progress explanation
before querying UIKit, and rejects a concurrent valid setter before any status
read. Completion still clears the busy state and queries actual UIKit readback;
there is no cached or optimistic success. The native getter-count regression is
pending execution on an Apple runner; source inspection is not a passing test.

[Integrated run 40220503048](https://github.com/mihazs/lazysh/actions/runs/40220503048),
head `25f55bf`, retained both literal compiled declarations and completed native
navigation, then failed the new hosted access-preparation fixture before icon
status was requested (`access-prepared.received=false`). UI acceptance was
skipped. The fixture incorrectly required a nonce even for a clean disabled
policy: current native authority explicitly permits an absent nonce in that
state, and the frontend captures an empty header there. The fixture now accepts
absence only after confirming initialized, unlocked and disabled state, rejects
any malformed present nonce, and retains the original header once. It never
refreshes or retries protected requests. This is a test contract correction,
not evidence that icon IPC or the valid UIKit roundtrip passed. Raw Mosh also
failed its separate empty-output standalone `--list` 45-second startup deadline;
no target stack established its cause. [Artifact 12610047306](https://github.com/mihazs/lazysh/actions/runs/40220503048/artifacts/12610047306)
retains the hosted failure. Fresh integrated native execution remains required.

[Run 40223058310](https://github.com/mihazs/lazysh/actions/runs/40223058310),
head `5a2b058`, passed all four named native icon controller tests, including
`testPendingMutationDoesNotQueryLaunchServicesBeforeCompletion`, plus raw Mosh and
protected hosted resource/status/invalid-input acceptance. Retained stages confirm initialized
access prepared and real native status `available=true`, `current=default`.
UI still failed before any setter: the combined Current icon label now existed,
but the selector query expected Button/PopUpButton. The retained WebKit AX tree
instead exposes `Other`, label `Home Screen icon`, value `Default`, at y=-115;
Apply is also offscreen at y=-72. [Artifact 12611121995](https://github.com/mihazs/lazysh/actions/runs/40223058310/artifacts/12611121995)
retains these exact stages. The UI test now queries the observed selector type
and uses at most four real swipes to reveal both selector and Apply, requiring
actual hitability/enabled state before touch. It stops on failed assertions.
Native wheel/menu handling, actual current readback, relaunch and restoration
remain unchanged. No valid UIKit setter or roundtrip success is claimed yet.
Latest main's Grok record status and Mosh recovery tests are merged normally;
new exact-head native execution remains required.

[Run 40225635475](https://github.com/mihazs/lazysh/actions/runs/40225635475),
exact head `4ed0503`, passed the actual iPhone simulator acceptance:
`testActualHomeScreenIconRoundtripAndRelaunch` passed in 78.764 seconds. Retained
UI attachments record Amber native readback at 38.90 seconds, Amber after full
terminate/relaunch at 63.86 seconds, and restored Default at 77.32 seconds.
The first Amber and final Default screenshots visibly show the actual Current
icon text. The post-relaunch screenshot is scrolled below that text; persistence
is established by the native label assertion and passing test, not screenshot
visibility. [Artifact 12612302391](https://github.com/mihazs/lazysh/actions/runs/40225635475/artifacts/12612302391)
retains the results. All four native icon controller tests, protected hosted
resource/status/invalid-input checks, raw Mosh and workspace Save/relaunch/Delete
also passed. This establishes supported iPhone simulator behavior on this exact
head. Physical iPhone/iPad Home Screen appearance and iPad UI mutation remain
unexecuted; both compiled idiom resources are independently verified.

Latest main's timed chord queue and native recovery checks are merged normally
after retaining that successful icon run. The integrated head requires fresh
CI; prior exact-head evidence is not relabeled as execution of the new merge.

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

References: [Moshi personalization](https://getmoshi.app/docs/personalization),
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

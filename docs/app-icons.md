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
`AppIconIntegrationTests` in the existing hosted iOS app test target. A separate hosted roundtrip applies Amber through native IPC, checks UIKit directly,
restores Default and always attempts cleanup to the original icon. Unsupported
simulators fail this acceptance test explicitly instead of passing it. State tests
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

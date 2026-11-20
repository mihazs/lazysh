---
"@lazysh/agent": patch
---

fix(ios): send taps, swipes and button presses to an iOS Simulator through idb

idb 1.7.8 rejects a top-level `tap`, `swipe` or `button` (`invalid choice`) because they are `idb ui` subcommands, so no input ever reached a Simulator (#1731, part of #19). The optional idb controls now run `idb ui tap`, `idb ui swipe` and `idb ui button`.

A real run on a hosted macOS runner (Xcode 26.6, an iOS 26.5 Simulator, idb 1.7.8) verified the companion identity in screen points, a continuous video preview, a tap at a point read from the Simulator's own accessibility frame, an edge swipe, Home and the hardware buttons, and shutdown and boot by UUID. The new non-required `ios-idb-acceptance` workflow repeats that run; the versions and limits are in [the device acceptance record](docs/reference/devices-acceptance.md#ios-simulator-idb-acceptance).

`simctl shutdown` can outlast the companion's ten-second command limit (7 to 66 seconds, tracked in #1911), and `idb ui describe-all` fails on the home screen, so no iOS accessibility tree is added. Needs the updated host companion on the Mac. No defaults change.

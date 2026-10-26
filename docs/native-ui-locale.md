# Native interface language

The app language selector supports System, English, Português (Brasil) and
Español. Android, iOS and macOS store the choice natively so the first privacy
cover can use it before the WebView starts. Windows, Linux and browser builds
retain frontend preference storage because they have no native biometric cover.

On supported platforms the frontend reads the native choice at startup; it never
pushes an old browser preference into the native store. Explicit language changes
are required to migrate a previous browser-only choice: a missing native choice
defaults to System on the first upgraded launch. Subsequent explicit changes
are serialized and use the last native revision. The native setter persists the
choice before the frontend mirrors it. A conflicting or failed write requires a
new language check rather than an automatic retry. Ordinary font, theme and other
preference updates preserve the native-owned language, even when their captured
preference object is older.

Android preference inspection and persistence run on one bounded worker queue.
Cover and prompt labels use the last inspected snapshot without waiting for a
slow preference commit; completion refreshes labels on the UI thread. A dropped
caller does not release an admitted write or cause automatic replay.

Reset preferences explicitly selects System through the same native setter.
Reviewed settings imports change language only when the imported object explicitly
contains `uiLanguage`; older imports preserve the current choice. A view disposed
before its queued action starts cannot submit that action. An already-admitted
native cosmetic write may finish after the view closes; subsequent reads reconcile
the actual choice. A later settings-storage failure is reported separately from
a native language failure; a confirmed read clears the language retry error.

System follows the first supported OS language among the first sixteen preferences.
Portuguese variants use Brazilian Portuguese; English and Spanish retain their
regional tags for display formatting. Unsupported languages fall back to English.
This does not change the OS language or the language selected by the OS for its
permission explanations and system authentication controls.

Native cover titles, instructions, unlock buttons and failure notices update
without rebuilding the cover, changing its access generation, hiding an existing
failure, or cancelling authentication. New biometric prompts use the current
app-owned reason; a prompt already on screen keeps the language it had when it
was created. Android uses an isolated localized configuration context; Apple
uses the main application's explicit `.lproj/NativeUI.strings` resources. Missing
or unreadable native cosmetic preferences keep a safe English native presentation.
The frontend displays an error and offers retry without writing a guessed choice
or holding authentication readiness indefinitely. Corrupt stored values remain an
explicit error; they are not silently replaced.

A cosmetic getter has a five-second availability deadline; a late read cannot
replace a newer snapshot. A slow setter also shows an error after five seconds,
but retains mutation ownership until the native result is known. New changes are
rejected while that write is unsettled, and queued intent is not replayed after
the watchdog fires. Retry is disabled and read attempts fail promptly while the
owned write is still finishing; the interface explains to wait or restart rather
than queueing an unbounded retry behind it. These cosmetic
deadlines do not change authentication budgets or cancel an admitted native write.

The two native locale commands accept only a finite choice and bounded revision.
They are available while locked and do not read credentials, authenticate, change
resume policy, advance access epochs, or publish terminal output.

Validation uses Vitest and Playwright for bootstrap, stale preferences, queued
changes, reset/import and retry; Gradle/JUnit and instrumentation for Android;
Foundation/UIKit XCTest plus hosted app resource checks for Apple; and Rust tests
for typed boundaries and the locked-command allowlist. Emulator/simulator and
physical authentication acceptance must be reported separately from compilation.

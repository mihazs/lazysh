# Write and run Appium tests

Steps for the Appium and WebdriverIO suite that drives the packaged Android app. The decisions are in
[ADR 0002](../architecture/adr-0002-appium-webdriverio-android-e2e.md) and the lookup tables in the
[conventions reference](../reference/mobile-e2e-conventions.md). The suite is part of
[epic #1396](https://github.com/mihazs/lazysh/issues/1396); its layout and commands are in `apps/client/mobile-e2e/README.md`.

## Decide whether the test belongs here

Reproduce the defect at the lowest layer that can fail first: Vitest, then Playwright, then an Android instrumented test. Add
an Appium test only when the defect needs the real packaged app on Android (system gestures, a real input method, WebView
layout with the keyboard, runtime permission dialogs, notifications, journeys across the native and WebView contexts). See
[Where a test belongs](../reference/mobile-e2e-conventions.md#where-a-test-belongs).

## Run on a local Waydroid guest or emulator

1. Start the guest and connect `adb`. For the shared Waydroid guest this is the network address from the local procedure
   (`adb connect 192.168.240.112:5555`); for an emulator it is `emulator-5554`. Export it:
   `export ANDROID_SERIAL=<serial>`.
2. Build the x86_64 debug APK from a clean worktree of `origin/main` (about ten minutes):
   `bun run build:android:emulator`. The APK is under
   `apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug`. Published release APKs are arm64-only and do
   not run on an x86_64 guest.
3. Export the Android SDK and install the pinned Appium driver once:
   `export ANDROID_HOME=<android sdk>` and `bun run --cwd apps/client mobile-e2e:setup`. The second command installs
   UiAutomator2 8.7.3 into the git-ignored `apps/client/mobile-e2e/.appium`. Do not install Appium globally or with `sudo`.
4. Run:

   ```sh
   LAZYSH_E2E_APK=<path to the debug apk> bun run test:mobile-e2e                 # smoke + regression
   bun run --cwd apps/client mobile-e2e -- --suite smoke
   bun run --cwd apps/client mobile-e2e -- --spec mobile-e2e/specs/smoke/launch.e2e.ts
   bun run --cwd apps/client mobile-e2e -- --mochaOpts.grep '@flaky' --mochaOpts.invert
   ```

   With `LAZYSH_E2E_APK` set, `JAVA_HOME` must point at a JDK (Appium verifies the signature). Without it the build already installed on the guest is tested. Every spec file starts with the app's data
   cleared, so hosts configured by hand on a shared guest are lost. Check without a device with `mobile-e2e:check`,
   `mobile-e2e:lint` and `mobile-e2e:unit` (moon: `client:check-mobile-e2e`, `client:lint-mobile-e2e`,
   `client:test-mobile-e2e-unit`).

Specs that need a host call `connectOwnedHost()` (`pageobjects/connect-owned-host.ts`) in a `before` hook and `resetApp()` in
`after`. It adds a host named `e2e-<run nonce>-<label>` through the real editor, signs in with the fixture's generated key
(pasted from the clipboard) and trusts the fingerprint only when it equals the generated one. The launcher starts the owned hosts
and forwards their ports with `adb reverse`; `LAZYSH_E2E_HOSTS=ssh,herdr,tmux` selects them (see the
[README](../../apps/client/mobile-e2e/README.md)). The live `HERDR_*` and `TMUX*` variables are removed from the launcher while
the fixtures run, so no child can reach a personal Herdr or tmux.

The shared guest may be in use by another run. The suite takes an advisory lock per serial and waits for it for 10 minutes
(`LAZYSH_E2E_LOCK_TIMEOUT_S`); if the holder is still there it ends the whole run at once, non-zero, naming the holder's pid and
age, and starts no worker. It records window size, density,
navigation mode, IME and animation scale before it starts, and restores them at the end, including after a failure. If you
change any of them by hand while debugging, restore them (`wm size reset`, `wm density reset`) before the next run. The
fixtures start their own SSH, Herdr and tmux servers on private sockets; never point a test at a personal Herdr or tmux, and
never run `herdr server stop`, `kill` or `tmux kill-server` against a process you did not start.

## Write a test

1. Pick the tier directory: `smoke/` (one of the ten critical journeys), `regression/<area>/` (one bug) or `journeys/`.
2. Add or reuse a page object under `pageobjects/`. It extends `Page`, names its context, returns lazy elements from
   getters, offers user actions, has no assertions, and the file exports one instance.

   ```ts
   // pageobjects/home.page.ts
   import { $ } from '@wdio/globals';
   import Page from './page';

   class HomePage extends Page {
     readonly context = 'WEBVIEW' as const;
     get root() { return $('aria/Add your first host'); }
     async openHostEditor() { await this.tap(() => this.root); }
   }
   export default new HomePage();
   ```

3. Write the spec as one behaviour per `it`, asserting with the auto-retrying matchers inside `page.in(...)`, which switches
   to the page's context and back:

   ```ts
   // specs/smoke/launch.e2e.ts
   import { expect } from '@wdio/globals';
   import Home from '../../pageobjects/home.page';

   describe('Launch', () => {
     it('reaches the empty home with an invitation to add the first host', async () => {
       await Home.in(() => expect(Home.root).toBeDisplayed());
     });
   });
   ```

   Create elements inside `page.in(...)` or a page object action: `$()` starts resolving when it is called, so an element
   made before the context switch is looked up in the previous context (an `aria/` lookup in `NATIVE_APP` fails with an
   XPath error). Page object actions take a thunk for this reason (`this.tap(() => this.root)`).
4. Close the soft keyboard with `closeKeyboard()` before tapping a button: a tap that arrives while the keyboard resizes the
   page is lost, and `browser.hideKeyboard()` presses Back and closes the dialog.
5. Never sleep. Use `await expect(el).toBeDisplayed()` or `browser.waitUntil(cond, {timeout, timeoutMsg})`; `browser.pause`
   throws.
6. Keep the test independent: create hosts through the fixture (they get a per-run name and `resetApp()` removes them), do not
   rely on another test having run, and change device state only through `support/device.ts`.
7. If the UI has no unique accessible name for an element, add `data-testid="area-element"` in the component (kebab-case) in
   the same pull request, and keep the Playwright locators unchanged.

## Add a regression test for a bug

1. Reproduce the bug at the lowest layer that can fail. Run the new test on the parent of the fix and keep the failing
   output; it goes in the pull request.
2. Name the file `<issue>-<behaviour>.e2e.ts` under `regression/<area>/` for a device-only defect; for a lower layer, follow
   that layer's naming and put the issue number in the test title.
3. Add a row to [`docs/regression-tests.md`](../regression-tests.md) in the same pull request: bug, symptom, fixing PR, layer,
   test path and title, status. A device-only defect whose Appium test needs fixtures that do not exist yet gets status
   `pending` and a linked follow-up issue; the bug issue stays open until the row is `active`.
4. Tick the regression-test box in the pull request template (added by the process issue).

## Debug a failure

- The spec reporter names the test and the context it failed in. Failure artifacts are in
  `apps/client/mobile-e2e/reports/artifacts/<spec>/<test>/`: native and WebView screenshots, page sources, a `logcat` tail and
  the tail of the Appium log. No screenshot or page source is taken while a private key or password is on screen.
- A WebView `session not created` or `chrome not reachable` error usually means ChromeDriver does not match the guest
  WebView or the build is not debuggable. Check `adb shell cat /proc/net/unix | grep webview_devtools_remote` and that
  `reports/wdio-appium.log` shows the matching ChromeDriver download.
- For a selector problem, list the contexts and dump the page source from a short script, or use Appium Inspector against the
  same server and serial. Fix the selector, not the timeout.

## Quarantine a flaky test

1. Reproduce the flake by running the spec repeatedly in isolation; do not widen a timeout to hide it.
2. If it cannot be fixed the same day, add `@flaky` to the `describe` title, link an issue in a comment above it, and note it
   in the index row. It then runs only in the non-gating quarantine run.
3. At most five tests may be quarantined and none for more than 14 days; then fix, move the check to a lower layer or delete
   it with a note in the index.

## In CI

The path-filtered job (CI issue) runs `smoke` and `regression` on pull requests and everything on `main`, uploads
`reports/junit/` and `reports/artifacts/`, and lists any spec that passed only on its retry in the job summary. Open or update
a flaky-test issue for each one the same day.

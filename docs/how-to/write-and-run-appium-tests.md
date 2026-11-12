# Write and run Appium tests

Steps for the Appium and WebdriverIO suite that drives the packaged Android app. The decisions are in
[ADR 0002](../architecture/adr-0002-appium-webdriverio-android-e2e.md) and the lookup tables in the
[conventions reference](../reference/mobile-e2e-conventions.md). Commands marked **(scaffold)** are created by the scaffold
issue of [epic #1396](https://github.com/mihazs/lazysh/issues/1396); their names are fixed there, and this page is updated in
the same pull request.

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
3. Install the pinned Appium driver once **(scaffold)**: `bun run --cwd apps/client mobile-e2e:setup`. It installs
   UiAutomator2 8.7.3 into a git-ignored `APPIUM_HOME`. Do not install Appium globally or with `sudo`.
4. Run **(scaffold)**:

   ```sh
   LAZYSH_E2E_APK=<path to the debug apk> bun run test:mobile-e2e                 # smoke + regression
   bun run --cwd apps/client mobile-e2e -- --suite smoke
   bun run --cwd apps/client mobile-e2e -- --spec specs/regression/gestures/1380-edge-swipe-vs-system-navigation.e2e.ts
   bun run --cwd apps/client mobile-e2e -- --mochaOpts.grep '@flaky' --mochaOpts.invert
   ```

The shared guest may be in use by another run. The suite takes an advisory lock per serial, records window size, density,
navigation mode, IME and animation scale before it starts, and restores them at the end, including after a failure. If you
change any of them by hand while debugging, restore them (`wm size reset`, `wm density reset`) before the next run. The
fixtures start their own SSH, Herdr and tmux servers on private sockets; never point a test at a personal Herdr or tmux, and
never run `herdr server stop`, `kill` or `tmux kill-server` against a process you did not start.

## Write a test

1. Pick the tier directory: `smoke/` (one of the ten critical journeys), `regression/<area>/` (one bug) or `journeys/`.
2. Add or reuse a page object under `pageobjects/`. Getters return lazy elements, methods are user actions, there are no
   assertions in page objects, and the file exports one instance.

   ```ts
   // pageobjects/components/side-menu.component.ts
   import { $ } from '@wdio/globals';
   import { inWebView } from '../../support/contexts';

   class SideMenuComponent {
     get root() { return $('[data-testid="side-menu"]'); }
     async open() { await inWebView(() => edgeSwipe('left')); }
   }
   export default new SideMenuComponent();
   ```

3. Write the spec as one behaviour per `it`, asserting with the auto-retrying matchers:

   ```ts
   // specs/smoke/side-menu.e2e.ts
   import { expect } from '@wdio/globals';
   import SideMenu from '../../pageobjects/components/side-menu.component';

   describe('Side menu', () => {
     it('opens from the left edge of a connected session', async () => {
       await SideMenu.open();
       await expect(SideMenu.root).toBeDisplayed();
     });
   });
   ```

4. Never sleep. Use `await expect(el).toBeDisplayed()` or `browser.waitUntil(cond, {timeout, timeoutMsg})`; `browser.pause`
   throws.
5. Keep the test independent: create hosts through the fixture (they get a per-run name and are removed afterwards), do not
   rely on another test having run, and change device state only through `support/device.ts`.
6. If the UI has no unique accessible name for an element, add `data-testid="area-element"` in the component (kebab-case) in
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
  the Appium log. No screenshot is taken while a private key or password is on screen.
- A WebView `session not created` or `chrome not reachable` error usually means ChromeDriver does not match the guest
  WebView or the build is not debuggable. Check `adb shell cat /proc/net/unix | grep webview_devtools_remote` and that
  `reports/appium.log` shows the matching ChromeDriver download.
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

# Mobile end-to-end conventions

Lookup tables for the Appium and WebdriverIO suite that drives the packaged Android app. The reasons are in
[ADR 0002](../architecture/adr-0002-appium-webdriverio-android-e2e.md); the task steps are in
[Write and run Appium tests](../how-to/write-and-run-appium-tests.md). Paths below are the target layout created by the
scaffold issue; until it merges only the conventions apply.

## Versions

| Piece | Pin | Source of the choice |
| --- | --- | --- |
| `webdriverio`, `@wdio/cli`, `@wdio/local-runner`, `@wdio/mocha-framework`, `@wdio/spec-reporter`, `@wdio/junit-reporter`, `@wdio/appium-service`, `@wdio/globals` | one exact version, 10.1.0 today (the version `apps/client` already pins; `webdriverio` and the `@wdio/*` packages are published at 10.1.0 and 10.2.0) | WebdriverIO packages must move together |
| Appium | 3.9.0 | `@wdio/appium-service` needs Appium 3; 3.9.0 is `latest` |
| `appium-uiautomator2-driver` | 8.7.3 | 9.x peers on Appium 4 beta; 8.x peers on `^3.0.0-rc.2` |
| Node | 24 (`.prototools`) | Appium 3 needs `^20.19 \|\| ^22.12 \|\| >=24` |
| Android guest | API 36 x86_64 `default` image (CI), Android 13 x86_64 Waydroid (local) | [Android testing](../android-testing.md), ai-memory `procedures/waydroid-android-testing` |

## Directory layout

```
apps/client/mobile-e2e/
  wdio.conf.ts              shared: Mocha, reporters, timeouts, hooks, the browser.pause guard
  wdio.android.conf.ts      merges wdio.conf.ts; Appium service, UiAutomator2 capabilities, suites
  tsconfig.json             extends ../tsconfig.json; types node, @wdio/globals, expect-webdriverio, Mocha
  specs/
    smoke/                  <=10 critical journeys, gate every PR
    regression/<area>/      one file per bug: <issue>-<behaviour>.e2e.ts
    journeys/               long multi-step flows, run on main and nightly
  pageobjects/
    page.ts                 base class: context switch, open, wait helpers
    <name>.page.ts          a screen or panel
    components/<name>.component.ts   reusable parts (side menu, toolbar, composer)
  support/
    device.ts               adb access, per-serial lock, baseline capture and restore
    contexts.ts             NATIVE_APP <-> app WebView switch
    gestures.ts             W3C pointer actions, edge swipes
    hosts.ts                owned SSH, Herdr and tmux endpoints from tests/support
    artifacts.ts            failure screenshots, page source, logcat tail
  data/                     static, deterministic inputs (no secrets, no keys)
  reports/                  generated; git-ignored (junit/, artifacts/, appium.log)
```

`e2e/` stays Playwright and `native-e2e/` stays the desktop suite. Nothing in `mobile-e2e/` imports from them; shared
fixtures come from `tests/support/`.

## Naming

| Thing | Convention | Example |
| --- | --- | --- |
| Spec file | `kebab-case.e2e.ts`; regression files start with the bug issue number | `regression/gestures/1380-edge-swipe-vs-system-navigation.e2e.ts` |
| `describe` | the feature or the bug, with the issue for regressions | `describe('#1380 edge swipes beside Android navigation', ...)` |
| `it` | an observable behaviour sentence: subject, behaviour, condition; no `test1`, no "should work" | `it('opens the side menu from the left handle and not from a system back swipe', ...)` |
| Page object | `<Name>.page.ts` / `<Name>.component.ts`; class `SideMenuComponent`; default export of one instance | `export default new SideMenuComponent()` |
| Support module | a noun | `device.ts`, `contexts.ts` |
| Test id | `data-testid="area-element"`, kebab-case, only where no unique accessible name exists | `toolbar-page-dots` |
| Tag | `@flaky`, `@emulator-only`, `@slow` in the `describe` title; the tier is the directory | `describe('... @emulator-only', ...)` |

Structure each test as Arrange, Act, Assert ([Given-When-Then](https://martinfowler.com/bliki/GivenWhenThen.html) is the
same three steps). One reason to fail per test, no conditionals in the body, no dependence on another test.

## Selectors

| Context | Order | Never |
| --- | --- | --- |
| `NATIVE_APP` | `~accessibility id` (content-desc), `id=` resource id, `android=new UiSelector()...` | XPath, index-based picks |
| App WebView | `aria/<accessible name>` or role-and-name, then `[data-testid="..."]` | CSS classes, tag chains, `nth-child` of layout wrappers |
| Text | last resort, and only in the pinned `en-US` locale | text in a localized string without pinning the locale |

`$` is strict in WebdriverIO 10 and throws on more than one match; fix the selector, do not take `$$[0]`.

## Waiting

| Need | Use |
| --- | --- |
| Element state | `await expect(el).toBeDisplayed()` and the other auto-retrying matchers |
| A custom condition | `await browser.waitUntil(cond, {timeout, timeoutMsg})` |
| Anything fixed-time | not allowed; `browser.pause` throws in the `before` hook |

| Setting | Value | Why |
| --- | --- | --- |
| `waitforTimeout` / `waitforInterval` | 10 s / 250 ms | expect-webdriverio and `waitFor*` default |
| Mocha `timeout` | 120 s per test | connect plus terminal round trip on a cold emulator |
| `mochaOpts.retries` | 0 | a retry hides a real defect |
| `specFileRetries` (CI only) | 1, `specFileRetriesDeferred: true` | fresh session; passing on retry is reported as flaky |
| `connectionRetryTimeout` | 180 s | first UiAutomator2 server install |
| `appiumStartTimeout` | 60 s | cold `appium` start |
| `maxInstances` | 1 | one device, one session |

## Capabilities

| Capability | Value | Note |
| --- | --- | --- |
| `platformName`, `appium:automationName` | `Android`, `UiAutomator2` | |
| `appium:udid` | `ANDROID_SERIAL` | `emulator-5554` in CI, `192.168.240.112:5555` on Waydroid |
| `appium:app` | `LAZYSH_E2E_APK` (x86_64 debug APK) | omit to test the installed build |
| `appium:appPackage`, `appium:appActivity` | `app.lazysh.client`, `.MainActivity` | |
| `appium:noReset` | `false` | app data cleared per session, no uninstall |
| `appium:autoGrantPermissions` | `false` | permission tests need the real dialog |
| `appium:language`, `appium:locale` | `en`, `US` | localized UI; selectors assume English |
| `appium:disableWindowAnimation` | `true` | removes animation timing from assertions |
| `appium:newCommandTimeout` | 120 | |
| `appium:uiautomator2ServerLaunchTimeout` | 120000 | |
| `appium:ensureWebviewsHavePages` | `true` | the WebView context has a page before the switch |
| `appium:chromedriverExecutableDir` | cached directory | filled by `uiautomator2:chromedriver_autodownload` |

The server runs with `--allow-insecure=uiautomator2:chromedriver_autodownload` only. Appium 3 rejects an unscoped feature name.
`adb_shell` stays off; device changes go through `support/device.ts`.

## Reporters and artifacts

| Output | Where | Notes |
| --- | --- | --- |
| Console | `spec` reporter | always |
| JUnit XML | `reports/junit/` | CI uploads it; one file per spec |
| Failure artifacts | `reports/artifacts/<spec>/<test>/` | screenshots (native and WebView), page sources, `logcat` tail, Appium log |
| Suppression | none while a key or password is visible | same rule as [Native GUI testing](../native-gui-testing.md) |

## Isolation and device state

| State | Rule |
| --- | --- |
| App data | cleared at session start (`noReset: false`); one session per spec file |
| Hosts | created per test with a per-run nonce name, removed in `afterEach` |
| Window size, density, navigation mode, IME, animations, rotation, permissions | change only through `support/device.ts`; baseline recorded, restored in `after` even on failure |
| Shared device | advisory lock per serial; a second run waits and prints the owner, it does not interleave |
| Owned hosts | `SshFixture`, `HerdrFixture`, `TmuxFixture` from `tests/support`; never a personal Herdr, tmux or SSH server |
| Endpoints and keys | mode-0600 file under the run directory, never committed, never logged |

## Where a test belongs

Pick the lowest layer that can fail on the defect ([Android strategy](https://developer.android.com/training/testing/fundamentals/strategies),
[Test Pyramid](https://martinfowler.com/bliki/TestPyramid.html)).

| Layer | Runner and location | Owns | Example |
| --- | --- | --- | --- |
| Unit and component | Vitest, `apps/client/src/**/*.test.*`, Rust `cargo test` | pure logic, reducers, parsers, one component's DOM | Herdr touch-scroll fallback in `TerminalPane.test.tsx` |
| Web behaviour | Playwright, `apps/client/e2e` (`desktop` and `phone` projects) | layout, touch emulation, i18n, state in a real browser engine with a mocked bridge | `terminal-swiftkey.spec.ts` composition transactions |
| Android native | Instrumented, `gen/android/.../androidTest` | Kotlin plugins and APIs only reachable in-process: insets, clipboard, foreground service, biometrics | `NativeEdgeGestureExclusionTest` |
| Device end to end | Appium + WebdriverIO, `apps/client/mobile-e2e` | what needs the real packaged app on Android: system gestures against app handles, a real IME, WebView layout with the keyboard, runtime permission dialogs, the notification shade, journeys across both contexts | `#1380` both navigation modes |
| Desktop end to end | `tauri-driver`, `apps/client/native-e2e` | the Linux desktop singleton and native IPC | `singleton.spec.ts` |

Rules: do not add an Appium test for logic a lower layer can assert; do not mock the bridge or the vault in Appium; keep
`smoke/` at ten tests or fewer. A bug found at a high layer is first reproduced at the lowest layer that can fail, and kept at
the device layer only if no lower layer can.

## Flake quarantine

| Rule | Value |
| --- | --- |
| Marker | `@flaky` in the `describe` title plus a linked issue in the title comment |
| Run | excluded from the gating run (`--mochaOpts.grep @flaky --mochaOpts.invert`); run by the non-gating quarantine run (`--mochaOpts.grep @flaky`) |
| Cap | five tests at once |
| Age | 14 days, then fix, rewrite at a lower layer or delete with a note in the regression index |
| Detection | a spec that passes only on its CI retry is listed in the job summary; open or update the issue the same day |

## CI

| Item | Value |
| --- | --- |
| Trigger | `.github/scripts/native-changes.sh` adds an `android_appium` output for client, Android, `mobile-e2e` and shared fixture paths |
| Runner | the `mihazs/lazysh-android-emulator-runner` API 36 x86_64 setup used by `native-android-runtime` |
| Tiers | pull request: `smoke` and `regression`; `main` and nightly: plus `journeys` and the quarantine run |
| Sharding | `wdio run --shard x/y`, a matrix of jobs (one emulator each), added when wall time passes 25 minutes |
| Artifacts | `reports/junit/` and `reports/artifacts/` upload on every run |
| Gating | report-only first; required after 20 consecutive green runs on `main` (a maintainer sets the ruleset) |

## Sources

[Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/) ·
[WebdriverIO best practices](https://webdriver.io/docs/bestpractices) ·
[page objects](https://webdriver.io/docs/pageobjects) ·
[selectors](https://webdriver.io/docs/selectors) ·
[frameworks](https://webdriver.io/docs/frameworks) ·
[organizing suites](https://webdriver.io/docs/organizingsuites) ·
[Appium service](https://webdriver.io/docs/appium-service) ·
[`switchContext`](https://webdriver.io/docs/api/mobile/switchContext) ·
[UiAutomator2 hybrid apps](https://appium.github.io/appium-uiautomator2-driver/latest/guides/hybrid/) ·
[UiAutomator2 capabilities](https://appium.github.io/appium-uiautomator2-driver/latest/reference/capabilities/) ·
[`mobile:` execute methods](https://appium.github.io/appium-uiautomator2-driver/latest/reference/execute-methods/) ·
[migrating to Appium 3](https://appium.io/docs/en/latest/guides/migrating-2-to-3/) ·
[Android testing strategy](https://developer.android.com/training/testing/fundamentals/strategies) ·
[Fowler: Test Pyramid](https://martinfowler.com/bliki/TestPyramid.html), [Page Object](https://martinfowler.com/bliki/PageObject.html), [Given-When-Then](https://martinfowler.com/bliki/GivenWhenThen.html), [non-determinism](https://martinfowler.com/articles/nonDeterminism.html) ·
Google Testing Blog: [Just Say No to More End-to-End Tests](https://testing.googleblog.com/2015/04/just-say-no-to-more-end-to-end-tests.html), [Flaky Tests at Google](https://testing.googleblog.com/2016/05/flaky-tests-at-google-and-how-we.html) (statistics taken from a search summary; the fetched page held only comments) ·
[Playwright best practices](https://playwright.dev/docs/best-practices) ·
[Testing Library query priority](https://testing-library.com/docs/queries/about/#priority).

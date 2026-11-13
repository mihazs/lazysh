# Mobile end-to-end suite (Appium + WebdriverIO)

Drives the packaged Android app through its native layer and its WebView. Decisions are in
[ADR 0002](../../../docs/architecture/adr-0002-appium-webdriverio-android-e2e.md), the lookup tables in the
[conventions reference](../../../docs/reference/mobile-e2e-conventions.md) and the steps in
[Write and run Appium tests](../../../docs/how-to/write-and-run-appium-tests.md).

```
wdio.conf.ts          shared: Mocha, reporters, timeouts, the browser.pause guard, failure artifacts
wdio.android.conf.ts  Appium service, UiAutomator2 capabilities, device lock and baseline
specs/{smoke,regression,journeys}/   the tier is the directory; files are *.e2e.ts
pageobjects/          one object per screen or component, no assertions
support/              device.ts (the only module that changes device state), contexts.ts, artifacts.ts, guards.ts, setup.ts
data/                 static inputs, no secrets
reports/  .appium/    generated and git-ignored (JUnit, failure artifacts, Appium log; Appium home)
```

## Run

```sh
export ANDROID_HOME=<android sdk> ANDROID_SERIAL=<adb serial>     # both required; the serial is never guessed
bun run --cwd apps/client mobile-e2e:setup                         # once: pinned UiAutomator2 driver into .appium
LAZYSH_E2E_APK=<x86_64 debug apk> bun run test:mobile-e2e         # omit the variable to test the installed build
bun run --cwd apps/client mobile-e2e -- --suite smoke
```

The run clears the app's data at the start of every spec file (`appium:noReset: false`). It takes an advisory lock for the
serial, records window size, density, navigation mode, IME, animation scale, rotation and the app's runtime permissions, and
restores them after each spec file and at the end. After a crashed run the next one refuses until you restore the device
or set `LAZYSH_E2E_RECOVER=1`. Set `LAZYSH_E2E_CHROMEDRIVER` to pin a ChromeDriver instead of the automatic download, and `LAZYSH_E2E_APPIUM_PORT` when port 4723 is taken.

## Select what runs

`LAZYSH_E2E_TIERS` (`smoke,regression` by default, add `journeys`), `LAZYSH_E2E_FLAKY` (`exclude` leaves out `@flaky` tests, `only` runs just those)
and `LAZYSH_E2E_SHARD` (`x/y`, one-based) choose a run; `bun run test:mobile-e2e:ci` is the CI entry point and sets nothing itself. With `CI` set a
failed spec file is retried once in a fresh session and, if that passes, listed as flaky in the GitHub job summary. The emulator job is described in
[Android instrumentation](../../../docs/android-testing.md#appium-suite-in-ci-1412).

## Check without a device

```sh
bun run --cwd apps/client mobile-e2e:check   # strict tsc for the suite and for the Bun unit tests
bun run --cwd apps/client mobile-e2e:lint    # typescript-eslint no-floating-promises + eslint-plugin-wdio, this directory only
bun run --cwd apps/client mobile-e2e:unit    # device lock, baseline and restore against a fake adb
```

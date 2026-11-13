# Mobile end-to-end suite (Appium + WebdriverIO)

Drives the packaged Android app through its native layer and its WebView. Decisions are in
[ADR 0002](../../../docs/architecture/adr-0002-appium-webdriverio-android-e2e.md), the lookup tables in the
[conventions reference](../../../docs/reference/mobile-e2e-conventions.md) and the steps in
[Write and run Appium tests](../../../docs/how-to/write-and-run-appium-tests.md).

```
wdio.conf.ts          shared: Mocha, reporters, timeouts, the browser.pause guard, failure artifacts
wdio.android.conf.ts  Appium service, UiAutomator2 capabilities, device lock and baseline
specs/{smoke,regression,journeys}/   the tier is the directory; files are *.e2e.ts
pageobjects/          one object per screen or component, no assertions; connect-owned-host.ts signs in for `before` hooks
support/              device.ts (the only module that changes device state), hosts.ts (owned hosts), app.ts (lifecycle),
                      contexts.ts, artifacts.ts, guards.ts, data.ts, setup.ts
data/                 static inputs with a {nonce} placeholder, no secrets, no keys
reports/  .appium/    generated and git-ignored (JUnit, failure artifacts, Appium log; Appium home)
```

## Run

```sh
export ANDROID_HOME=<android sdk> ANDROID_SERIAL=<adb serial>     # both required; the serial is never guessed
bun run --cwd apps/client mobile-e2e:setup                         # once: pinned UiAutomator2 driver into .appium
LAZYSH_E2E_APK=<x86_64 debug apk> bun run test:mobile-e2e         # needs JAVA_HOME; omit the variable to test the installed build
bun run --cwd apps/client mobile-e2e -- --suite smoke
```

Before the first spec the launcher starts owned hosts from `tests/support` and forwards their ports to the guest with
`adb reverse` (pinned to the serial, removed afterwards). `LAZYSH_E2E_HOSTS` picks them: `ssh` (default), `herdr` and `tmux`
(these need `LAZYSH_TEST_HERDR`, `LAZYSH_TEST_AGENT_BIN` and `LAZYSH_TEST_RECEIVER_BIN`, or `LAZYSH_TEST_TMUX`), or empty for
none. The endpoint, fingerprint and private key are in a mode-0600 file in a per-run mode-0700 directory
(`LAZYSH_E2E_ENDPOINTS`); they are never logged, and the Appium log filters redact clipboard content and key blocks.

The run clears the app's data at the start of every spec file (`appium:noReset: false`). It takes an advisory lock for the
serial, records window size, density, navigation mode, IME, animation scale, rotation and the app's runtime permissions, and
restores them after each spec file and at the end. After a crashed run the next one refuses until you restore the device
or set `LAZYSH_E2E_RECOVER=1`. Set `LAZYSH_E2E_CHROMEDRIVER` to pin a ChromeDriver instead of the automatic download, and `LAZYSH_E2E_APPIUM_PORT` when port 4723 is taken.

## Check without a device

```sh
bun run --cwd apps/client mobile-e2e:check   # strict tsc for the suite and for the Bun unit tests
bun run --cwd apps/client mobile-e2e:lint    # typescript-eslint no-floating-promises + eslint-plugin-wdio, this directory only
bun run --cwd apps/client mobile-e2e:unit    # device lock, baseline and restore, and the owned hosts, against a fake adb
```

import {join} from 'node:path';
import {acquireDevice, adbFor, ensurePhoneScreen, ensureThreeButtonNavigation, restoreFromJournal, type DeviceSession} from './support/device';
import {ENDPOINTS_ENV, hostKinds, startHosts, type OwnedHosts} from './support/hosts';
import {config as shared, here, reports} from './wdio.conf';

const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error('Set ANDROID_SERIAL to the one device the suite may use (adb devices); it is never guessed.');
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) throw new Error('Set ANDROID_HOME to the Android SDK: Appium needs it to find adb and build-tools.');
if (process.env.LAZYSH_E2E_APK && !process.env.JAVA_HOME) throw new Error('Set JAVA_HOME to a JDK: Appium needs it to verify the signature of LAZYSH_E2E_APK.');
// Appium and its driver live in a git-ignored home created by `bun run mobile-e2e:setup`, never in a global install.
process.env.APPIUM_HOME ??= join(here, '.appium');

const port = Number(process.env.LAZYSH_E2E_APPIUM_PORT ?? 4723); // override when another Appium already listens on 4723
const chromedriver = process.env.LAZYSH_E2E_CHROMEDRIVER;
let device: DeviceSession | undefined;
let hosts: OwnedHosts | undefined;

export const config: WebdriverIO.Config = {
  ...shared,
  port,
  services: [['appium', {
    logPath: reports,
    appiumStartTimeout: 60_000,
    // The only insecure feature: lets Appium fetch the ChromeDriver that matches the guest WebView. adb_shell stays off.
    // Redacts clipboard contents and PEM blocks, so a pasted identity never reaches the log or the artifacts.
    args: {port, allowInsecure: 'uiautomator2:chromedriver_autodownload', logFilters: join(here, 'appium-log-filters.json')},
  }]],
  capabilities: [{
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:udid': serial,
    // Without LAZYSH_E2E_APK the already installed build is tested. Every debug build has the same version code, and Appium
    // skips the install of a package that is already there unless it is told to enforce it.
    ...(process.env.LAZYSH_E2E_APK ? {'appium:app': process.env.LAZYSH_E2E_APK, 'appium:enforceAppInstall': true} : {}),
    'appium:appPackage': 'app.lazysh.client',
    'appium:appActivity': '.MainActivity',
    'appium:noReset': false,
    'appium:autoGrantPermissions': false,
    'appium:language': 'en',
    'appium:locale': 'US',
    'appium:disableWindowAnimation': true,
    'appium:newCommandTimeout': 120,
    'appium:uiautomator2ServerLaunchTimeout': 120_000,
    'appium:ensureWebviewsHavePages': true,
    ...(chromedriver ? {'appium:chromedriverExecutable': chromedriver} : {'appium:chromedriverExecutableDir': join(here, '.appium/chromedriver')}),
  }],
  onPrepare: async () => {
    device = await acquireDevice(serial, {recover: process.env.LAZYSH_E2E_RECOVER === '1'});
    // LAZYSH_E2E_HOSTS=ssh,herdr,tmux (default ssh; empty for none). Workers inherit the variables set here.
    const kinds = hostKinds();
    if (kinds.length) {
      hosts = await startHosts({adb: adbFor(serial), kinds});
      process.env[ENDPOINTS_ENV] = hosts.endpointFile;
      process.env.LAZYSH_E2E_NONCE = hosts.nonce;
    }
  },
  // Before the session starts the app, so it never sees the tablet-shaped window a Waydroid guest has or a gestural overlay left behind.
  beforeSession: async () => { await ensurePhoneScreen(adbFor(serial)); await ensureThreeButtonNavigation(adbFor(serial)); },
  // Every worker runs one spec file: put the device back to the recorded baseline between files, even after a failure.
  after: () => restoreFromJournal(serial),
  // Hosts first (their forwards and processes), then the device baseline and lock, even when the first step fails.
  onComplete: async () => {
    try { await hosts?.stop(); } finally { await device?.release(); }
  },
};

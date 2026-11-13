import {join} from 'node:path';
import {acquireDevice, restoreFromJournal, type DeviceSession} from './support/device';
import {config as shared, here, reports} from './wdio.conf';

const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error('Set ANDROID_SERIAL to the one device the suite may use (adb devices); it is never guessed.');
if (!process.env.ANDROID_HOME && !process.env.ANDROID_SDK_ROOT) throw new Error('Set ANDROID_HOME to the Android SDK: Appium needs it to find adb and build-tools.');
// Appium and its driver live in a git-ignored home created by `bun run mobile-e2e:setup`, never in a global install.
process.env.APPIUM_HOME ??= join(here, '.appium');

const port = Number(process.env.LAZYSH_E2E_APPIUM_PORT ?? 4723); // override when another Appium already listens on 4723
const chromedriver = process.env.LAZYSH_E2E_CHROMEDRIVER;
let device: DeviceSession | undefined;

export const config: WebdriverIO.Config = {
  ...shared,
  port,
  services: [['appium', {
    logPath: reports,
    appiumStartTimeout: 60_000,
    // The only insecure feature: lets Appium fetch the ChromeDriver that matches the guest WebView. adb_shell stays off.
    args: {port, allowInsecure: 'uiautomator2:chromedriver_autodownload'},
  }]],
  capabilities: [{
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:udid': serial,
    // Without LAZYSH_E2E_APK the already installed build is tested.
    ...(process.env.LAZYSH_E2E_APK ? {'appium:app': process.env.LAZYSH_E2E_APK} : {}),
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
  },
  // Every worker runs one spec file: put the device back to the recorded baseline between files, even after a failure.
  after: () => restoreFromJournal(serial),
  onComplete: async () => { await device?.release(); },
};

import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Installs the pinned UiAutomator2 driver into the git-ignored APPIUM_HOME. Idempotent; never uses a global install or sudo.
const here = dirname(fileURLToPath(import.meta.url));
const home = process.env.APPIUM_HOME ?? join(here, '../.appium');
const driver = dirname(createRequire(import.meta.url).resolve('appium-uiautomator2-driver/package.json'));
const version = (JSON.parse(readFileSync(join(driver, 'package.json'), 'utf8')) as {version: string}).version;
const appium = (...args: string[]) => spawnSync('appium', args, {stdio: 'inherit', env: {...process.env, APPIUM_HOME: home}});

const listed = spawnSync('appium', ['driver', 'list', '--installed', '--json'], {encoding: 'utf8', env: {...process.env, APPIUM_HOME: home}});
if (listed.status === 0 && (JSON.parse(listed.stdout) as Record<string, {version?: string}>).uiautomator2?.version === version) {
  console.log(`uiautomator2 ${version} already installed in ${home}`);
} else {
  const local = appium('driver', 'install', '--source=local', driver);
  if (local.status !== 0) {
    console.warn('--source=local failed, falling back to --source=npm with the pinned version');
    process.exit(appium('driver', 'install', '--source=npm', `appium-uiautomator2-driver@${version}`).status ?? 1);
  }
}

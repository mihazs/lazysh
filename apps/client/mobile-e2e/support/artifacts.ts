import {browser} from '@wdio/globals';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {adbFor} from './device';
import {inNative, inWebView} from './contexts';

const slug = (text: string) => text.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unnamed';
const KEY = /BEGIN [A-Z ]*PRIVATE KEY-----(?:\s|&#10;|\\n)*[A-Za-z0-9+/=]{16,}/;
const quiet = <T>(work: Promise<T>) => work.catch(() => undefined);

/** True while a password or private key is on screen: such a screen is never captured. */
export async function secretOnScreen() {
  const nativeSource = await quiet(inNative(() => browser.getPageSource()));
  // A key is its header followed by a base64 body; the field's placeholder is the header alone.
  if (nativeSource && (/password="true"/.test(nativeSource) || KEY.test(nativeSource))) return true;
  return (await quiet(inWebView(() => browser.execute(keyPattern => !!document.querySelector('input[type=password]')
    || [...document.querySelectorAll('textarea,input')].some(field => new RegExp(keyPattern).test((field as HTMLInputElement).value)), KEY.source)))) === true;
}

async function capture(directory: string, name: string, run: <T>(work: () => Promise<T>) => Promise<T>) {
  const screenshot = await quiet(run(() => browser.takeScreenshot()));
  if (screenshot) await writeFile(join(directory, `${name}.png`), screenshot, 'base64');
  const source = await quiet(run(() => browser.getPageSource()));
  if (source) await writeFile(join(directory, `${name}-source.${name === 'native' ? 'xml' : 'html'}`), source);
}

/**
 * Failure evidence under reports/artifacts/<spec>/<test>/: screenshots and page sources of both contexts (skipped while a
 * secret is on screen), a bounded logcat tail and the tail of the Appium log. Never throws: it must not mask the failure.
 */
export function saveFailureArtifacts(test: {file?: string; title: string}, reports: string, serial: string) {
  return collect(test, reports, serial).catch(error => console.warn(`Failure artifacts were not fully saved: ${(error as Error).message}`));
}

async function collect(test: {file?: string; title: string}, reports: string, serial: string) {
  const directory = join(reports, 'artifacts', slug(basename(test.file ?? 'spec').replace(/\.e2e\.ts$/, '')), slug(test.title));
  await mkdir(directory, {recursive: true});
  if (await secretOnScreen()) await writeFile(join(directory, 'screen-suppressed.txt'), 'A password or private key was on screen; screenshots and page sources were not captured.\n');
  else { await capture(directory, 'native', inNative); await capture(directory, 'webview', inWebView); }
  await quiet(adbFor(serial)('logcat', '-d', '-t', '500').then(log => writeFile(join(directory, 'logcat.txt'), log)));
  await quiet(readFile(join(reports, 'wdio-appium.log'), 'utf8').then(log => writeFile(join(directory, 'appium.log'), log.slice(-200_000))));
}

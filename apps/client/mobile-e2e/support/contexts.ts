import {browser} from '@wdio/globals';

export type AppContext = 'NATIVE_APP' | 'WEBVIEW';
/** The title of the Tauri WebView page (`<title>` in index.html). */
export const WEBVIEW_TITLE = 'lazysh';

async function currentContext(): Promise<AppContext> {
  const context = await browser.getContext();
  return (typeof context === 'string' ? context : context.id).startsWith('WEBVIEW') ? 'WEBVIEW' : 'NATIVE_APP';
}

async function switchTo(target: AppContext) {
  if (target === 'NATIVE_APP') return browser.switchContext('NATIVE_APP');
  const {waitforInterval, waitforTimeout = 10_000} = browser.options;
  // The DevTools socket appears a moment after the activity starts and the page title a moment after that, and `switchContext`
  // fails at once when it finds a page whose title does not match yet. A cold guest also starts ChromeDriver on the first
  // attach, so allow three waits.
  await browser.waitUntil(async () => {
    try { await browser.switchContext({title: WEBVIEW_TITLE}); return true; } catch { return false; }
  }, {timeout: 3 * waitforTimeout, interval: waitforInterval, timeoutMsg: `The app WebView titled "${WEBVIEW_TITLE}" did not appear`});
}

/** Runs `run` in `target` and returns to the previous context afterwards; tests never call `switchContext` themselves. */
export async function inContext<T>(target: AppContext, run: () => Promise<T>): Promise<T> {
  const previous = await currentContext();
  if (previous === target) return run();
  await switchTo(target);
  try { return await run(); } finally { await switchTo(previous); }
}
export const inNative = <T>(run: () => Promise<T>) => inContext('NATIVE_APP', run);
export const inWebView = <T>(run: () => Promise<T>) => inContext('WEBVIEW', run);

type Overwritable = {overwriteCommand(name: 'pause', replacement: () => Promise<never>): void};

/** Sleeps hide races; waiting is an auto-retrying matcher or `waitUntil` with a `timeoutMsg`. */
export function forbidPause(browser: Overwritable) {
  browser.overwriteCommand('pause', async () => { throw new Error('browser.pause is not allowed: use an auto-retrying expect matcher or browser.waitUntil with a timeoutMsg'); });
}

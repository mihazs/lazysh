import {test as base, type Page} from '@playwright/test';
import type {TerminalBackendId} from '../../src/terminalAdapter';
import {assertNativeBackendObserved, BACKEND_ENV, requestedBackend} from '../../src/e2eTerminalBackend';

// The key of `developerBackendOverride` in src/terminalBackends.ts, not imported because that module loads the xterm adapter.
const OVERRIDE_KEY = 'lazysh.terminal.backend';

type Availability = {ok: true} | {ok: false; reason: string};

/** Asks the app's own backend registry whether `requested` can be created, in the page, so the reason is the registry's. */
async function probe(page: Page, requested: TerminalBackendId): Promise<Availability> {
  const {id, fallbacks} = await page.evaluate(async requested => {
    const registryUrl = '/src/terminalBackends.ts'; // The dev server's URL of the app's registry, the same module instance the app uses.
    const {createTerminalAdapter} = await import(registryUrl) as typeof import('../../src/terminalBackends');
    const {selection, adapter} = await createTerminalAdapter({override: requested});
    adapter.dispose();
    return selection;
  }, requested);
  return id === requested ? {ok: true} : {ok: false, reason: fallbacks.find(fallback => fallback.id === requested)?.reason ?? `the app chose ${id}`};
}

/**
 * `test` of the terminal specs. A requested backend is applied before load. A backend the registry cannot create is reported as
 * skipped with the registry's reason, once, so the arm turns on by itself when the backend is registered.
 */
export const test = base.extend<{requestedBackendApplied: void}, {backendAvailability: Availability}>({
  backendAvailability: [async ({browser}, use, workerInfo) => {
    const requested = requestedBackend();
    if (!requested) return use({ok: true});
    const page = await browser.newPage();
    try {
      // Any document on the dev server's origin can import its modules; this one does not boot the app.
      const origin = workerInfo.project.use.baseURL!;
      await page.route(`${origin}/backend-probe`, route => route.fulfill({contentType: 'text/html', body: '<!doctype html>'}));
      await page.goto(`${origin}/backend-probe`);
      const availability = await probe(page, requested);
      if (!availability.ok) console.log(`${BACKEND_ENV}=${requested}: skipped, the registry reports: ${availability.reason}`);
      return await use(availability);
    } finally { await page.close(); }
  }, {scope: 'worker'}],
  requestedBackendApplied: [async ({context, page, backendAvailability}, use, testInfo) => {
    const requested = requestedBackend();
    if (requested) {
      testInfo.skip(!backendAvailability.ok, `${requested} backend: ${backendAvailability.ok ? '' : backendAvailability.reason}`);
      await context.addInitScript(([key, backend]) => { try { localStorage.setItem(key, backend); } catch { /* No storage, no override. */ } }, [OVERRIDE_KEY, requested]);
    }
    await use();
    if (requested === 'native' && testInfo.status === 'passed') assertNativeBackendObserved(page);
  }, {auto: true}],
});

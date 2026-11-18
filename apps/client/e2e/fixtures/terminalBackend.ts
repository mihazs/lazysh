import {test as base, type Page} from '@playwright/test';
import type {TerminalBackendId} from '../../src/terminalAdapter';

/**
 * The backend matrix of the terminal specs: `LAZYSH_E2E_TERMINAL_BACKEND=xterm|native` makes every spec that takes its `test` from
 * here ask for that backend through the developer override, before the page loads, and `onAdapter` then fails the spec when the
 * terminal on screen is another backend. Unset, a spec runs on whatever the app picks and nothing is asserted about it.
 */
export const BACKEND_ENV = 'LAZYSH_E2E_TERMINAL_BACKEND';
// The key of `developerBackendOverride` in src/terminalBackends.ts, not imported because that module loads the xterm adapter.
const OVERRIDE_KEY = 'lazysh.terminal.backend';

export function requestedBackend(env: Record<string, string | undefined> = process.env): TerminalBackendId | undefined {
  const value = env[BACKEND_ENV];
  if (!value) return undefined;
  if (value !== 'xterm' && value !== 'native') throw new Error(`${BACKEND_ENV} must be xterm or native, not "${value}".`);
  return value;
}

/** Thrown for a terminal that is not the requested backend, so a caller that retries on errors can still let it through. */
export class BackendMismatchError extends Error {}

/** A request the app did not honour (it fell back, or a fixture mounts one backend) would pass as green on the wrong engine. */
export function assertBackendUsed(used: TerminalBackendId, requested = requestedBackend()) {
  if (requested && used !== requested) throw new BackendMismatchError(`${BACKEND_ENV}=${requested} but the terminal on screen is the ${used} backend: the app fell back or a fixture mounts ${used}, so this run says nothing about ${requested}.`);
}

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
  requestedBackendApplied: [async ({context, backendAvailability}, use, testInfo) => {
    const requested = requestedBackend();
    if (requested) {
      testInfo.skip(!backendAvailability.ok, `${requested} backend: ${backendAvailability.ok ? '' : backendAvailability.reason}`);
      await context.addInitScript(([key, backend]) => { try { localStorage.setItem(key, backend); } catch { /* No storage, no override. */ } }, [OVERRIDE_KEY, requested]);
    }
    await use();
  }, {auto: true}],
});

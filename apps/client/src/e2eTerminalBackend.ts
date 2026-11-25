import type {TerminalAdapter, TerminalBackendId} from './terminalAdapter';
import type {BackendSelection} from './terminalBackendRegistry';
import type {LiveSession} from './terminal';

/**
 * The backend matrix of the terminal e2e specs: `LAZYSH_E2E_TERMINAL_BACKEND=xterm|native` makes every spec that takes its `test`
 * from e2e/fixtures/terminalBackend.ts ask for that backend, and `onAdapter` then fails the spec when the terminal on screen is
 * another backend. Unset, a spec runs on whatever the app picks and nothing is asserted about it.
 *
 * This module lives in `src` and names no Playwright type: the source build type-checks `src` where `@playwright/test` is
 * incomplete (the F-Droid recipe removes `playwright-core`), so anything it imports must stay free of Playwright.
 */
export const BACKEND_ENV = 'LAZYSH_E2E_TERMINAL_BACKEND';

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

/** The part of a Playwright `JSHandle` that the readers below use; a Playwright handle is assignable to it. */
interface Handle<T> {
  evaluate<R, A = void>(use: (value: T, arg: A) => R | Promise<R>, arg?: A): Promise<R>;
  evaluateHandle<R>(pick: (value: T) => R): Promise<Handle<R>>;
  dispose(): Promise<void>;
}

/** The part of Playwright's `Page` that `onAdapter` and `onEngine` use; a Playwright `Page` is assignable to it. */
export interface AdapterPage {
  evaluateHandle(find: () => LiveSession): Promise<Handle<LiveSession>>;
}

const nativeReads = new WeakSet<AdapterPage>();

/** Called after a native matrix case otherwise passed. A probe alone is not evidence for the case. */
export function assertNativeBackendObserved(page: AdapterPage) {
  if (!nativeReads.has(page)) {
    throw new Error('Native backend unverified: this case did not complete an onAdapter read on the native terminal.');
  }
}

/** Runs in the page: the session of the terminal drawn on screen. The App keeps its sessions in React state, so it is taken from the visible `TerminalPane`'s `session` prop rather than through a hook in the product. */
const drawnSession = () => {
  type Fiber = {memoizedProps?: {session?: {adapter?: unknown}} | null; return: Fiber | null};
  const canvas = [...document.querySelectorAll('.terminal-canvas')].find(node => node.getClientRects().length > 0);
  const key = canvas && Object.keys(canvas).find(name => name.startsWith('__reactFiber$'));
  for (let fiber = key ? Reflect.get(canvas, key) as Fiber | null : null; fiber; fiber = fiber.return) if (fiber.memoizedProps?.session?.adapter) return fiber.memoizedProps.session as LiveSession;
  throw new Error('No terminal is drawn on this page.');
};

/**
 * Runs `use` in the page against the TerminalAdapter of the terminal drawn on screen: rows (`readRows`), cursor, viewport,
 * selection and geometry come from the adapter, never from a backend's DOM or buffer, so a spec asserts the same way on any
 * backend. `use` is serialized: it reaches only its two arguments. When a backend was requested
 * (`LAZYSH_E2E_TERMINAL_BACKEND`), a terminal of another backend throws before `use` runs, so a silent fallback fails the spec.
 */
export async function onAdapter<R,A=void>(page:AdapterPage,use:(adapter:TerminalAdapter,arg:A)=>R|Promise<R>,arg?:A):Promise<R> {
  const session=await page.evaluateHandle(drawnSession);
  const adapter=await session.evaluateHandle(drawn=>drawn.adapter);
  try{
    const requested=requestedBackend();
    if(requested)assertBackendUsed(await adapter.evaluate(terminal=>terminal.backend),requested);
    const result = await adapter.evaluate(use, arg);
    if (requested === 'native') nativeReads.add(page);
    return result;
  }finally{await adapter.dispose();await session.dispose();}
}

/**
 * What the session of the terminal drawn on screen got: the adapter's backend and the registry's record of why (the engine, the reason
 * and what it refused first). A spec that sets the engine itself reads this, so it is not held to the engine a matrix run requested.
 */
export async function onEngine(page:AdapterPage):Promise<{backend:TerminalBackendId;selection:BackendSelection}> {
  const session=await page.evaluateHandle(drawnSession);
  try{return await session.evaluate(drawn=>({backend:drawn.adapter.backend,selection:drawn.selection}));}finally{await session.dispose();}
}

import type {TerminalAdapter, TerminalBackendId} from './terminalAdapter';
import type {BackendSelection} from './terminalBackendRegistry';

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

/** A handle to a value in the page, as far as these helpers use Playwright's `JSHandle`. */
type PageHandle<T> = {evaluate<R, A = void>(use: (value: T, arg: A) => R | Promise<R>, arg?: A): Promise<R>; jsonValue(): Promise<T>; dispose(): Promise<void>};

/** The part of Playwright's `Page` that `onAdapter` and `terminalSelection` use; a Playwright `Page` is assignable to it. */
export interface AdapterPage {
  evaluateHandle<T>(find: (part: SessionPart) => T, part: SessionPart): Promise<PageHandle<T>>;
}

type SessionPart = 'adapter' | 'selection';

/** One member of the `session` the visible `TerminalPane` was given, found in React's fiber tree rather than through a hook in the product. Serialized into the page: it reaches only its argument. */
function sessionPart(part: SessionPart): unknown {
  type Fiber={memoizedProps?:{session?:Record<string,unknown>}|null;return:Fiber|null};
  const canvas=[...document.querySelectorAll('.terminal-canvas')].find(node=>node.getClientRects().length>0);
  const key=canvas&&Object.keys(canvas).find(name=>name.startsWith('__reactFiber$'));
  for(let fiber=key?Reflect.get(canvas,key) as Fiber|null:null;fiber;fiber=fiber.return)if(fiber.memoizedProps?.session?.adapter)return fiber.memoizedProps.session[part];
  throw new Error('No terminal is drawn on this page.');
}

/** The registry's record of the terminal on screen: its engine, why that engine, and which ones were refused on the way. */
export async function terminalSelection(page:AdapterPage):Promise<BackendSelection> {
  const selection=await page.evaluateHandle(sessionPart as (part:SessionPart)=>BackendSelection,'selection');
  try{return await selection.jsonValue();}finally{await selection.dispose();}
}

/**
 * Runs `use` in the page against the TerminalAdapter of the terminal drawn on screen: rows (`readRows`), cursor, viewport,
 * selection and geometry come from the adapter, never from a backend's DOM or buffer, so a spec asserts the same way on any
 * backend. The App keeps its sessions in React state, so the adapter is taken from the visible `TerminalPane`'s `session` prop
 * rather than through a hook in the product. `use` is serialized: it reaches only its two arguments. When a backend was requested
 * (`LAZYSH_E2E_TERMINAL_BACKEND`), a terminal of another backend throws before `use` runs, so a silent fallback fails the spec.
 */
export async function onAdapter<R,A=void>(page:AdapterPage,use:(adapter:TerminalAdapter,arg:A)=>R|Promise<R>,arg?:A):Promise<R> {
  const adapter=await page.evaluateHandle(sessionPart as (part:SessionPart)=>TerminalAdapter,'adapter');
  try{
    const requested=requestedBackend();
    if(requested)assertBackendUsed(await adapter.evaluate(terminal=>terminal.backend),requested);
    return await adapter.evaluate(use,arg);
  }finally{await adapter.dispose();}
}

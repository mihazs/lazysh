import {systemScreenReader} from './androidScreenReader';
import {getPreferences} from './preferences';
import {nativeCapabilities} from './nativeTerminalAdapter';
import {createNativeTerminalAdapter, probeNativeCore} from './tauriNativeCoreBridge';
import type {TerminalBackendId} from './terminalAdapter';
import {createBackendRegistry, type BackendPreference, type BackendRegistration, type FailureMemory, type SelectOptions} from './terminalBackendRegistry';
import {appVersion} from './version';
import {createXtermTerminalAdapter, xtermCapabilities} from './xtermTerminalAdapter';

const FAILURE_KEY = 'lazysh.terminal.failure';

/**
 * A failure of a backend is kept on this device until the app is updated (a fix may have shipped) or a start of that backend works again.
 * shortcut: a storage that cannot be written forgets the failure at once, so Auto retries native in every session; keep an in-memory copy beside it if that is seen.
 */
const deviceFailures: FailureMemory = {
  get(id) {
    try {
      const kept = JSON.parse(localStorage.getItem(`${FAILURE_KEY}.${id}`) ?? 'null') as {version?: unknown; reason?: unknown} | null;
      return kept?.version === appVersion && typeof kept.reason === 'string' ? kept.reason : undefined;
    } catch { return undefined; }
  },
  set(id, reason) { try { localStorage.setItem(`${FAILURE_KEY}.${id}`, JSON.stringify({version: appVersion, reason})); } catch { /* Not kept: the next session tries again. */ } },
  clear(id) { try { localStorage.removeItem(`${FAILURE_KEY}.${id}`); } catch { /* Nothing was kept either. */ } },
};

const registry = createBackendRegistry(deviceFailures);
registry.register({
  id: 'xterm',
  capabilities: xtermCapabilities,
  autoEligible: true,
  probe: () => ({ok: true}),
  create: createXtermTerminalAdapter,
});

/** Native is registered behind its probe and Auto never picks it: a platform's own default flip sets `autoEligible` (docs/architecture/terminal-migration-plan.md). */
export function registerNativeBackend(backends: Pick<typeof registry, 'register'>, probe: BackendRegistration['probe'] = probeNativeCore) {
  backends.register({
    id: 'native',
    capabilities: nativeCapabilities,
    autoEligible: false,
    probe,
    // The session start reads `adapter.transport` to start its transport on this core.
    create: async ({mosh} = {}) => {
      const {scrollback, cursorStyle, cursorBlink} = getPreferences();
      return (await createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: scrollback, canonicalFrames: mosh, cursorStyle, cursorBlink})).adapter;
    },
  });
}
registerNativeBackend(registry);

/** The failure that keeps Auto on xterm.js on this device (undefined: none), as the registry recorded it; Settings shows it. */
export const recordedNativeFailure = () => registry.failure('native');

/** The native engine broke in a live session: Auto keeps away from it from now on. */
export const recordNativeFailure = (error: unknown) => registry.recordFailure('native', error);

/** What `createTerminalAdapter` can select, so a test can hold each registration to the adapter contract. */
export const registeredBackends = () => registry.registrations();

const OVERRIDE_KEY = 'lazysh.terminal.backend';

/** A developer's backend choice, kept in localStorage; anything else is ignored. */
export function developerBackendOverride(): BackendPreference | undefined {
  try {
    const value = localStorage.getItem(OVERRIDE_KEY);
    return value === 'xterm' || value === 'native' ? value : undefined;
  } catch { return undefined; }
}

/** A session read with a screen reader needs a backend whose content that reader can reach. */
export const screenReaderRequirements = (screenReader: boolean): NonNullable<SelectOptions['requires']> => screenReader ? ['accessibility'] : [];

/** What a new session needs of its terminal: reachable by a screen reader when the preference says one is used or Android reports one (TalkBack, #1329). */
const readerRequirements = async (preference: boolean) => screenReaderRequirements(preference || await systemScreenReader());

/** The engine Auto gives a new session on this device now. */
export const defaultTerminalEngine = async (backends: Pick<typeof registry, 'select'> = registry) => (await backends.select({requires: await readerRequirements(getPreferences().screenReader)})).id;

/** Why a new session cannot use `id` now, as the registry would record it (undefined: it can); Settings shows it beside the choice. */
export const backendRefusal = async (id: TerminalBackendId, screenReader: boolean) => registry.refusal(id, await readerRequirements(screenReader));

/** The re-probe path: asks the device again whether `id` can run here, then answers `backendRefusal`'s answer for it. */
export const reprobeBackend = async (id: TerminalBackendId, screenReader: boolean) => (await registry.reprobe(id)) ?? backendRefusal(id, screenReader);

/** The terminal of one new session, from the backend selection rules. */
export async function createTerminalAdapter(options: SelectOptions = {}, backends = registry) {
  return backends.create({override: developerBackendOverride(), ...options, requires: [...(options.requires ?? []), ...await readerRequirements(getPreferences().screenReader)]});
}

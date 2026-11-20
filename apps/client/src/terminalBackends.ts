import {getPreferences} from './preferences';
import {nativeCapabilities} from './nativeTerminalAdapter';
import {createNativeTerminalAdapter, probeNativeCore} from './tauriNativeCoreBridge';
import {createBackendRegistry, type BackendPreference, type BackendRegistration, type SelectOptions} from './terminalBackendRegistry';
import {createXtermTerminalAdapter, xtermCapabilities} from './xtermTerminalAdapter';

const registry = createBackendRegistry();
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
    // shortcut: the opening's events Channel and bind() are dropped, so no transport attaches to this core yet; the session start takes them when it is wired, and replaces this.
    create: async () => (await createNativeTerminalAdapter({columns: 80, rows: 24, scrollbackLines: getPreferences().scrollback})).adapter,
  });
}
registerNativeBackend(registry);

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

/** The terminal of one new session, from the backend selection rules. */
export function createTerminalAdapter(options: SelectOptions = {}, backends = registry) {
  return backends.create({override: developerBackendOverride(), ...options, requires: [...(options.requires ?? []), ...screenReaderRequirements(getPreferences().screenReader)]});
}

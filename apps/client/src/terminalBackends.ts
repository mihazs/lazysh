import type {Terminal} from '@xterm/xterm';
import type {TerminalAdapter} from './terminalAdapter';
import {createBackendRegistry, type BackendPreference, type SelectOptions} from './terminalBackendRegistry';
import {createXtermTerminalAdapter, xtermCapabilities, XtermTerminalAdapter} from './xtermTerminalAdapter';

const registry = createBackendRegistry();
registry.register({
  id: 'xterm',
  capabilities: xtermCapabilities,
  autoEligible: true,
  probe: () => ({ok: true}),
  create: createXtermTerminalAdapter,
});
// The native backend registers here once its platform gate passes (docs/architecture/terminal-migration-plan.md).

const OVERRIDE_KEY = 'lazysh.terminal.backend';

/** A developer's backend choice, kept in localStorage; anything else is ignored. */
export function developerBackendOverride(): BackendPreference | undefined {
  try {
    const value = localStorage.getItem(OVERRIDE_KEY);
    return value === 'xterm' || value === 'native' ? value : undefined;
  } catch { return undefined; }
}

/** The terminal of one new session, from the backend selection rules. */
export function createTerminalAdapter(options: SelectOptions = {}) {
  return registry.create({override: developerBackendOverride(), ...options});
}

/** The xterm view of a session. TerminalPane still draws xterm directly (#1308); it cannot show another backend yet. */
export function xtermView(adapter: TerminalAdapter): Terminal {
  if (!(adapter instanceof XtermTerminalAdapter)) throw new Error(`The terminal pane cannot show the ${adapter.backend} backend yet.`);
  return adapter.terminal;
}

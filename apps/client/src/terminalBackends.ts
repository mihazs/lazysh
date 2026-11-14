import {t} from './i18n/core';
import {createNativeProbe} from './nativeProbe';
import {nativeCapabilities} from './nativeTerminalAdapter';
import type {BackendPreference, BackendProbe, SelectOptions} from './terminalBackendRegistry';
import {createBackendRegistry} from './terminalBackendRegistry';
import {createXtermTerminalAdapter, xtermCapabilities} from './xtermTerminalAdapter';

const OVERRIDE_KEY = 'lazysh.terminal.backend';

/** A developer's backend choice, kept in localStorage; anything else is ignored. */
export function developerBackendOverride(): BackendPreference | undefined {
  try {
    const value = localStorage.getItem(OVERRIDE_KEY);
    return value === 'xterm' || value === 'native' ? value : undefined;
  } catch { return undefined; }
}

/** Build-time kill switch (#1342): a build made with `VITE_LAZYSH_DISABLE_NATIVE_TERMINAL=1` can never pick the native engine, whatever is stored on the device. */
const buildKillSwitch = import.meta.env.VITE_LAZYSH_DISABLE_NATIVE_TERMINAL === '1';
const nativeProbe = createNativeProbe();

export type TerminalBackendsOptions = {
  killed?: boolean;
  probeNative?: () => BackendProbe | Promise<BackendProbe>;
  override?: () => BackendPreference | undefined;
  /** Tells the user why a backend they asked for was not used; called once per distinct reason. */
  announce?: (reason: string) => void;
};

/** The registered backends and the one door a new session's terminal comes through. Native is registered, never automatic, and refused while its probe fails or the kill switch is on. */
export function createTerminalBackends({
  killed = buildKillSwitch, probeNative = nativeProbe.probe, override = developerBackendOverride,
  announce = reason => window.dispatchEvent(new CustomEvent('lazysh-error', {detail: t('appNativeTerminalUnavailable', {reason})})),
}: TerminalBackendsOptions = {}) {
  const registry = createBackendRegistry();
  registry.register({id: 'xterm', capabilities: xtermCapabilities, autoEligible: true, probe: () => ({ok: true}), create: createXtermTerminalAdapter});
  registry.register({
    id: 'native', capabilities: nativeCapabilities, autoEligible: false,
    probe: () => killed ? {ok: false, reason: 'The native terminal engine is switched off in this build.'} : probeNative(),
    // The probe cannot pass until the engine has a renderer and a session path (docs/architecture/terminal-migration-plan.md).
    create: () => { throw new Error('The native terminal engine has no session path in this build.'); },
  });
  const announced = new Set<string>();
  return {
    registry,
    /** The terminal of one new session, from the backend selection rules; a refused backend is announced, so a developer who asked for native is told why they got xterm.js. */
    async create(options: SelectOptions = {}) {
      const created = await registry.create({override: override(), ...options});
      for (const {reason} of created.selection.fallbacks) if (!announced.has(reason)) { announced.add(reason); announce(reason); }
      return created;
    },
  };
}

export const terminalBackends = createTerminalBackends();
export const createTerminalAdapter = (options?: SelectOptions) => terminalBackends.create(options);
/** The native engine's probe, for a re-probe from diagnostics. */
export const nativeEngineProbe = nativeProbe;

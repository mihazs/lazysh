import type {TerminalAdapter, TerminalBackendId, TerminalCapabilities} from './terminalAdapter';

export type BackendProbe = {ok: true} | {ok: false; reason: string};
export type BackendPreference = 'auto' | TerminalBackendId;

export type BackendRegistration = {
  id: TerminalBackendId;
  /** What the backend declares it can do; selection filters on this before probing. */
  capabilities: TerminalCapabilities;
  /** `auto` may pick this backend. A backend becomes eligible only after its rollout gate passes. */
  autoEligible: boolean;
  /** Real hardware/surface detection; a failure is recorded with its reason, never ignored. */
  probe(): BackendProbe | Promise<BackendProbe>;
  create(session?: SessionOptions): TerminalAdapter | Promise<TerminalAdapter>;
};

/** What a backend must know about a session when it creates the terminal, because it cannot be changed later. */
export type SessionOptions = {
  /** The session's transport is Mosh: its frames decide the grid's size, so the terminal follows them from the first byte (`canonicalMoshResize`). */
  mosh?: boolean;
};

export type BackendSelection = {
  id: TerminalBackendId;
  /** Why this backend: shown in diagnostics. */
  reason: string;
  /** Backends considered and refused before this one, each with its reason. */
  fallbacks: {id: TerminalBackendId; reason: string}[];
};

export type SelectOptions = SessionOptions & {
  preference?: BackendPreference;
  /** A developer's choice; it replaces `preference` but can never enable a backend whose probe failed. */
  override?: BackendPreference;
  /** Capabilities the session needs, for instance `accessibility` while a screen reader is active. */
  requires?: (keyof TerminalCapabilities)[];
};

/** The recorded reasons a backend was refused before the selected one; the diagnostics translate them. */
export const NOT_REGISTERED = 'not registered';
export const LACKS_PREFIX = 'lacks ';
export const DISABLED_IN_BUILD = 'disabled in this build';

/**
 * The kill switch, the rollback of last resort: a build made with `LAZYSH_NATIVE_TERMINAL=off` never selects, probes or creates the
 * native backend, whatever the preference, the developer override or a registration says. Read when asked, so a test can flip it.
 */
export const nativeTerminalDisabledInBuild = (): boolean => typeof __LAZYSH_NATIVE_TERMINAL_OFF__ !== 'undefined' && __LAZYSH_NATIVE_TERMINAL_OFF__;

/** The backend every platform can run: the last resort of every selection. */
const FALLBACK: TerminalBackendId = 'xterm';

export function createBackendRegistry() {
  const backends = new Map<TerminalBackendId, BackendRegistration>();
  const probed = new Map<TerminalBackendId, Promise<BackendProbe>>();
  // A probe may be costly (GPU surface); it runs once per registry and its result is the recorded truth.
  const probeOnce = (backend: BackendRegistration) => {
    let result = probed.get(backend.id);
    if (!result) probed.set(backend.id, result = Promise.resolve().then(() => backend.probe()).catch((error): BackendProbe => ({ok: false, reason: String(error)})));
    return result;
  };

  /** Why a session needing `requires` cannot use this backend, or undefined when it can: the one rule selection and Settings share. */
  async function refusal(id: TerminalBackendId, requires: SelectOptions['requires'] = []): Promise<string | undefined> {
    if (id === 'native' && nativeTerminalDisabledInBuild()) return DISABLED_IN_BUILD;
    const backend = backends.get(id);
    if (!backend) return NOT_REGISTERED;
    const missing = requires.filter(capability => !backend.capabilities[capability]);
    if (missing.length) return `${LACKS_PREFIX}${missing.join(', ')}`;
    const probe = await probeOnce(backend);
    return probe.ok ? undefined : probe.reason;
  }

  async function select({preference = 'auto', override, requires: needs = [], mosh}: SelectOptions = {}): Promise<BackendSelection> {
    const requires = mosh ? [...needs, 'canonicalMoshResize' as const] : needs;
    const wanted = override ?? preference;
    const source = override ? 'developer override' : 'preference';
    const order = wanted === 'auto' ? [...backends.values()].filter(backend => backend.autoEligible && backend.id !== FALLBACK).map(backend => backend.id) : [wanted];
    // Even under Auto the record says native is off, so the diagnostics can tell why a session is not on it.
    if (wanted === 'auto' && nativeTerminalDisabledInBuild() && !order.includes('native')) order.unshift('native');
    const fallbacks: BackendSelection['fallbacks'] = [];
    for (const id of [...order, ...(order.includes(FALLBACK) ? [] : [FALLBACK])]) {
      const reason = await refusal(id, requires);
      if (reason !== undefined) { fallbacks.push({id, reason}); continue; }
      return {id, reason: fallbacks.length ? 'fallback' : wanted === 'auto' ? 'automatic' : source, fallbacks};
    }
    throw new Error(`No terminal backend is usable: ${fallbacks.map(f => `${f.id} (${f.reason})`).join('; ')}`);
  }

  return {
    /** Every registered backend, in registration order. */
    registrations: (): readonly BackendRegistration[] => [...backends.values()],
    register(backend: BackendRegistration) {
      if (backends.has(backend.id)) throw new Error(`Terminal backend ${backend.id} is already registered.`);
      backends.set(backend.id, backend);
    },
    select,
    refusal,
    async create(options?: SelectOptions) {
      const selection = await select(options);
      return {selection, adapter: await backends.get(selection.id)!.create({mosh: options?.mosh})};
    },
  };
}

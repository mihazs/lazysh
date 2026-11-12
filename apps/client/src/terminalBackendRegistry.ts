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
  create(): TerminalAdapter | Promise<TerminalAdapter>;
};

export type BackendSelection = {
  id: TerminalBackendId;
  /** Why this backend: shown in diagnostics. */
  reason: string;
  /** Backends considered and refused before this one, each with its reason. */
  fallbacks: {id: TerminalBackendId; reason: string}[];
};

export type SelectOptions = {
  preference?: BackendPreference;
  /** A developer's choice; it replaces `preference` but can never enable a backend whose probe failed. */
  override?: BackendPreference;
  /** Capabilities the session needs, for instance `accessibility` while a screen reader is active. */
  requires?: (keyof TerminalCapabilities)[];
};

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

  async function select({preference = 'auto', override, requires = []}: SelectOptions = {}): Promise<BackendSelection> {
    const wanted = override ?? preference;
    const source = override ? 'developer override' : 'preference';
    const order = wanted === 'auto' ? [...backends.values()].filter(backend => backend.autoEligible && backend.id !== FALLBACK).map(backend => backend.id) : [wanted];
    const fallbacks: BackendSelection['fallbacks'] = [];
    for (const id of [...order, ...(order.includes(FALLBACK) ? [] : [FALLBACK])]) {
      const backend = backends.get(id);
      if (!backend) { fallbacks.push({id, reason: 'not registered'}); continue; }
      const missing = requires.filter(capability => !backend.capabilities[capability]);
      if (missing.length) { fallbacks.push({id, reason: `lacks ${missing.join(', ')}`}); continue; }
      const probe = await probeOnce(backend);
      if (!probe.ok) { fallbacks.push({id, reason: probe.reason}); continue; }
      return {id, reason: fallbacks.length ? 'fallback' : wanted === 'auto' ? 'automatic' : source, fallbacks};
    }
    throw new Error(`No terminal backend is usable: ${fallbacks.map(f => `${f.id} (${f.reason})`).join('; ')}`);
  }

  return {
    register(backend: BackendRegistration) {
      if (backends.has(backend.id)) throw new Error(`Terminal backend ${backend.id} is already registered.`);
      backends.set(backend.id, backend);
    },
    select,
    async create(options?: SelectOptions) {
      const selection = await select(options);
      return {selection, adapter: await backends.get(selection.id)!.create()};
    },
  };
}

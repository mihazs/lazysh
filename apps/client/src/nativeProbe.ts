import {invoke} from '@tauri-apps/api/core';
import type {BackendProbe} from './terminalBackendRegistry';

/** What the app says about the native engine: whether the core is built in and whether a renderer can draw it (#1336). */
export type NativeEngineReport = {core: boolean; renderer: boolean; reason?: string};

/** One probe run, for diagnostics: what was decided, what it cost and whether the device's cached answer was used. */
export type NativeProbeRun = {result: BackendProbe; costMs: number; cached: boolean};

export type NativeProbeOptions = {
  ask?: () => Promise<NativeEngineReport>;
  /** Where a definitive answer is kept per device; probing again is `reprobe`. */
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  /** What makes a stored answer stale: a new build or a new webview. */
  fingerprint?: string;
  /** A probe that takes longer is a failed probe and is not cached. */
  budgetMs?: number;
  clock?: () => number;
};

const KEY = 'lazysh.terminal.native-probe';
const sourceRevision = typeof __LAZYSH_SOURCE_REVISION__ === 'string' ? __LAZYSH_SOURCE_REVISION__ : '';

function localStore(): NativeProbeOptions['storage'] {
  try { return localStorage; } catch { return undefined; }
}

const verdict = ({core, renderer, reason}: NativeEngineReport): BackendProbe =>
  core && renderer ? {ok: true} : {ok: false, reason: reason ?? (core ? 'This build has no native terminal renderer.' : 'The native terminal core is not built into this app.')};

/**
 * Decides once per device whether the native engine can run, bounded in time, and keeps a definitive answer so the
 * next start costs nothing. A failure to ask (not a native app, a timeout) is a failed probe that is never kept.
 */
export function createNativeProbe({
  ask = () => invoke<NativeEngineReport>('terminal_native_probe'), storage = localStore(), budgetMs = 2000,
  fingerprint = `${sourceRevision}|${typeof navigator === 'undefined' ? '' : navigator.userAgent}`, clock = () => performance.now(),
}: NativeProbeOptions = {}) {
  const remembered = (): NativeEngineReport | undefined => {
    try {
      const stored = JSON.parse(storage?.getItem(KEY) ?? 'null') as {fingerprint: string; report: NativeEngineReport} | null;
      return stored?.fingerprint === fingerprint ? stored.report : undefined;
    } catch { return undefined; }
  };

  async function run(useCache: boolean): Promise<NativeProbeRun> {
    const started = clock(), cost = () => Math.round(clock() - started);
    const report = useCache ? remembered() : undefined;
    if (report) return {result: verdict(report), costMs: cost(), cached: true};
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([ask(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the probe did not answer within ${budgetMs} ms`)), budgetMs); })]);
      try { storage?.setItem(KEY, JSON.stringify({fingerprint, report: answer})); } catch { /* A device that cannot keep the answer probes again next start. */ }
      return {result: verdict(answer), costMs: cost(), cached: false};
    } catch (error) {
      return {result: {ok: false, reason: `The native engine could not be probed: ${error instanceof Error ? error.message : String(error)}`}, costMs: cost(), cached: false};
    } finally { clearTimeout(timer); }
  }

  let current: Promise<NativeProbeRun> | undefined;
  return {
    /** The registry's probe: the first call decides, later ones repeat it. */
    probe: () => (current ??= run(true)).then(({result}) => result),
    /** The last run, once there is one. */
    last: () => current,
    /** Forgets the device's answer and asks again. */
    reprobe(): Promise<NativeProbeRun> {
      try { storage?.removeItem(KEY); } catch { /* Nothing kept, nothing to forget. */ }
      return current = run(false);
    },
  };
}

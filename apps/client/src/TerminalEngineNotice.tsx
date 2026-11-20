import {useEffect, useState} from 'react';
import {X} from 'lucide-react';
import {t} from './i18n/core';
import {getPreferences} from './preferences';
import type {TerminalBackendId} from './terminalAdapter';

const SEEN_KEY = 'lazysh.terminal.defaultEngineSeen';

const remember = (engine: TerminalBackendId) => { try { localStorage.setItem(SEEN_KEY, engine); } catch { /* Nothing was read either, so no notice repeats. */ } };

const resolveDefault = async () => (await import('./terminalBackends')).defaultTerminalEngine();

/**
 * The engine to announce: the one Auto resolves to now, when this device last saw another one and the user never chose an engine.
 * shortcut: a device with no recorded engine counts as a fresh install, so only a device that ran a build with this notice before a default flip is told; record the pre-flip engine another way if a flip ships in the same release.
 */
async function changedDefault(resolve: () => Promise<TerminalBackendId>) {
  const now = await resolve();
  let seen: string | null;
  try { seen = localStorage.getItem(SEEN_KEY); } catch { return undefined; }
  if (seen === now) return undefined;
  if (seen && !getPreferences().terminalEngine) return now;
  remember(now);
  return undefined;
}

/** Says once, until dismissed, that this platform's default terminal engine changed and where to switch back. */
export default function TerminalEngineNotice({onOpenSettings, resolve = resolveDefault}: {onOpenSettings(): void; resolve?: () => Promise<TerminalBackendId>}) {
  const [changed, setChanged] = useState<TerminalBackendId>();
  useEffect(() => {
    let live = true;
    void changedDefault(resolve).then(engine => { if (live) setChanged(engine); }, () => { /* No engine resolved: nothing to announce. */ });
    return () => { live = false; };
  }, [resolve]);
  if (!changed) return null;
  const dismiss = () => { remember(changed); setChanged(undefined); };
  return <div className="browser-banner terminal-engine-notice" role="status">
    <span>{t('terminalEngineChanged')}</span>
    <button type="button" onClick={() => { dismiss(); onOpenSettings(); }}>{t('terminalEngineChangedOpenSettings')}</button>
    <button type="button" className="icon-button" aria-label={t('appDismiss')} onClick={dismiss}><X size={16} aria-hidden="true"/></button>
  </div>;
}

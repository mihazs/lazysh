import {useEffect, useState} from 'react';
import {t} from './i18n/core';
import type {Preferences} from './preferences';
import {describeRefusal} from './terminalEngineReason';

const choices = [['auto', 'preferencesTerminalEngineAuto'], ['native', 'terminalEngineNative'], ['xterm', 'terminalEngineXterm']] as const;

/**
 * The engine new sessions ask for, on every platform. Native is never hidden: while the registry refuses it (no surface or a failed
 * probe here, a screen reader it cannot serve) it is disabled and the registry's reason is shown beside the choice.
 */
export default function TerminalEngineChoice({engine, screenReader, update}: {engine: Preferences['terminalEngine']; screenReader: boolean; update: (patch: Partial<Preferences>) => unknown}) {
  // Undefined until the registry has answered; Native stays off meanwhile rather than offer what may be refused.
  const [answer, setAnswer] = useState<{reason?: string}>();
  useEffect(() => {
    let current = true;
    // The registry loads with the first session, not with the settings list: its xterm.js adapter is a chunk of its own.
    import('./terminalBackends').then(({backendRefusal}) => backendRefusal('native', screenReader)).then(reason => ({reason}), (error: unknown) => ({reason: String(error)}))
      .then(next => { if (current) setAnswer(next); });
    return () => { current = false; };
  }, [screenReader]);
  const off = !answer || answer.reason !== undefined;
  return <>
    <fieldset className="cursor-picker" aria-describedby="terminal-engine-help"><legend>{t('preferencesTerminalEngine')}</legend><div>{choices.map(([value, label]) =>
      <label key={value}><input type="radio" name="terminal-engine" value={value} checked={(engine ?? 'auto') === value} disabled={value === 'native' && off} aria-describedby={value === 'native' && answer?.reason !== undefined ? 'terminal-engine-native-off' : undefined} onChange={() => update({terminalEngine: value === 'auto' ? undefined : value})} /><span>{t(label)}</span></label>)}</div></fieldset>
    <p id="terminal-engine-help">{t('preferencesTerminalEngineHelp')}</p>
    {answer?.reason !== undefined && <p id="terminal-engine-native-off">{t('preferencesTerminalEngineNativeOff', {reason: describeRefusal(answer.reason)})}</p>}
  </>;
}

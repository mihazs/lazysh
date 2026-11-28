import {useEffect, useState} from 'react';
import {t} from './i18n/core';
import type {Preferences} from './preferences';
import TerminalFeedbackLink from './TerminalFeedbackLink';
import {FAILED_PREFIX} from './terminalBackendRegistry';
import {describeRefusal} from './terminalEngineReason';

const choices = [['auto', 'preferencesTerminalEngineAuto'], ['native', 'terminalEngineNative'], ['xterm', 'terminalEngineXterm']] as const;

/**
 * The engine new sessions ask for, on every platform. Native is never hidden: while the registry refuses it (no surface or a failed
 * probe here, a screen reader it cannot serve) it is disabled and the registry's reason is shown beside the choice.
 */
export default function TerminalEngineChoice({engine, screenReader, update}: {engine: Preferences['terminalEngine']; screenReader: boolean; update: (patch: Partial<Preferences>) => unknown}) {
  // Undefined until the registry has answered; Native stays off meanwhile rather than offer what may be refused.
  const [answer, setAnswer] = useState<{reason?: string; failed?: string}>();
  // A screen reader is turned on in Android's own settings: the answer is asked again when the user returns to the app.
  const [returns, setReturns] = useState(0);
  useEffect(() => {
    const returned = () => setReturns(count => count + 1);
    window.addEventListener('focus', returned); document.addEventListener('visibilitychange', returned);
    return () => { window.removeEventListener('focus', returned); document.removeEventListener('visibilitychange', returned); };
  }, []);
  useEffect(() => {
    let current = true;
    // The registry loads with the first session, not with the settings list: its xterm.js adapter is a chunk of its own.
    import('./terminalBackends').then(async ({backendRefusal, recordedNativeFailure}) => ({reason: await backendRefusal('native', screenReader), failed: recordedNativeFailure()}))
      .catch((error: unknown) => ({reason: String(error)}))
      .then(next => { if (current) setAnswer(next); });
    return () => { current = false; };
  }, [screenReader, returns]);
  // The re-probe path: the device is asked again (a driver updated, a display changed) and the answer replaces the shown one.
  const checkAgain = () => {
    import('./terminalBackends').then(async ({reprobeBackend, recordedNativeFailure}) => ({reason: await reprobeBackend('native', screenReader), failed: recordedNativeFailure()}))
      .catch((error: unknown) => ({reason: String(error)}))
      .then(setAnswer);
  };
  const off = !answer || answer.reason !== undefined;
  return <>
    <fieldset className="cursor-picker" aria-describedby="terminal-engine-help"><legend>{t('preferencesTerminalEngine')}</legend><div>{choices.map(([value, label]) =>
      <label key={value}><input type="radio" name="terminal-engine" value={value} checked={(engine ?? 'auto') === value} disabled={value === 'native' && off} aria-describedby={value === 'native' && answer?.reason !== undefined ? 'terminal-engine-native-off' : undefined} onChange={() => update({terminalEngine: value === 'auto' ? undefined : value})} /><span>{t(label)}</span></label>)}</div></fieldset>
    <p id="terminal-engine-help">{t('preferencesTerminalEngineHelp')}</p>
    <p id="terminal-engine-feedback"><TerminalFeedbackLink report={{preference: engine ?? 'auto', reasons: answer?.reason === undefined ? [] : [`native: ${answer.reason}`]}} /> {t('terminalFeedbackHelp')}</p>
    {answer?.reason !== undefined && <p id="terminal-engine-native-off">{t('preferencesTerminalEngineNativeOff', {reason: describeRefusal(answer.reason)})} <button type="button" onClick={checkAgain}>{t('preferencesTerminalEngineCheckAgain')}</button></p>}
    {answer?.failed !== undefined && <p id="terminal-engine-native-failed">{t('preferencesTerminalEngineFailed', {detail: answer.failed.slice(FAILED_PREFIX.length)})}</p>}
  </>;
}

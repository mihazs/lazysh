import {t} from './i18n/core';
import {DISABLED_IN_BUILD, FAILED_PREFIX, LACKS_PREFIX, NOT_REGISTERED, SWITCHED, type BackendSelection} from './terminalBackendRegistry';

/** One translated line for a reason the registry recorded when it refused the native engine. */
export const describeRefusal = (reason: string) =>
  reason === NOT_REGISTERED ? t('terminalEngineNotRegistered')
    : reason === DISABLED_IN_BUILD ? t('terminalEngineDisabledInBuild')
    : reason === `${LACKS_PREFIX}accessibility` ? t('terminalEngineLacksAccessibility')
    : reason.startsWith(FAILED_PREFIX) ? t('terminalEngineFailed', {detail: reason.slice(FAILED_PREFIX.length)})
    : reason.startsWith(LACKS_PREFIX) ? t('terminalEngineLacks', {capabilities: reason.slice(LACKS_PREFIX.length)})
    : t('terminalEngineProbeFailed', {detail: reason});

/** The translated name of an engine, as the settings and the status bar show it. */
export const terminalEngineName = (id: BackendSelection['id']) => t(id === 'native' ? 'terminalEngineNative' : 'terminalEngineXterm');

/** One line for the diagnostics: the engine a session uses and why, as the registry recorded it. */
export function describeTerminalEngine({id, reason, fallbacks}: BackendSelection): string {
  const why = fallbacks.length ? fallbacks.map(fallback => describeRefusal(fallback.reason)).join('; ')
    : t(reason === 'automatic' ? 'terminalEngineAutomatic' : reason === 'developer override' ? 'terminalEngineOverride' : reason === SWITCHED ? 'terminalEngineSwitched' : 'terminalEnginePreference');
  return t('terminalEngineUsed', {engine: terminalEngineName(id), reason: why});
}

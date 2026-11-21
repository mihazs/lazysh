import {t} from './i18n/core';
import {LACKS_PREFIX, NOT_REGISTERED, type BackendSelection} from './terminalBackendRegistry';

/** One translated line for a reason the registry recorded when it refused the native engine. */
export const describeRefusal = (reason: string) =>
  reason === NOT_REGISTERED ? t('terminalEngineNotRegistered')
    : reason === `${LACKS_PREFIX}accessibility` ? t('terminalEngineLacksAccessibility')
    : reason.startsWith(LACKS_PREFIX) ? t('terminalEngineLacks', {capabilities: reason.slice(LACKS_PREFIX.length)})
    : t('terminalEngineProbeFailed', {detail: reason});

/** One line for the diagnostics: the engine a session uses and why, as the registry recorded it. */
export function describeTerminalEngine({id, reason, fallbacks}: BackendSelection): string {
  const why = fallbacks.length ? fallbacks.map(fallback => describeRefusal(fallback.reason)).join('; ')
    : t(reason === 'automatic' ? 'terminalEngineAutomatic' : reason === 'developer override' ? 'terminalEngineOverride' : 'terminalEnginePreference');
  return t('terminalEngineUsed', {engine: t(id === 'native' ? 'terminalEngineNative' : 'terminalEngineXterm'), reason: why});
}

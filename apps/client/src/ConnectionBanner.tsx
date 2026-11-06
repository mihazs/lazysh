import {useEffect, useId, useState} from 'react';
import {RefreshCw, WifiOff, X} from 'lucide-react';
import {t} from './i18n/core';
import {RECOVERY_MAX_ATTEMPTS, type RecoveryState} from './connectionRecovery';
import './ConnectionBanner.css';

function useSecondsUntil(deadline: number | undefined) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [deadline]);
  return deadline === undefined ? 0 : Math.max(0, Math.ceil((deadline - now) / 1000));
}

function stoppedText(state: Extract<RecoveryState, {phase: 'stopped'}>) {
  if (state.hint) return t(state.hint);
  return state.message ? t('recoveryStopped', {details: state.message}) : t('recoveryStoppedPlain');
}

function recoveryText(state: RecoveryState, seconds: number) {
  const max = RECOVERY_MAX_ATTEMPTS;
  if (state.phase === 'waiting') return t('recoveryRetryingIn', {seconds, attempt: state.attempt + 1, max});
  if (state.phase === 'connecting') return t('recoveryConnecting', {attempt: Math.min(state.attempt, max), max});
  if (state.phase === 'offline') return t('recoveryOffline');
  return stoppedText(state);
}

/** What assistive technology hears: one line per phase, never the ticking countdown. */
function recoveryAnnouncement(state: RecoveryState) {
  if (state.phase === 'waiting' || state.phase === 'connecting') return t('recoveryAnnounceReconnecting');
  return `${t('recoveryLost')} ${state.phase === 'offline' ? t('recoveryOffline') : stoppedText(state)}`;
}

/** Non-blocking notice for a session whose connection was lost: attempts, Retry now and Close. */
export function ConnectionRecoveryBanner({state, name, retryLabel, onRetry, onClose, closing}: {
  state: RecoveryState; name: string; retryLabel?: string; onRetry: () => void; onClose: () => void; closing: boolean;
}) {
  const title = useId();
  const seconds = useSecondsUntil(state.phase === 'waiting' ? state.retryAt : undefined);
  return <section className="connection-banner" aria-labelledby={title} data-phase={state.phase}>
    <h2 id={title} className="sr-only">{t('recoveryLostLabel', {value1: name})}</h2>
    <p className="sr-only" role="status">{recoveryAnnouncement(state)}</p>
    <div className="connection-banner-text">
      {state.phase === 'offline' ? <WifiOff size={16} aria-hidden="true"/> : <RefreshCw size={16} aria-hidden="true" className={state.phase === 'connecting' ? 'connection-banner-spin' : undefined}/>}
      <p><strong>{t('recoveryLost')}</strong> <span>{recoveryText(state, seconds)}</span></p>
    </div>
    <div className="connection-banner-actions">
      <button type="button" className="subtle-button" disabled={state.phase === 'connecting' || closing} onClick={onRetry}>{retryLabel ?? t('recoveryRetry')}</button>
      <button type="button" className="subtle-button" disabled={closing} onClick={onClose} aria-label={t('recoveryCloseLabel', {value1: name})}><X size={16} aria-hidden="true"/>{t('recoveryClose')}</button>
    </div>
  </section>;
}

/** How a live remote session behaves if its connection drops while the device has no network. */
export type OfflineRecovery = 'mosh' | 'automatic' | 'manual';
const offlineText = {mosh: 'networkOfflineMosh', automatic: 'networkOfflineSsh', manual: 'networkOfflineManual'} as const;

/** Shown on a live remote session while the operating system reports no network. */
export function NetworkOfflineNotice({recovery}: {recovery: OfflineRecovery}) {
  return <div className="connection-banner" role="status" data-phase="network">
    <div className="connection-banner-text">
      <WifiOff size={16} aria-hidden="true"/>
      <p>{t(offlineText[recovery])}</p>
    </div>
  </div>;
}

import type {ReactNode} from 'react';
import {formatDateTime, t, useUi, type UiKey} from './i18n/core';
import {clearAuthAudit, useAuthAudit, type AuditDecision, type AuditOutcome} from './authAudit';
import {authChoices, defaultAuthChoice, ownAuthChoice, setDefaultAuthChoice, setHostAuthChoice, useAuthPolicy, type AuthChoice} from './authPolicy';

const choiceKeys = {ask: 'authChoiceAsk', always: 'authChoiceAlways', never: 'authChoiceNever'} as const satisfies Record<AuthChoice, UiKey>;
const decisionKeys = {
  asked: 'authDecisionAsked', allowed: 'authDecisionAllowed', always: 'authDecisionAlways', denied: 'authDecisionDenied',
  automatic: 'authDecisionAutomatic', blocked: 'authDecisionBlocked', expired: 'authDecisionExpired',
} as const satisfies Record<AuditDecision, UiKey>;
const outcomeKeys = {
  pending: 'authOutcomePending', none: 'authOutcomeNone', completed: 'authOutcomeCompleted', timeout: 'authOutcomeTimeout', stopped: 'authOutcomeStopped',
  hostStopped: 'authOutcomeHostStopped', noForwarding: 'authOutcomeNoForwarding', connectionLost: 'authOutcomeConnectionLost', failed: 'authOutcomeFailed',
} as const satisfies Record<AuditOutcome, UiKey>;

/** Settings, "Sign-in on hosts" (#1514): what a host's sign-in may do on this device, and what recently happened. */
export function AuthSignInSettings({hosts}: {hosts: readonly {id: string; name: string}[]}) {
  useUi();
  useAuthPolicy();
  const audit = useAuthAudit();
  const choice = (value: AuthChoice) => t(choiceKeys[value]);
  const options = (extra?: ReactNode) => <>{extra}{authChoices.map(value => <option key={value} value={value}>{choice(value)}</option>)}</>;
  return <section aria-label={t('authSettingsTitle')}>
    <p>{t('authSettingsIntro')}</p>
    <h3 className="settings-group-title">{t('authSettingsTunnel')}</h3>
    <label>{t('authSettingsTunnel')}<select value={defaultAuthChoice('tunnel')} aria-describedby="auth-tunnel-help" onChange={event => setDefaultAuthChoice('tunnel', event.target.value as AuthChoice)}>{options()}</select></label>
    <p id="auth-tunnel-help">{t('authSettingsTunnelHint')}</p>
    <h3 className="settings-group-title">{t('authSettingsHosts')}</h3>
    {hosts.map(host => <label key={host.id}>{t('authSettingsHostLabel', {host: host.name})}
      <select value={ownAuthChoice(host.id, 'tunnel') ?? ''} onChange={event => setHostAuthChoice(host.id, 'tunnel', event.target.value ? event.target.value as AuthChoice : undefined)}>
        {options(<option value="">{t('authSettingsHostDefault', {choice: choice(defaultAuthChoice('tunnel'))})}</option>)}
      </select></label>)}
    {!hosts.length && <p>{t('authSettingsNoHosts')}</p>}
    <h3 className="settings-group-title">{t('authAuditTitle')}</h3>
    <p>{t('authAuditPrivacy')}</p>
    {audit.blocked > 0 && <p>{t('authAuditBlocked', {count: audit.blocked})}</p>}
    {audit.entries.length ? <>
      <ol aria-label={t('authAuditTitle')}>{audit.entries.map(row => <li key={row.id}>
        <time dateTime={new Date(row.at).toISOString()}>{formatDateTime(row.at)}</time>{' '}
        {t('authAuditRow', {host: row.hostName, port: row.port, decision: t(decisionKeys[row.decision]), outcome: t(outcomeKeys[row.outcome])})}
      </li>)}</ol>
      <button type="button" onClick={clearAuthAudit}>{t('authAuditClear')}</button>
    </> : <p>{t('authAuditEmpty')}</p>}
  </section>;
}

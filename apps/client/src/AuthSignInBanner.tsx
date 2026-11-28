import {useId, useState} from 'react';
import {KeyRound} from 'lucide-react';
import {t, useUi, type UiKey} from './i18n/core';
import type {AuthTunnelEndReason} from './bridge';
import {authIntroSeen, markAuthIntroSeen} from './authPolicy';
import {signIn, useSignInRequests, type SignInRequest} from './authSignIn';
import './ConnectionBanner.css';
import './AuthSignIn.css';

const endedKeys = {
  callbackDelivered: 'authEndedCallbackDelivered', timeout: 'authEndedTimeout', cancelled: 'authEndedCancelled', sessionEnded: 'authEndedSessionEnded',
  lockEnded: 'authEndedLockEnded', hostStoppedListening: 'authEndedHostStoppedListening', forwardingDisabled: 'authEndedForwardingDisabled',
  controlConnectionLost: 'authEndedControlConnectionLost',
} as const satisfies Record<AuthTunnelEndReason, UiKey>;
const listenerKeys = {
  checking: 'authListenerChecking', confirmed: 'authListenerConfirmed', absent: 'authListenerAbsent', stale: 'authListenerStale', unproven: 'authListenerUnproven',
} as const satisfies Record<Exclude<SignInRequest['listener'], 'unknown'>, UiKey>;

function failureText(request: SignInRequest) {
  const {hostName: host, hint: {port}} = request;
  switch (request.failure) {
    case 'auth_tunnel_port_busy': return t('authFailPortBusy', {port});
    case 'auth_tunnel_port_not_permitted': return t('authFailPortNotPermitted', {port});
    case 'auth_tunnel_limit': return t('authFailLimit');
    case 'auth_tunnel_ssh_port': return t('authFailSshPort', {port, host});
    case 'auth_tunnel_denied': return t('authFailDenied', {host});
    // The engine's own sentence is app-written text with ports only; it stays as the engine wrote it.
    default: return [t('authFailGeneric', {port}), request.detail].filter(Boolean).join(' ');
  }
}
/** What the request says now: one sentence, the same one the screen reader hears. */
function statusText(request: SignInRequest) {
  const {hostName: host, hint: {port}} = request;
  switch (request.phase) {
    case 'asking': return request.collapsed ? t('authCollapsed', {host, port}) : t('authAskTitle', {host, port});
    case 'starting': return t('authStarting', {port});
    case 'active': return request.callback ? t('authCallback', {host, port}) : request.automatic ? t('authActiveAutomatic', {host, port}) : t('authActive', {port});
    case 'ended': return t(endedKeys[request.reason ?? 'cancelled'], {host, port});
    case 'failed': return failureText(request);
    case 'blocked': return t('authBlocked', {host, port});
  }
}

function Details({request, intro}: {request: SignInRequest; intro: boolean}) {
  const {hint, listener, otherUser} = request;
  const punycode = hint.idpHost?.split('.').some(label => label.startsWith('xn--'));
  return <>
    {intro && <p>{t('authFirstTime')}</p>}
    {hint.sensitive ? <p className="auth-signin-warning">{t('authSensitive', {port: hint.port})}</p> : <p>{t('authAskBody', {port: hint.port})}</p>}
    <p>{hint.idpHost ? t('authIdp', {idp: hint.idpHost}) : t('authIdpUnknown')}</p>
    {listener !== 'unknown' && <p>{t(listenerKeys[listener], {port: hint.port})}</p>}
    {otherUser && <p className="auth-signin-warning">{t('authOtherUser', {port: hint.port})}</p>}
    {!hint.pkce && <p className="auth-signin-warning">{t('authNoPkce')}</p>}
    {punycode && <p className="auth-signin-warning">{t('authPunycode')}</p>}
  </>;
}

type ButtonKey = 'authReview' | 'authTunnelAnyway' | 'authAllowOnce' | 'authAlways' | 'authDeny' | 'authStop' | 'authRetry' | 'authDismiss';
function Request({request}: {request: SignInRequest}) {
  const heading = useId();
  const [intro] = useState(() => request.phase === 'asking' && !authIntroSeen());
  const {key, phase, hint} = request;
  const answered = (action: () => void) => () => { markAuthIntroSeen(); action(); };
  const status = statusText(request);
  const asking = phase === 'asking';
  const open = asking && !request.collapsed;
  const button = (label: ButtonKey, action: () => void) => <button key={label} type="button" className="subtle-button" onClick={action}>{t(label)}</button>;
  return <section className="connection-banner auth-signin" aria-labelledby={heading} data-phase={phase}>
    <h2 id={heading} className="sr-only">{t('authRegionLabel', {host: request.hostName})}</h2>
    <p className="sr-only" role="status">{status}</p>
    <div className="connection-banner-text">
      <KeyRound size={16} aria-hidden="true"/>
      <div className="auth-signin-copy">
        <p><strong>{status}</strong></p>
        {open && <Details request={request} intro={intro}/>}
      </div>
    </div>
    <div className="connection-banner-actions">
      {asking && request.collapsed && button('authReview', () => signIn.expand(key))}
      {open && hint.sensitive && button('authTunnelAnyway', answered(() => signIn.allow(key, {confirmRisky: true})))}
      {open && !hint.sensitive && button('authAllowOnce', answered(() => signIn.allow(key)))}
      {open && !hint.sensitive && !request.otherUser && button('authAlways', answered(() => signIn.allow(key, {always: true})))}
      {asking && button('authDeny', answered(() => signIn.deny(key)))}
      {phase === 'active' && !request.callback && button('authStop', () => signIn.stop(key))}
      {phase === 'failed' && button('authRetry', () => signIn.retry(key))}
      {(phase === 'ended' || phase === 'failed' || phase === 'blocked') && button('authDismiss', () => signIn.dismiss(key))}
    </div>
  </section>;
}

/** Non-blocking notices for the sign-ins a session's host has started: ask, progress and result. Focus stays where it is. */
export function AuthSignInBanner({sessionId}: {sessionId: string}) {
  useUi();
  const requests = useSignInRequests(sessionId);
  if (!requests.length) return null;
  return <div className="auth-signin-stack">{requests.map(request => <Request key={request.key} request={request}/>)}</div>;
}

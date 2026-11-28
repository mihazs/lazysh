import './HostBrowserPanel.css';
import {useEffect, useId, useRef, useState} from 'react';
import {t, useUi, type UiKey} from './i18n/core';
import {uiErrorText} from './i18n/localError';
import {useHostBrowser, type HostBrowserPhase} from './hostBrowser/useHostBrowser';

const phaseLabel = (phase: HostBrowserPhase) => ({
  connecting: t('hostBrowserConnecting'), running: t('hostBrowserRunning'), paused: t('hostBrowserPaused'), closed: t('hostBrowserClosed'), failed: t('hostBrowserFailed'),
})[phase];
/** The reasons the relay and the app name, each with the words a person can act on; any other reason is shown as its code. */
const reasonTexts = {
  HostBrowserDisabled: 'hostBrowserReasonDisabled', BrowserNotFound: 'hostBrowserReasonNotFound', PageClosed: 'hostBrowserReasonPageClosed',
  BrowserExited: 'hostBrowserReasonBrowserExited', PageCrashed: 'hostBrowserReasonPageCrashed', AddressRefused: 'hostBrowserReasonAddress',
  ViewportInvalid: 'hostBrowserReasonViewport', HostBrowserUnsupported: 'hostBrowserReasonUnsupportedHost', ProtocolViolation: 'hostBrowserReasonProtocol',
  OpenTimeout: 'hostBrowserReasonTimeout', BrowserStartTimeout: 'hostBrowserReasonTimeout', StartTimeout: 'hostBrowserReasonTimeout',
  Disconnected: 'hostBrowserReasonDisconnected', ConnectFailed: 'hostBrowserReasonChannel', ChannelFailed: 'hostBrowserReasonChannel',
  ChannelEnded: 'hostBrowserReasonChannel', HostCommandFailed: 'hostBrowserReasonChannel', CompanionRequired: 'hostBrowserReasonCompanion',
  Stopped: 'hostBrowserReasonStopped', ClientClosed: 'hostBrowserReasonStopped',
} as const satisfies Record<string, UiKey>;

function reasonText(reason: string, detail?: string) {
  if (reason === 'BrowserVersionUnsupported') return t('hostBrowserReasonVersion', {version: detail ?? '?'});
  return reason in reasonTexts ? t(reasonTexts[reason as keyof typeof reasonTexts]) : t('hostBrowserReasonOther', {reason});
}

/** True while the app is in the foreground with its screen on, as far as the web view can tell. */
function useForeground() {
  const [foreground, setForeground] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const change = () => setForeground(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', change);
    return () => document.removeEventListener('visibilitychange', change);
  }, []);
  return foreground;
}

/**
 * The Host browser tool: a view-only live picture of one page of a browser on the host (docs/host-browser.md).
 * The page's title and address are untrusted and are only ever text. The relay is paused while `visible` is false,
 * the app is in the background or the screen is off.
 */
export default function HostBrowserPanel({sessionId, visible = true}: {sessionId: string; visible?: boolean}) {
  useUi();
  const heading = useId();
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const foreground = useForeground();
  const {phase, drawn, page, ended, stop, restart} = useHostBrowser({sessionId, canvas, stage, visible: visible && foreground});
  const over = phase === 'closed' || phase === 'failed';
  const reason = ended && ('error' in ended ? uiErrorText(ended.error) : reasonText(ended.reason, ended.detail));
  const stopped = !!ended && 'reason' in ended && ended.reason === 'Stopped';
  return <section className="tool-panel host-browser" aria-labelledby={heading} hidden={!visible}>
    <div className="tool-bar">
      <h3 id={heading}>{t('appHostBrowser')}</h3>
      <span className="host-browser-state" role="status" data-phase={phase}>{phaseLabel(phase)}</span>
      <button type="button" onClick={over ? restart : stop}>{over ? t('hostBrowserStart') : t('hostBrowserStopSession')}</button>
    </div>
    {over && reason && <p className="host-browser-reason" role={stopped ? undefined : 'alert'}>{reason}</p>}
    {page && !over && <dl className="host-browser-page">
      <dt>{t('hostBrowserPageTitle')}</dt><dd>{page.title || t('hostBrowserNoTitle')}</dd>
      <dt>{t('hostBrowserPageAddress')}</dt><dd>{page.url}</dd>
    </dl>}
    <div ref={stage} className="host-browser-stage" data-phase={phase}>
      <canvas ref={canvas} role="img" aria-label={t('hostBrowserCanvas')} hidden={over || !drawn} />
    </div>
    <p className="host-browser-note">{t('hostBrowserViewOnly')}</p>
  </section>;
}

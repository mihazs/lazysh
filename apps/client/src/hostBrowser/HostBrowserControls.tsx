import { ArrowLeft, ArrowRight, ExternalLink, Plus, RotateCw, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { t, useUi } from '../i18n/core';
import { normalizeAddress, openOnDevice, type AddressRefusal, type DeviceOpen } from './address';
import type { Blocked, Navigation, PageDialog, View } from './model';
import './HostBrowserControls.css';

const refusalText = (refusal: AddressRefusal) => {
  switch (refusal.reason) {
    case 'empty': return t('hostBrowserRefusedEmpty');
    case 'tooLong': return t('hostBrowserRefusedTooLong');
    case 'scheme': return t('hostBrowserRefusedScheme', { scheme: refusal.scheme });
    default: return t('hostBrowserRefusedInvalid');
  }
};
const blockedText = { download: 'hostBrowserBlockedDownload', fileChooser: 'hostBrowserBlockedFileChooser' } as const;
const dialogTitles = { alert: 'hostBrowserDialogAlert', confirm: 'hostBrowserDialogConfirm', prompt: 'hostBrowserDialogPrompt', beforeunload: 'hostBrowserDialogLeave' } as const;

/** A modal question with a heading and two answers. The focus starts on the safe one and Escape picks it. */
function Question({ title, caption, children, safe, danger, onSafe, onDanger }: {
  title: string; caption?: string; children?: ReactNode; safe: string; danger?: string; onSafe: () => void; onDanger?: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return <div className="dialog-backdrop host-browser-dialog" data-mobile-presentation="sheet">
    <div className="dialog" role="alertdialog" aria-modal="true" aria-label={title} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onSafe(); } }}>
      <div className="dialog-heading"><h2>{title}</h2></div>
      {caption && <p className="host-browser-untrusted-caption">{caption}</p>}
      {children}
      <div className="dialog-actions">
        <button ref={first} type="button" className="subtle-button" onClick={onSafe}>{safe}</button>
        {danger && <button type="button" className="primary-button" onClick={onDanger}>{danger}</button>}
      </div>
    </div>
  </div>;
}

/** A page's own alert, question, text request or leave-page warning. Its text is shown as text and marked as the page's. */
function PageQuestion({ dialog, navigation, failed }: { dialog: PageDialog; navigation: Navigation; failed: () => void }) {
  const [answer, setAnswer] = useState(dialog.defaultPrompt);
  const answerWith = (accept: boolean) => void navigation.answer(accept, dialog.kind === 'prompt' ? answer : undefined).catch(failed);
  const leaving = dialog.kind === 'beforeunload', alert = dialog.kind === 'alert';
  return <Question title={t(dialogTitles[dialog.kind])} caption={t('hostBrowserDialogUntrusted')}
    safe={leaving ? t('hostBrowserDialogStay') : alert ? t('hostBrowserDialogOk') : t('appCancel')}
    danger={alert ? undefined : leaving ? t('hostBrowserDialogLeaveButton') : t('hostBrowserDialogOk')}
    onSafe={() => answerWith(alert)} onDanger={() => answerWith(true)}>
    {dialog.message && <blockquote className="host-browser-page-text" dir="auto">{dialog.message}</blockquote>}
    {dialog.kind === 'prompt' && <label className="host-browser-answer">{t('hostBrowserDialogAnswer')}
      <input value={answer} onChange={event => setAnswer(event.target.value)} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
    </label>}
  </Question>;
}

/**
 * The host browser's address bar, tab list, back, forward, reload and stop, "Open on this device", the page's own
 * dialogs and the notices for what the browser refused to do. It shows page text as text and talks to the browser
 * only through `navigation`; what carries the page to the device is not its concern.
 *
 * `onOpenOnDevice` is how the app opens a Preview or the device's browser; without it the action is not offered.
 */
export function HostBrowserControls({ view, dialog, blocked, navigation, onDismiss, onOpenOnDevice }: {
  view: View; dialog: PageDialog | null; blocked: readonly Blocked[]; navigation: Navigation;
  onDismiss: (kind: Blocked) => void; onOpenOnDevice?: (target: DeviceOpen) => void;
}) {
  useUi();
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<AddressRefusal | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<Extract<DeviceOpen, { kind: 'external' }> | null>(null);
  const active = view.tabs.find(tab => tab.id === view.activeId);
  const plan = onOpenOnDevice && active ? openOnDevice(active.url) : undefined;
  // A refusal stays through the blur that a tap on another control causes: removing it then would move that control away from the tap.
  useEffect(() => setProblem(null), [active?.id, active?.url]);
  const run = (action: () => Promise<void>) => { setFailed(false); void action().catch(() => setFailed(true)); };

  function go(event: FormEvent) {
    event.preventDefault();
    const result = normalizeAddress(draft ?? active?.url ?? '');
    if (!result.ok) { setProblem(result.refusal); return; }
    setProblem(null); setDraft(null);
    run(() => navigation.navigate(result.url));
  }
  function openHere() {
    if (plan?.kind === 'external') setConfirming(plan);
    else if (plan) onOpenOnDevice?.(plan);
  }

  return <section className="host-browser-controls" aria-label={t('hostBrowserNavigation')}>
    <form className="host-browser-bar" onSubmit={go}>
      <button type="button" className="icon-button" aria-label={t('hostBrowserBack')} disabled={!view.canGoBack} onClick={() => run(() => navigation.back())}><ArrowLeft size={18} aria-hidden="true" /></button>
      <button type="button" className="icon-button" aria-label={t('hostBrowserForward')} disabled={!view.canGoForward} onClick={() => run(() => navigation.forward())}><ArrowRight size={18} aria-hidden="true" /></button>
      {view.loading
        ? <button type="button" className="icon-button" aria-label={t('hostBrowserStop')} onClick={() => run(() => navigation.stop())}><X size={18} aria-hidden="true" /></button>
        : <button type="button" className="icon-button" aria-label={t('hostBrowserReload')} disabled={!active} onClick={() => run(() => navigation.reload())}><RotateCw size={18} aria-hidden="true" /></button>}
      <input className="host-browser-address" type="text" inputMode="url" enterKeyHint="go" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={2048}
        aria-label={t('hostBrowserAddress')} aria-invalid={problem ? true : undefined} value={draft ?? active?.url ?? ''}
        onChange={event => { setDraft(event.target.value); setProblem(null); }}
        onFocus={event => event.currentTarget.select()} onBlur={() => setDraft(null)} />
      {plan && <button type="button" className="icon-button" title={t('hostBrowserOpenOnDevice')} aria-label={t('hostBrowserOpenOnDevice')} onClick={openHere}><ExternalLink size={18} aria-hidden="true" /></button>}
    </form>
    {problem && <p className="inline-error" role="alert">{refusalText(problem)}</p>}
    {failed && <p className="inline-error" role="alert">{t('hostBrowserActionFailed')}</p>}
    <ul className="host-browser-tabs" aria-label={t('hostBrowserTabs')}>
      {view.tabs.map(tab => {
        const name = tab.title || tab.url || t('hostBrowserUntitled');
        return <li key={tab.id} className="host-browser-tab" data-active={tab.id === view.activeId ? 'true' : undefined}>
          <button type="button" className="host-browser-tab-open" aria-current={tab.id === view.activeId ? 'page' : undefined} onClick={() => run(() => navigation.activate(tab.id))}>
            <bdi className="host-browser-tab-title">{name}</bdi>
            <bdi className="host-browser-tab-url">{tab.url}</bdi>
          </button>
          <button type="button" className="icon-button host-browser-tab-close" aria-label={t('hostBrowserCloseTab', { title: name })} onClick={() => run(() => navigation.closeTab(tab.id))}><X size={14} aria-hidden="true" /></button>
        </li>;
      })}
      <li><button type="button" className="icon-button" aria-label={t('hostBrowserNewTab')} title={t('hostBrowserNewTab')} onClick={() => run(() => navigation.newTab())}><Plus size={18} aria-hidden="true" /></button></li>
    </ul>
    <div className="host-browser-notices" role="status">
      {blocked.map(kind => <p key={kind}>{t(blockedText[kind])}<button type="button" className="subtle-button" onClick={() => onDismiss(kind)}>{t('hostBrowserDismiss')}</button></p>)}
    </div>
    {dialog && <PageQuestion key={`${dialog.kind}\n${dialog.message}\n${dialog.defaultPrompt}`} dialog={dialog} navigation={navigation} failed={() => setFailed(true)} />}
    {confirming && <Question title={t('hostBrowserOpenConfirm', { host: confirming.host })}
      safe={t('appCancel')} danger={t('hostBrowserOpen')} onSafe={() => setConfirming(null)}
      onDanger={() => { onOpenOnDevice?.(confirming); setConfirming(null); }}>
      <p>{t('hostBrowserOpenConfirmBody')}</p>
    </Question>}
  </section>;
}

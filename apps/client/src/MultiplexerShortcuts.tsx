import { useRef, useState } from 'react';
import { api as nativeApi } from './bridge';
import { useMountedAccess, useProtectedApi } from './access';
import { prefixedSteps, savePrefix, storedPrefix, validPrefix } from './multiplexerGestures';
import { errorMessage } from './SessionTools';

import {t, useUi, formatNumber} from './i18n/core';
import {LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';

type Kind = 'tmux' | 'rmux' | 'herdr';
export default function MultiplexerShortcuts({ sessionId, kind }: { sessionId: string; kind: Kind }) {
  const tmuxKeys = kind !== 'herdr';
  useUi();
  const api = useProtectedApi(nativeApi);
  const { access, mounted } = useMountedAccess();
  const [prefix, setPrefix] = useState(() => storedPrefix(kind));
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const valid = validPrefix(prefix);
  const controls = tmuxKeys
    ? [['muxShortcutNewWindow', 'c'], ['muxShortcutPreviousWindow', 'p'], ['muxShortcutNextWindow', 'n'], ['muxShortcutNextPane', 'o'], ['muxShortcutSplitHorizontal', '%'], ['muxShortcutSplitVertical', '"'], ['muxShortcutZoom', 'z'], ['muxShortcutCopy', '['], ['muxShortcutDetach', 'd']] as const
    : [['muxShortcutNewTab', 'c'], ['muxShortcutPreviousTab', 'p'], ['muxShortcutNextTab', 'n'], ['muxShortcutLeft', 'h'], ['muxShortcutDown', 'j'], ['muxShortcutUp', 'k'], ['muxShortcutRight', 'l'], ['muxShortcutSplitRight', 'v'], ['muxShortcutSplitDown', '-'], ['muxShortcutZoom', 'z'], ['muxShortcutDetach', 'q']] as const;
  async function send(step: string) {
    if (!valid || locked.current || !mounted.current || !access.current()) return;
    locked.current = true; setBusy(true); setError('');
    try { await api.writeSequence(sessionId, prefixedSteps(prefix, step)); }
    catch (e) { if (mounted.current && access.current()) setError(errorMessage(e)); }
    finally { if (mounted.current && access.current()) {locked.current = false; setBusy(false);} }
  }
  function save() {
    if (!mounted.current || !access.current()) return;
    if (!valid) { setError(new LocalUiError('muxShortcutInvalid')); return; }
    try { savePrefix(kind, prefix); setError(''); }
    catch { setError(new LocalUiError('muxShortcutSaveFailed')); }
  }
  return <section aria-label={t('muxShortcutRegion',{kind})}><h3>{t('muxShortcutHeading',{kind})}</h3><p>{t('muxShortcutBindings')}</p>
    <label>{t('muxShortcutPrefix')}<input maxLength={64} value={prefix} disabled={busy} onChange={e => setPrefix(e.target.value)} placeholder={'Ctrl+b'} /></label><button className="subtle-button" disabled={busy || !valid} onClick={save}>{t('muxShortcutSave')}</button>
    {!valid && <p>{t('muxShortcutHint')}</p>}{error && <p className="inline-error" role="alert">{uiErrorText(error)}</p>}
    <div className="mux-shortcuts">{controls.map(([label, step]) => <button className="subtle-button" key={label} disabled={busy || !valid} onClick={() => void send(step)}>{t(label)}</button>)}
      {Array.from({ length: tmuxKeys ? 10 : 9 }, (_, index) => index + (tmuxKeys ? 0 : 1)).map(index => <button className="subtle-button" key={index} disabled={busy || !valid} onClick={() => void send(String(index))}>{t(tmuxKeys ? 'muxShortcutWindow' : 'muxShortcutTab',{index:formatNumber(index)})}</button>)}
    </div>
  </section>;
}

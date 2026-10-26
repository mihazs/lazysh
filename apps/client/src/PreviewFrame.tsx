import {t, useUi} from './i18n/core';
import { useEffect, useRef, useState } from 'react';
import { elementSelection, type ElementSelection } from './previewAnnotations';

type Props = { url: string; port: number; token?: string | null; onSelection: (selection: ElementSelection) => void; onNavigate?: () => void };
export default function PreviewFrame({ url, port, token, onSelection, onNavigate }: Props) {
  useUi();
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<'previewPickerWaiting' | 'previewPickerReady' | 'previewPickerSelectHint' | 'previewPickerCancelled' | 'previewPickerSelected' | 'previewPickerInvalidSelection' | 'previewPickerUnavailable' | 'previewPickerStarting' | 'previewPickerNotStarted'>('previewPickerWaiting');
  const armed = useRef<'idle' | 'starting' | 'active'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = new URL(url).origin;
  function send(action: string) { frame.current?.contentWindow?.postMessage({ type: 'lazysh-picker', action, token, channel: channel.current }, origin); }
  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = event.data;
      if (!token || !channel.current || event.source !== frame.current?.contentWindow || event.origin !== origin || !data || typeof data !== 'object' || data.type !== 'lazysh-picker' || data.token !== token || data.channel !== channel.current) return;
      if (data.action === 'ready') { clearTimeout(timer.current); setReady(true); setStatus('previewPickerReady'); }
      if (data.action === 'started' && armed.current === 'starting') { armed.current = 'active'; clearTimeout(timer.current); setStarting(false); setPicking(true); setStatus('previewPickerSelectHint'); }
      if (data.action === 'cancel') { clearTimeout(timer.current); armed.current = 'idle'; setStarting(false); setPicking(false); setStatus('previewPickerCancelled'); }
      if (data.action === 'selection' && armed.current === 'active') {
        armed.current = 'idle'; setStarting(false); setPicking(false); send('stop');
        try { onSelection(elementSelection(data)); setStatus('previewPickerSelected'); }
        catch { setStatus('previewPickerInvalidSelection'); }
      }
    }
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); clearTimeout(timer.current); armed.current = 'idle'; };
  }, [token, origin, onSelection]);
  function loaded() {
    armed.current = 'idle'; channel.current = crypto.randomUUID(); setStarting(false); setPicking(false); setReady(false); clearTimeout(timer.current); onNavigate?.();
    if (!token) return;
    setStatus('previewPickerWaiting'); send('init');
    timer.current = setTimeout(() => setStatus('previewPickerUnavailable'), 2000);
  }
  return <>
    {token && <div className="preview-picker"><button className="subtle-button" disabled={!ready || starting} aria-pressed={picking} onClick={() => { if (picking) { armed.current = 'idle'; setPicking(false); send('stop'); setStatus('previewPickerCancelled'); } else { armed.current = 'starting'; setStarting(true); send('start'); setStatus('previewPickerStarting'); timer.current = setTimeout(() => { armed.current = 'idle'; setStarting(false); send('stop'); setStatus('previewPickerNotStarted'); }, 2000); } }}>{starting ? t('previewPickerStarting') : picking ? t('previewPickerCancel') : t('previewPickerSelect')}</button><p className="agent-note" role="status">{t(status)}</p></div>}
    <iframe ref={frame} className="preview-frame" title={t('previewFrameTitle',{port})} src={url} onLoad={loaded} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" />
  </>;
}

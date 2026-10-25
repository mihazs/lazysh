import { useEffect, useRef, useState } from 'react';
import { elementSelection, type ElementSelection } from './previewAnnotations';

type Props = { url: string; port: number; token?: string | null; onSelection: (selection: ElementSelection) => void; onNavigate?: () => void };
export default function PreviewFrame({ url, port, token, onSelection, onNavigate }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [picking, setPicking] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState('Waiting for the element picker…');
  const armed = useRef<'idle' | 'starting' | 'active'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const origin = new URL(url).origin;
  function send(action: string) { frame.current?.contentWindow?.postMessage({ type: 'lazysh-picker', action, token, channel: channel.current }, origin); }
  useEffect(() => {
    function receive(event: MessageEvent) {
      const data = event.data;
      if (!token || !channel.current || event.source !== frame.current?.contentWindow || event.origin !== origin || !data || typeof data !== 'object' || data.type !== 'lazysh-picker' || data.token !== token || data.channel !== channel.current) return;
      if (data.action === 'ready') { clearTimeout(timer.current); setReady(true); setStatus('Element picker ready.'); }
      if (data.action === 'started' && armed.current === 'starting') { armed.current = 'active'; clearTimeout(timer.current); setStarting(false); setPicking(true); setStatus('Select an element in the preview. Escape cancels. Input values are excluded.'); }
      if (data.action === 'cancel') { clearTimeout(timer.current); armed.current = 'idle'; setStarting(false); setPicking(false); setStatus('Element selection cancelled.'); }
      if (data.action === 'selection' && armed.current === 'active') {
        armed.current = 'idle'; setStarting(false); setPicking(false); send('stop');
        try { onSelection(elementSelection(data)); setStatus('Element selected. Review the page data and add your comment before staging.'); }
        catch { setStatus('The page returned invalid element data. Select again or enter a manual note.'); }
      }
    }
    window.addEventListener('message', receive);
    return () => { window.removeEventListener('message', receive); clearTimeout(timer.current); armed.current = 'idle'; };
  }, [token, origin, onSelection]);
  function loaded() {
    armed.current = 'idle'; channel.current = crypto.randomUUID(); setStarting(false); setPicking(false); setReady(false); clearTimeout(timer.current); onNavigate?.();
    if (!token) return;
    setStatus('Waiting for the element picker…'); send('init');
    timer.current = setTimeout(() => setStatus('Element picker unavailable for this page. Its content type, size, encoding or security policy may prevent it. Manual notes remain available.'), 2000);
  }
  return <>
    {token && <div className="preview-picker"><button className="subtle-button" disabled={!ready || starting} aria-pressed={picking} onClick={() => { if (picking) { armed.current = 'idle'; setPicking(false); send('stop'); setStatus('Element selection cancelled.'); } else { armed.current = 'starting'; setStarting(true); send('start'); setStatus('Starting element selection…'); timer.current = setTimeout(() => { armed.current = 'idle'; setStarting(false); send('stop'); setStatus('Element picker did not start. Try again or enter a manual note.'); }, 2000); } }}>{starting ? 'Starting element selection…' : picking ? 'Cancel element selection' : 'Select page element'}</button><p className="agent-note" role="status">{status}</p></div>}
    <iframe ref={frame} className="preview-frame" title={`Host browser preview on port ${port}`} src={url} onLoad={loaded} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" />
  </>;
}

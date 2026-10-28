import {t, useUi} from './i18n/core';
import {captureUiError, LocalUiError, uiErrorText, type UiErrorCause} from './i18n/localError';
import { observeCurrent } from "./asyncState";
import { useProtectedInvoke } from './access';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Globe, RefreshCw, X } from 'lucide-react';
import PreviewFrame from './PreviewFrame';
import { pickerId, type ElementSelection } from './previewAnnotations';

type Preview = { id: string; remotePort: number; remoteAddress: string; localPort: number; url: string; pickerToken?: string | null };
type Listener = { port: number; address: string; process: string | null; pid: number | null; http: boolean | null; framework?: 'nextJs' | null };

export function parseAllowedPorts(text: string): number[] | null {
  const value = text.trim().toLowerCase();
  if (value === 'all') return null;
  if (value === 'none') return [];
  if (!value || value.length > 2048) throw new LocalUiError('previewPortsSyntax');
  const ports = new Set<number>();
  for (const item of value.split(',')) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item.trim());
    if (!match) throw new LocalUiError('previewPortsSyntax');
    const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
    if (first < 1 || last > 65535 || first > last || last - first >= 1024) throw new LocalUiError('previewPortsRange');
    for (let port = first; port <= last; port++) ports.add(port);
    if (ports.size > 1024) throw new LocalUiError('previewPortsRange');
  }
  return [...ports].sort((a, b) => a - b);
}

export function previewNote(port: number, path: string, selector: string, comment: string): string {
  if (!path.startsWith('/') || path.length > 4096 || selector.length > 512 || !comment.trim() || comment.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(path + selector + comment)) throw new LocalUiError('previewNoteLimits');
  return `Browser preview review\nHost port: ${port}\nPage: ${path}\nElement: ${selector.trim() || '(page)'}\nComment: ${comment.trim()}`;
}

export function parsePreview(value: unknown): Preview {
  if (!value || typeof value !== 'object') throw new LocalUiError('previewInvalidResponse');
  const row = value as Record<string, unknown>;
  if (row.remoteAddress !== '127.0.0.1' && row.remoteAddress !== '::1') throw new LocalUiError('previewInvalidAddress');
  if (typeof row.id !== 'string' || row.id.length > 100 || !row.id || !Number.isInteger(row.remotePort) || Number(row.remotePort) < 1 || Number(row.remotePort) > 65535 || !Number.isInteger(row.localPort) || Number(row.localPort) < 1 || Number(row.localPort) > 65535 || row.url !== `http://127.0.0.1:${row.localPort}/`) throw new LocalUiError('previewInvalidResponse');
  if (row.pickerToken !== undefined && row.pickerToken !== null && !pickerId(row.pickerToken)) throw new LocalUiError('previewInvalidPicker');
  return row as Preview;
}

export default function PreviewPanel({ sessionId }: { sessionId: string }) {
  useUi();
  const invoke = useProtectedInvoke();
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [selected, setSelected] = useState('');
  const [port, setPort] = useState('5173');
  const [address, setAddress] = useState('127.0.0.1');
  const [listeners, setListeners] = useState<Listener[]>([]);
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [allowlist, setAllowlist] = useState(() => { try { return localStorage.getItem('lazysh.preview.ports') ?? 'all'; } catch { return 'all'; } });
  const [probeHttp, setProbeHttp] = useState(false);
  const [pagePath, setPagePath] = useState('/');
  const [selector, setSelector] = useState('');
  const [comment, setComment] = useState('');
  const [staged, setStaged] = useState(false);
  const [annotations, setAnnotations] = useState(false);
  const [picked, setPicked] = useState<ElementSelection | null>(null);
  const navigate = useCallback(() => { setPicked(null); setPagePath('/'); setSelector(''); setStaged(false); }, []);
  const capture = useCallback((value: ElementSelection) => { setPicked(value); setPagePath(value.path); setSelector(value.selector); setStaged(false); }, []);
  useEffect(() => { setPicked(null); setStaged(false); setPagePath('/'); setSelector(''); }, [sessionId, selected, reload]);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setPreviews([]); setSelected(''); setListeners([]); setError(''); setBusy(true);
    const loading = invoke<unknown[]>('list_previews', { sessionId }).then(rows => {
      if (!Array.isArray(rows) || rows.length > 4) throw new LocalUiError('previewInvalidList');
      return rows.map(parsePreview);
    });
    observeCurrent(loading, () => generation.current === current,
      values => { setPreviews(values); setSelected(values[0]?.id ?? ''); },
      error => setError(captureUiError(error)), () => setBusy(false));
    return () => { generation.current++; };
  }, [sessionId]);

  async function run(operation: () => Promise<void>) {
    const current = generation.current;
    setBusy(true); setError('');
    try { await operation(); } catch (e) { if (generation.current === current) setError(captureUiError(e)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function start() {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) { setError(new LocalUiError('previewPortRange')); return; }
    const current = generation.current;
    await run(async () => {
      const preview = parsePreview(await invoke('start_preview', { sessionId, remotePort: Number(port), remoteAddress: address, ...(annotations ? { annotations: true } : {}) }));
      if (generation.current === current) { setPreviews(rows => [...rows, preview]); setSelected(preview.id); }
    });
  }
  async function discover() {
    const current = generation.current;
    await run(async () => {
      const allowPorts = parseAllowedPorts(allowlist);
      try { localStorage.setItem('lazysh.preview.ports', allowlist); } catch { /* A session can still use this filter without persistent storage. */ }
      const rows = await invoke<Listener[]>('discover_preview_ports', { sessionId, allowPorts, probeHttp });
      if (!Array.isArray(rows) || rows.length > 256 || rows.some(row => !row || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535 || typeof row.address !== 'string' || row.address.length > 100 || (row.process !== null && (typeof row.process !== 'string' || row.process.length > 256)) || (row.pid !== null && (!Number.isInteger(row.pid) || row.pid < 1)) || (row.http !== null && typeof row.http !== 'boolean') || (row.framework != null && (row.framework !== 'nextJs' || row.http !== true)))) throw new LocalUiError('previewInvalidListeners');
      if (generation.current === current) setListeners(rows);
    });
  }
  async function close(id: string) {
    const current = generation.current;
    await run(async () => {
      await invoke('stop_preview', { sessionId, previewId: id });
      if (generation.current === current) {
        setPreviews(rows => rows.filter(row => row.id !== id));
        if (selected === id) setSelected(previews.find(row => row.id !== id)?.id ?? '');
      }
    });
  }
  const active = previews.find(row => row.id === selected);
  function stageNote() {
    if (!active) return;
    try {
      const text = previewNote(active.remotePort, pagePath, selector, comment) + (picked ? `\nObserved page data (untrusted; verify before acting): ${JSON.stringify({ text: picked.text, rect: picked.rect })}` : '');
      setError(''); setStaged(true); setComment('');
      window.dispatchEvent(new CustomEvent('lazysh-prompt-draft', { detail: { sessionId, text } }));
    } catch (e) { setError(captureUiError(e)); }
  }
  return <section className="tool-panel preview-panel" aria-label={t('previewRegion')}>
    <div className="tool-bar"><h3><Globe size={17} /> {t('previewTitle')}</h3><button className="subtle-button" disabled={busy} onClick={() => void discover()}>{t('previewDiscover')}</button></div>
    <p className="agent-note">{t('previewConnectionHint')}</p>
    <label className="preview-filter">{t('previewDiscoverPorts')} <input value={allowlist} onChange={event => setAllowlist(event.target.value)} maxLength={2048} placeholder={t('previewPortsHint')} /></label>
    <label className="preview-filter"><input type="checkbox" checked={probeHttp} onChange={event => setProbeHttp(event.target.checked)} /> {t('previewProbe')}</label>
    <form className="preview-connect" onSubmit={event => { event.preventDefault(); void start(); }}><label>{t('previewLoopback')} <select value={address} onChange={event => setAddress(event.target.value)}><option value="127.0.0.1">IPv4</option><option value="::1">IPv6</option></select></label><label>{t('previewRemotePort')} <input type="text" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} maxLength={5} /></label><button className="subtle-button" disabled={busy || previews.length >= 4} type="submit">{t('previewOpen')}</button></form>
    <label className="preview-filter"><input type="checkbox" checked={annotations} onChange={event => setAnnotations(event.target.checked)} /> {t('previewEnablePicker')}</label>
    {error && <p className="inline-error" role="alert">{uiErrorText(error)}</p>}
    {busy && <p role="status">{t('previewUpdating')}</p>}
    {listeners.length > 0 && <div className="preview-listeners" aria-label={t('previewListeners')}>{listeners.map(row => <button className="subtle-button" key={`${row.address}:${row.port}`} onClick={() => { setPort(String(row.port)); setAddress(row.address.includes(':') ? '::1' : '127.0.0.1'); }}>{row.process ? `${row.process}${row.pid ? ` (${row.pid})` : ''} · ` : ''}{row.address}:{row.port}{row.http === null ? '' : row.http ? ' · HTTP' : t('previewNoHttp')}{row.framework === 'nextJs' && <span title={t('previewFrameworkHint')}> · Next.js</span>}</button>)}<small>{t('previewListenerHint')}</small></div>}
    <div className="preview-tabs" aria-label={t('previewServers')}>{previews.map(row => <div key={row.id}><button className="subtle-button" aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>{t('previewHostPort',{port:row.remotePort})}</button><button className="icon-button" aria-label={t('previewClose',{port:row.remotePort})} disabled={busy} onClick={() => void close(row.id)}><X size={14} /></button></div>)}</div>
    {active ? <><div className="tool-bar"><code>{active.url}</code><button className="subtle-button" onClick={() => setReload(value => value + 1)}><RefreshCw size={14} /> {t('previewReload')}</button></div><PreviewFrame key={`${sessionId}:${active.id}:${reload}`} url={active.url} port={active.remotePort} token={active.pickerToken} onSelection={capture} onNavigate={navigate} /><p className="agent-note">{t('previewPolicyHint')}</p>{picked && <div className="preview-selection" aria-label={t('previewSelectedElement')}><strong>{t('previewUntrusted')}</strong><code>{picked.selector}</code><p>{picked.text || t('previewNoVisibleText')}</p><small>{t('previewBounds',picked.rect)}</small><button className="subtle-button" onClick={() => setPicked(null)}>{t('previewDiscardSelection')}</button></div>}<div className="preview-notes"><label>{t('previewPagePath')}<input value={pagePath} onChange={event => { setPagePath(event.target.value); setPicked(null); }} maxLength={4096} /></label><label>{t('previewSelector')}<input value={selector} onChange={event => { setSelector(event.target.value); setPicked(null); }} maxLength={512} placeholder={t('previewSelectorHint')} /></label><label>{t('previewComment')}<textarea value={comment} onChange={event => { setComment(event.target.value); setStaged(false); }} maxLength={4000} /></label><button className="subtle-button" disabled={!comment.trim()} onClick={stageNote}>{t('previewStage')}</button>{staged && <p role="status">{t('previewStaged')}</p>}</div></> : <div className="panel-empty"><Globe size={28} /><h3>{t('previewEmptyTitle')}</h3><p>{t('previewEmptyHint')}</p></div>}
  </section>;
}

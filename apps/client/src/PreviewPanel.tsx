import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Globe, RefreshCw, X } from 'lucide-react';
import { errorMessage } from './SessionTools';
import PreviewFrame from './PreviewFrame';
import { pickerId, type ElementSelection } from './previewAnnotations';

type Preview = { id: string; remotePort: number; remoteAddress: string; localPort: number; url: string; pickerToken?: string | null };
type Listener = { port: number; address: string; process: string | null; pid: number | null; http: boolean | null };

export function parseAllowedPorts(text: string): number[] | null {
  const value = text.trim().toLowerCase();
  if (value === 'all') return null;
  if (value === 'none') return [];
  if (!value || value.length > 2048) throw new Error('Use all, none, or ports such as 3000,8000-8010.');
  const ports = new Set<number>();
  for (const item of value.split(',')) {
    const match = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(item.trim());
    if (!match) throw new Error('Use all, none, or ports such as 3000,8000-8010.');
    const first = Number(match[1]); const last = Number(match[2] ?? match[1]);
    if (first < 1 || last > 65535 || first > last || last - first >= 1024) throw new Error('Choose at most 1024 ports from 1 to 65535.');
    for (let port = first; port <= last; port++) ports.add(port);
    if (ports.size > 1024) throw new Error('Choose at most 1024 ports from 1 to 65535.');
  }
  return [...ports].sort((a, b) => a - b);
}

export function previewNote(port: number, path: string, selector: string, comment: string): string {
  if (!path.startsWith('/') || path.length > 4096 || selector.length > 512 || !comment.trim() || comment.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(path + selector + comment)) throw new Error('Enter a page path and a comment within the field limits.');
  return `Browser preview review\nHost port: ${port}\nPage: ${path}\nElement: ${selector.trim() || '(page)'}\nComment: ${comment.trim()}`;
}

export function parsePreview(value: unknown): Preview {
  if (!value || typeof value !== 'object') throw new Error('Invalid preview response.');
  const row = value as Record<string, unknown>;
  if (row.remoteAddress !== '127.0.0.1' && row.remoteAddress !== '::1') throw new Error('Invalid preview address.');
  if (typeof row.id !== 'string' || row.id.length > 100 || !row.id || !Number.isInteger(row.remotePort) || Number(row.remotePort) < 1 || Number(row.remotePort) > 65535 || !Number.isInteger(row.localPort) || Number(row.localPort) < 1 || Number(row.localPort) > 65535 || row.url !== `http://127.0.0.1:${row.localPort}/`) throw new Error('Invalid preview response.');
  if (row.pickerToken !== undefined && row.pickerToken !== null && !pickerId(row.pickerToken)) throw new Error('Invalid preview picker.');
  return row as Preview;
}

export default function PreviewPanel({ sessionId }: { sessionId: string }) {
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [selected, setSelected] = useState('');
  const [port, setPort] = useState('5173');
  const [address, setAddress] = useState('127.0.0.1');
  const [listeners, setListeners] = useState<Listener[]>([]);
  const [error, setError] = useState('');
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
    void invoke<unknown[]>('list_previews', { sessionId }).then(rows => {
      if (!Array.isArray(rows) || rows.length > 4) throw new Error('Invalid preview list.');
      const values = rows.map(parsePreview);
      if (generation.current === current) { setPreviews(values); setSelected(values[0]?.id ?? ''); }
    }).catch(e => { if (generation.current === current) setError(errorMessage(e)); }).finally(() => { if (generation.current === current) setBusy(false); });
    return () => { generation.current++; };
  }, [sessionId]);

  async function run(operation: () => Promise<void>) {
    const current = generation.current;
    setBusy(true); setError('');
    try { await operation(); } catch (e) { if (generation.current === current) setError(errorMessage(e)); }
    finally { if (generation.current === current) setBusy(false); }
  }
  async function start() {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) { setError('Enter a port from 1 to 65535.'); return; }
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
      if (!Array.isArray(rows) || rows.length > 256 || rows.some(row => !row || !Number.isInteger(row.port) || row.port < 1 || row.port > 65535 || typeof row.address !== 'string' || row.address.length > 100 || (row.process !== null && (typeof row.process !== 'string' || row.process.length > 256)) || (row.pid !== null && (!Number.isInteger(row.pid) || row.pid < 1)) || (row.http !== null && typeof row.http !== 'boolean'))) throw new Error('Invalid listener list.');
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
    } catch (e) { setError(errorMessage(e)); }
  }
  return <section className="tool-panel preview-panel" aria-label="Browser previews">
    <div className="tool-bar"><h3><Globe size={17} /> Browser preview</h3><button className="subtle-button" disabled={busy} onClick={() => void discover()}>Discover listeners</button></div>
    <p className="agent-note">Choose your host's HTTP port. The preview uses this SSH connection and closes when the session ends.</p>
    <label className="preview-filter">Discover ports <input value={allowlist} onChange={event => setAllowlist(event.target.value)} maxLength={2048} placeholder="all, none, or 3000,8000-8010" /></label>
    <label className="preview-filter"><input type="checkbox" checked={probeHttp} onChange={event => setProbeHttp(event.target.checked)} /> Check for HTTP on discovery (sends HEAD requests to the filtered host ports)</label>
    <form className="preview-connect" onSubmit={event => { event.preventDefault(); void start(); }}><label>Host loopback <select value={address} onChange={event => setAddress(event.target.value)}><option value="127.0.0.1">IPv4</option><option value="::1">IPv6</option></select></label><label>Remote port <input type="text" inputMode="numeric" value={port} onChange={event => setPort(event.target.value)} maxLength={5} /></label><button className="subtle-button" disabled={busy || previews.length >= 4} type="submit">Open preview</button></form>
    <label className="preview-filter"><input type="checkbox" checked={annotations} onChange={event => setAnnotations(event.target.checked)} /> Enable element picker for new previews (optional HTTP proxy)</label>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {busy && <p role="status">Updating preview…</p>}
    {listeners.length > 0 && <div className="preview-listeners" aria-label="Detected TCP listeners">{listeners.map(row => <button className="subtle-button" key={`${row.address}:${row.port}`} onClick={() => { setPort(String(row.port)); setAddress(row.address.includes(':') ? '::1' : '127.0.0.1'); }}>{row.process ? `${row.process}${row.pid ? ` (${row.pid})` : ''} · ` : ''}{row.address}:{row.port}{row.http === null ? '' : row.http ? ' · HTTP' : ' · No HTTP response'}</button>)}<small>TCP listeners may include services that do not speak HTTP. Select a port, then open it.</small></div>}
    <div className="preview-tabs" aria-label="Forwarded servers">{previews.map(row => <div key={row.id}><button className="subtle-button" aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>Host :{row.remotePort}</button><button className="icon-button" aria-label={`Close preview ${row.remotePort}`} disabled={busy} onClick={() => void close(row.id)}><X size={14} /></button></div>)}</div>
    {active ? <><div className="tool-bar"><code>{active.url}</code><button className="subtle-button" onClick={() => setReload(value => value + 1)}><RefreshCw size={14} /> Reload</button></div><PreviewFrame key={`${sessionId}:${active.id}:${reload}`} url={active.url} port={active.remotePort} token={active.pickerToken} onSelection={capture} onNavigate={navigate} /><p className="agent-note">Servers that block framing cannot display here. Picker mode preserves page security policies; some pages permit only manual notes.</p>{picked && <div className="preview-selection" aria-label="Selected page element"><strong>Page data · untrusted</strong><code>{picked.selector}</code><p>{picked.text || '(No visible text)'}</p><small>Bounds: {picked.rect.x}, {picked.rect.y} · {picked.rect.width} × {picked.rect.height} CSS pixels</small><button className="subtle-button" onClick={() => setPicked(null)}>Discard selection</button></div>}<div className="preview-notes"><label>Page path<input value={pagePath} onChange={event => { setPagePath(event.target.value); setPicked(null); }} maxLength={4096} /></label><label>Element selector (optional)<input value={selector} onChange={event => { setSelector(event.target.value); setPicked(null); }} maxLength={512} placeholder="#submit or .navigation" /></label><label>Comment<textarea value={comment} onChange={event => { setComment(event.target.value); setStaged(false); }} maxLength={4000} /></label><button className="subtle-button" disabled={!comment.trim()} onClick={stageNote}>Stage note in prompt</button>{staged && <p role="status">Note added to the prompt draft. Review it before sending.</p>}</div></> : <div className="panel-empty"><Globe size={28} /><h3>Open your development server.</h3><p>Start a server on the host, then enter its port.</p></div>}
  </section>;
}

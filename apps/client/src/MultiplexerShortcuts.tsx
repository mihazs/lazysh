import { useEffect, useRef, useState } from 'react';
import { api as nativeApi } from './bridge';
import { useMountedAccess, useProtectedApi } from './access';
import { parseChordSteps } from './preferences';
import { errorMessage } from './SessionTools';

type Kind = 'tmux' | 'herdr';
export default function MultiplexerShortcuts({ sessionId, kind }: { sessionId: string; kind: Kind }) {
  const api = useProtectedApi(nativeApi);
  const { access, mounted } = useMountedAccess();
  const key = `lazysh.multiplexer.prefix.${kind}`;
  const [prefix, setPrefix] = useState(() => { try { return localStorage.getItem(key) || 'Ctrl+b'; } catch { return 'Ctrl+b'; } });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  let valid = false;
  try { if (!prefix.startsWith('text:') && !/\s/.test(prefix.trim())) { valid = parseChordSteps(prefix).length === 1; } } catch { /* Invalid prefixes keep controls disabled. */ }
  const controls = kind === 'tmux'
    ? [['New window', 'c'], ['Previous window', 'p'], ['Next window', 'n'], ['Next pane', 'o'], ['Split left/right', '%'], ['Split top/bottom', '"'], ['Zoom pane', 'z'], ['Copy mode', '['], ['Detach', 'd']]
    : [['New tab', 'c'], ['Previous tab', 'p'], ['Next tab', 'n'], ['Pane left', 'h'], ['Pane down', 'j'], ['Pane up', 'k'], ['Pane right', 'l'], ['Split right', 'v'], ['Split down', '-'], ['Zoom pane', 'z'], ['Detach', 'q']];
  async function send(step: string) {
    if (!valid || locked.current || !mounted.current || !access.current()) return;
    locked.current = true; setBusy(true); setError('');
    try { await api.writeSequence(sessionId, [...parseChordSteps(prefix), ...parseChordSteps(step)]); }
    catch (e) { if (mounted.current && access.current()) setError(errorMessage(e)); }
    finally { if (mounted.current && access.current()) {locked.current = false; setBusy(false);} }
  }
  function save() {
    if (!mounted.current || !access.current()) return;
    if (!valid) { setError('Enter one valid prefix key, for example Ctrl+b or F12.'); return; }
    try { localStorage.setItem(key, prefix); setError(''); }
    catch { setError('Prefix works for this session, but could not be saved.'); }
  }
  return <section aria-label={`${kind} prefix shortcuts`}><h3>{kind} shortcuts</h3><p>Uses the host's default action bindings with your configured prefix key.</p>
    <label>Multiplexer prefix key<input maxLength={64} value={prefix} disabled={busy} onChange={e => setPrefix(e.target.value)} placeholder="Ctrl+b" /></label><button className="subtle-button" disabled={busy || !valid} onClick={save}>Save prefix key</button>
    {!valid && <p>Enter one key step, such as Ctrl+b or F12.</p>}{error && <p className="inline-error" role="alert">{error}</p>}
    <div className="mux-shortcuts">{controls.map(([label, step]) => <button className="subtle-button" key={label} disabled={busy || !valid} onClick={() => void send(step)}>{label}</button>)}
      {Array.from({ length: kind === 'tmux' ? 10 : 9 }, (_, index) => index + (kind === 'tmux' ? 0 : 1)).map(index => <button className="subtle-button" key={index} disabled={busy || !valid} onClick={() => void send(String(index))}>{kind === 'tmux' ? 'Window' : 'Tab'} {index}</button>)}
    </div>
  </section>;
}

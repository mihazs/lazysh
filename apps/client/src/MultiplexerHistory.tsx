import { useMemo, useRef, useState } from 'react';
import { useMountedAccess, useProtectedInvoke } from './access';
import { CopyButton } from './AgentReading';
import { errorMessage } from './SessionTools';
import { formatNumber, t, useUi } from './i18n/core';
import type { SessionAttachment } from './workspace';

type Read = { text: string; lines: number; truncated: boolean };
/** Herdr serves at most this many of a pane's newest lines; the host command is bounded the same way. */
const herdrLines = 1000;

/** The scrollback of the pane the attached multiplexer shows, read on the host (not the client's buffer), read-only with a line filter and Copy. */
export default function MultiplexerHistory({ sessionId, attached }: { sessionId: string; attached: SessionAttachment }) {
  useUi();
  const invoke = useProtectedInvoke();
  const { access, mounted } = useMountedAccess();
  const [read, setRead] = useState<Read | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const current = () => mounted.current && access.current();
  async function load() {
    if (lock.current || !current()) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const value = await invoke<Read>('multiplexer_history', { sessionId, kind: attached.kind, name: attached.name, ...(attached.kind === 'tmux' && attached.tmuxServer ? { tmuxServer: attached.tmuxServer } : {}) });
      if (current()) setRead(value);
    } catch (e) { if (current()) setError(errorMessage(e)); }
    finally { lock.current = false; if (current()) setBusy(false); }
  }
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => {
    if (!read) return null;
    if (!needle) return { text: read.text, count: read.lines };
    const rows = read.text.split('\n').filter(line => line.toLowerCase().includes(needle));
    return { text: rows.join('\n'), count: rows.length };
  }, [read, needle]);
  return <section aria-label={t('muxHistoryTitle')}>
    <div className="tool-bar"><h3>{t('muxHistoryTitle')}</h3><button className="subtle-button" disabled={busy} onClick={() => void load()}>{read ? t('agentsRefresh') : t('muxHistoryRead')}</button></div>
    {busy && <p className="loading" role="status">{t('muxHistoryReading')}</p>}
    {error && <p className="inline-error" role="alert">{error}</p>}
    {read && shown && <>
      <p className="muted">{t('muxHistoryScope', { kind: attached.kind })}</p>
      {read.truncated && <p className="security-note" role="note">{attached.kind === 'herdr' ? t('muxHistoryCutHerdr', { limit: formatNumber(herdrLines) }) : t('muxHistoryCut')}</p>}
      <div className="tool-bar"><label>{t('muxHistorySearch')}<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        {shown.text && <CopyButton text={shown.text} label={t('muxHistoryCopy')} />}</div>
      <p role="status">{t('muxHistoryLines', { shown: formatNumber(shown.count), total: formatNumber(read.lines) })}</p>
      {shown.text ? <pre className="mux-history" tabIndex={0} aria-label={t('muxHistoryTitle')}>{shown.text}</pre> : <p>{t(read.lines ? 'muxHistoryNoMatch' : 'muxHistoryEmpty')}</p>}
    </>}
  </section>;
}

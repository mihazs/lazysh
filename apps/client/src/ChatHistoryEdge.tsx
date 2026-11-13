import {useEffect, useRef, useState, type RefObject} from 'react';
import {t} from './i18n/core';
import {uiErrorText, type UiErrorCause} from './i18n/localError';
import './ChatHistoryEdge.css';

/** How far ahead of the visible part a page is read: about a screen and a half, so it lands before the edge is reached. */
const PREFETCH_MARGIN = '150% 0px';

/** True while text inside the list is selected: a page that lands then could drop the nodes the selection is in. */
export function useSelectionIn(root: RefObject<HTMLElement | null>) {
  const [selecting, setSelecting] = useState(false);
  useEffect(() => {
    const check = () => {
      const selection = document.getSelection();
      setSelecting(!!selection && !selection.isCollapsed && !!selection.anchorNode && !!root.current?.contains(selection.anchorNode));
    };
    document.addEventListener('selectionchange', check);
    return () => document.removeEventListener('selectionchange', check);
  }, [root]);
  return selecting;
}

/** One end of a session that is read page by page. While more exists the edge is a sentinel: when it comes within the
 * prefetch margin of the list's visible part the next page is read, with a spinner on this edge while it loads and a Retry
 * row when it failed. Where nothing more exists it is a marker. The buttons are the way to read on without scrolling:
 * visible when there is no IntersectionObserver, otherwise reachable by screen readers and the keyboard. */
export default function ChatHistoryEdge({edge, root, more, busy, loading, first, end, paused, error, revision, onMore}: {
  edge: 'top' | 'bottom'; root: RefObject<HTMLElement | null>; more: boolean; busy: boolean; loading: boolean; first?: boolean; end?: boolean;
  paused: boolean; error?: UiErrorCause; revision: number; onMore: () => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const read = useRef(onMore); read.current = onMore;
  const observed = typeof IntersectionObserver === 'function';
  const armed = observed && more && !busy && !paused && !error;
  // A new observer reports the current state at once, so a page that left the sentinel in view reads the next one:
  // `revision` changes with every finished read, also one that finished before `busy` was ever drawn.
  useEffect(() => {
    if (!armed || !sentinel.current) return;
    const observer = new IntersectionObserver(entries => {if (entries.some(entry => entry.isIntersecting)) read.current();}, {root: root.current, rootMargin: PREFETCH_MARGIN});
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [armed, root, revision]);
  if (!more) {
    const text = edge === 'top' ? first && t('chatHistoryStart') : end && t('chatHistoryEnd');
    return text ? <p className="chat-history-marker" data-edge={edge}>{text}</p> : null;
  }
  return <div ref={sentinel} className="chat-history-edge" data-edge={edge} data-observed={observed || undefined}>
    {loading && <><span className="chat-history-spinner" aria-hidden="true" /><span role="status" className="sr-only">{t(edge === 'top' ? 'chatHistoryLoadingOlder' : 'chatHistoryLoadingNewer')}</span></>}
    {error && <div role="alert" className="chat-history-retry"><span>{uiErrorText(error)}</span><button type="button" className="subtle-button" onClick={onMore}>{t('chatHistoryRetry')}</button></div>}
    <div className="chat-history-fallback" role="group" aria-label={t(edge === 'top' ? 'chatHistoryGroup' : 'chatHistoryGroupNewer')}>
      <button type="button" className="subtle-button" disabled={busy} onClick={onMore}>{t(edge === 'top' ? 'chatHistoryOlder' : 'chatHistoryNewer')}</button>
    </div>
  </div>;
}

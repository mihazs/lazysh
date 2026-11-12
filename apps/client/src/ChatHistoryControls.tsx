import {t} from './i18n/core';
import './ChatHistoryControls.css';

/** The ends of a session that is read page by page: more above (or the very first message), and more below. */
export default function ChatHistoryControls({edge, more, busy, first, onMore, onJumpStart}: {
  edge: 'top' | 'bottom'; more: boolean; busy: boolean; first?: boolean; onMore: () => void; onJumpStart?: () => void;
}) {
  if (edge === 'top' && !more) return first ? <p className="chat-history-start">{t('chatHistoryStart')}</p> : null;
  if (!more) return null;
  return <div className="chat-history-controls" role="group" aria-label={t(edge === 'top' ? 'chatHistoryGroup' : 'chatHistoryGroupNewer')}>
    <button type="button" className="subtle-button" disabled={busy} onClick={onMore}>{t(edge === 'top' ? 'chatHistoryOlder' : 'chatHistoryNewer')}</button>
    {edge === 'top' && <button type="button" className="subtle-button" disabled={busy} onClick={onJumpStart}>{t('chatHistoryJumpStart')}</button>}
  </div>;
}

import {t, useUi} from './i18n/core';
import {companionUpdateRow, type CompanionUpdate} from './companionUpdate';

const messages = {running: 'companionUpdateRunning', done: 'companionUpdateDone', failed: 'companionUpdateFailed', verification: 'companionUpdateVerification', off: 'companionUpdateOff', waiting: 'companionUpdateWaiting'} as const;

/** One quiet line about the host companion updating itself to this app's version; it never blocks the board. */
export default function CompanionUpdateRow({update}: {update: CompanionUpdate}) {
  useUi();
  const row = companionUpdateRow(update);
  if (!row) return null;
  return <p className="agent-note companion-update" role="status" aria-busy={row === 'running' || undefined} data-update-state={update.state} data-update-reason={update.reason}>
    {t(messages[row], {version: update.to, current: update.from})}
  </p>;
}

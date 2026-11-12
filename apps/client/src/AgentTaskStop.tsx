import {useState} from 'react';
import type {StatusItem} from './agentBackgroundWork';
import {STOP_CONFIRM_MS, stopMessage, stoppable} from './agentTaskStop';
import {t} from './i18n/core';
import {useNow} from './relativeTime';

/** Stop for one running task of the background-work panel: a confirmation, then the request to the agent and a receipt that
 * ends when the recorded state changes. `send` delivers one message through the composer's bound input; false means it was not sent. */
export default function AgentTaskStop({item, send}: {item: StatusItem; send: (text: string) => Promise<boolean>}) {
  const [phase, setPhase] = useState<'idle' | 'confirm' | 'sending' | 'failed'>('idle');
  const [askedAt, setAskedAt] = useState<number>();
  const now = useNow(1000, askedAt !== undefined);
  if (!stoppable(item)) return null;
  if (askedAt !== undefined) {
    return <p role="status" className="agent-task-stop-receipt" data-state={now - askedAt > STOP_CONFIRM_MS ? 'unconfirmed' : 'asked'}>
      {t(now - askedAt > STOP_CONFIRM_MS ? 'agentStopUnconfirmed' : 'agentStopAsked')}</p>;
  }
  async function ask() {
    setPhase('sending');
    if (await send(stopMessage(item.taskId!))) setAskedAt(Date.now());
    else setPhase('failed');
  }
  const label = item.label || item.taskId || '';
  return <div className="agent-task-stop">
    {phase === 'confirm' || phase === 'sending' ? <>
      <button type="button" className="subtle-button" disabled={phase === 'sending'} onClick={() => void ask()}>{t('agentStopConfirm')}</button>
      <button type="button" className="subtle-button" disabled={phase === 'sending'} onClick={() => setPhase('idle')}>{t('agentStopCancel')}</button>
    </> : <button type="button" className="subtle-button" aria-label={t('agentStopTask', {task: label})} onClick={() => setPhase('confirm')}>{t('agentStop')}</button>}
    {phase === 'failed' && <p role="alert">{t('agentStopFailed')}</p>}
  </div>;
}

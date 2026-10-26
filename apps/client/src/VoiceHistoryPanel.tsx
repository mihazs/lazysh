import {t, useUi, formatDateTime} from './i18n/core';
import type { useDictationHistory } from './voiceHistory';

export default function VoiceHistoryPanel({history,onReuse,disabled=false}:{history:ReturnType<typeof useDictationHistory>;onReuse:(text:string)=>void;disabled?:boolean}) {
  useUi();
  return <section className="dictation-history" aria-label={t('historyTitle')}>
    <label><input type="checkbox" disabled={!history.ready || history.pending} checked={history.remember} onChange={event=>history.setRemember(event.target.checked)}/>{t('historyRemember')}</label>
    <p>{t('historyPrivacy')}</p>
    <button type="button" disabled={history.pending || (!history.entries.length && !history.error)} onClick={history.clear}>{t('historyClear')}</button>
    {history.pending && <p role="status">{t('historyUpdating')}</p>}
    {history.error && <p role="alert" className="inline-error">{history.error}</p>}
    {!!history.entries.length && <details><summary>{t('historyRecent',{count:history.entries.length})}</summary><ol>
      {history.entries.map((entry,index)=><li key={entry.id}>
        <time dateTime={new Date(entry.createdAt).toISOString()}>{formatDateTime(new Date(entry.createdAt))}</time>
        <p>{entry.text.length>120?`${entry.text.slice(0,120)}…`:entry.text}</p>
        <button type="button" disabled={disabled} aria-label={t('historyReuseLabel',{index:index+1})} onClick={()=>onReuse(entry.text)}>{t('historyReuse')}</button>
        <button type="button" disabled={history.pending} aria-label={t('historyDeleteLabel',{index:index+1})} onClick={()=>history.remove(entry.id)}>{t('historyDelete')}</button>
      </li>)}
    </ol></details>}
  </section>;
}

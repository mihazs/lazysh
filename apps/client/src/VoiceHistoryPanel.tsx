import type { useDictationHistory } from './voiceHistory';

export default function VoiceHistoryPanel({history,onReuse,disabled=false}:{history:ReturnType<typeof useDictationHistory>;onReuse:(text:string)=>void;disabled?:boolean}) {
  return <section aria-label="Dictation history">
    <label><input type="checkbox" disabled={!history.ready || history.pending} checked={history.remember} onChange={event=>history.setRemember(event.target.checked)}/>Remember dictation history on this device</label>
    <p>Off by default. Current-view history disappears when you close Voice. Enabling Remember saves current and future texts locally, available for up to 7 days, up to 20 entries and 256 KiB. Saved text is not encrypted by lazysh. Expired saved entries are pruned when Voice is opened or used, not while the app is closed. Audio and connection details are never stored in history.</p>
    <button type="button" disabled={history.pending || (!history.entries.length && !history.error)} onClick={history.clear}>Clear history</button>
    {history.pending && <p role="status">Updating saved history…</p>}
    {history.error && <p role="alert" className="inline-error">{history.error}</p>}
    {!!history.entries.length && <details><summary>Recent dictation ({history.entries.length})</summary><ol>
      {history.entries.map((entry,index)=><li key={entry.id}>
        <time dateTime={new Date(entry.createdAt).toISOString()}>{new Date(entry.createdAt).toLocaleString()}</time>
        <p>{entry.text.length>120?`${entry.text.slice(0,120)}…`:entry.text}</p>
        <button type="button" disabled={disabled} aria-label={`Reuse dictation ${index+1}`} onClick={()=>onReuse(entry.text)}>Use in draft</button>
        <button type="button" disabled={history.pending} aria-label={`Delete dictation ${index+1}`} onClick={()=>history.remove(entry.id)}>Delete</button>
      </li>)}
    </ol></details>}
  </section>;
}

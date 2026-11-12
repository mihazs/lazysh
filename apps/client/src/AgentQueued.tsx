import {t,useUi} from './i18n/core';
import {formatRelativeTime,useNow} from './relativeTime';

/** A prompt typed while the agent works and not yet taken (Claude Code `queue-operation` records). */
export type Queued=Readonly<{text:string;timestamp?:string}>;
const MAX_QUEUED=20,MAX_TEXT=4096;

/** Entries a companion sent; anything malformed is dropped, an older companion sends none. */
export function parseQueued(value:unknown):Queued[] {
  if(!Array.isArray(value))return [];
  return value.slice(0,MAX_QUEUED).flatMap(entry=>{
    if(!entry || typeof entry!=='object')return [];
    const {text,timestamp}=entry as Record<string,unknown>;
    if(typeof text!=='string' || !text || new TextEncoder().encode(text).length>MAX_TEXT)return [];
    return [{text,timestamp:typeof timestamp==='string' && Number.isFinite(Date.parse(timestamp))?timestamp:undefined}];
  });
}

/** Cards below the latest turn, oldest first. They are read-only: removing or promoting one needs the guarded input (#1123). */
export default function AgentQueued({queued}:{queued:readonly Queued[]}) {
  useUi();
  const now=useNow(30_000,queued.length>0);
  if(!queued.length)return null;
  return <section className="agent-queued" aria-label={t('agentQueuedTitle')}>
    {queued.map((entry,index)=><article key={`${index}:${entry.text}`} className="agent-queued-card">
      <small>{t('agentQueued')}{entry.timestamp && <> · <time dateTime={entry.timestamp}>{formatRelativeTime(entry.timestamp,now)}</time></>}</small>
      <p>{entry.text}</p>
    </article>)}
  </section>;
}

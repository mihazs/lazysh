import {Check} from 'lucide-react';
import {formatDateTime,uiI18n} from './i18n/core';

export type StatusTone='working'|'attention'|'done'|'idle'|'unknown';

/** Decorative state ring; the owning row always carries the state as text. */
export function StatusRing({tone}:{tone:StatusTone}) {
  return <span className="status-ring" data-tone={tone} aria-hidden="true">
    <svg className="status-ring-svg" viewBox="0 0 32 32" focusable="false"><circle className="status-ring-track" cx="16" cy="16" r="13"/><circle className="status-ring-arc" cx="16" cy="16" r="13" pathLength="100"/></svg>
    {tone==='done' && <Check className="status-ring-check" size={15} strokeWidth={3}/>}
    {tone==='attention' && <b>!</b>}
  </span>;
}

/** A stable tag tone per agent family, independent of the reported label's case. */
export function agentKind(name:string|null|undefined) {
  const value=(name??'').toLowerCase();
  return ['claude','codex','gemini','opencode','cursor','droid','cline','kimi','aider','amp','copilot','grok'].find(kind=>value.includes(kind))??'other';
}

export function projectName(path:string) {
  const parts=path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1)??path;
}

/** Compact relative recency for row tags; callers keep the absolute time in a title. */
export function formatRecency(value:string|number|Date,now=Date.now()) {
  const time=new Date(value).getTime();
  if(!Number.isFinite(time))return '';
  const seconds=Math.round((time-now)/1000),abs=Math.abs(seconds);
  const format=new Intl.RelativeTimeFormat(uiI18n.language,{numeric:'auto',style:'short'});
  if(abs<45)return format.format(0,'second');
  if(abs<3600)return format.format(Math.round(seconds/60),'minute');
  if(abs<86400)return format.format(Math.round(seconds/3600),'hour');
  if(abs<86400*7)return format.format(Math.round(seconds/86400),'day');
  return formatDateTime(time);
}

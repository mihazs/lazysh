import {Check} from 'lucide-react';

export type StatusTone='working'|'attention'|'done'|'idle'|'unknown';
/** Ring tones for hook-reported states shared by Reported activity and the agent inbox. */
export const reportedTones={needs_attention:'attention',working:'working',done:'done'} as const satisfies Record<string,StatusTone>;
/** Ring tones for the live status Herdr reports for a pane. */
export const herdrTones={blocked:'attention',working:'working',done:'done',idle:'idle',unknown:'unknown'} as const satisfies Record<string,StatusTone>;

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

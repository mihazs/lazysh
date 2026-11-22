import {accountUsagePercent} from './accountUsageReport';
/** What a host's `usage-collector status` reports, revalidated by the native layer. */
export type CollectorMetric = {label:string;percent:number;reading:'used'|'left';resetAt:string|null;windowSeconds:number|null};
export type CollectorEntry = {id:string;name:string;status:'ready'|'error';stale:boolean;fetchedAt:string|null;rows:CollectorMetric[]};
export type CollectorSample = {recordedAt:string;source:'builtin'|'external_cli';truncated:boolean;entries:CollectorEntry[]};
export type UsageCollectorStatus = {
  schemaVersion:1;observedAt:string;policyRevision:number;accountQuotaEnabled:boolean;
  collector:{enabled:boolean;intervalMinutes:number;timer:{state:'absent'|'installed'|'drift'|'unsupported';linger:boolean|null}};
  lastRun:{at:string;outcome:'recorded'|'skipped'|'unavailable';reason:string|null}|null;
  samples:{state:'ok'|'invalid';count:number;oldest:string|null;newest:string|null;bytes:number};
  recent:CollectorSample[];
};
export type UsageCollectorReply = {state:'ready';status:UsageCollectorStatus}|{state:'companion_required'};

const STALE_AFTER=10*60_000;
/**
 * How old a recorded moment is now, in milliseconds: its age on the host when the host answered (host clock against host
 * clock, so a phone with the wrong time cannot rejuvenate it) plus the time since the answer arrived. `null` is unknown:
 * an unreadable time, or one the host reports as later than its own answer.
 */
export function ageMs(recordedAt:string,observedAt:string,receivedAt:number,now:number):number|null {
  const recorded=Date.parse(recordedAt),observed=Date.parse(observedAt);
  if(!Number.isFinite(recorded)||!Number.isFinite(observed)||recorded>observed+60_000)return null;
  return Math.max(0,observed-recorded)+Math.max(0,now-receivedAt);
}
/** Old provider data: flagged stale or in error, or fetched more than ten minutes before it was recorded. A missing fetch time is unknown, so stale. */
export function entryStale(entry:CollectorEntry,recordedAt:string):boolean {
  const fetched=entry.fetchedAt?Date.parse(entry.fetchedAt):NaN,recorded=Date.parse(recordedAt);
  return entry.status==='error'||entry.stale||!Number.isFinite(fetched)||!Number.isFinite(recorded)||fetched>recorded+60_000||recorded-fetched>STALE_AFTER;
}
/** The most consumed quota row of an entry as text, or `null` when the sample has no quota row for it (unknown, never zero). */
export function entryHeadline(entry:CollectorEntry):string|null {
  const consumed=(row:CollectorMetric)=>row.reading==='left'?100-row.percent:row.percent;
  const row=entry.rows.reduce<CollectorMetric|undefined>((highest,next)=>!highest||consumed(next)>consumed(highest)?next:highest,undefined);
  return row?`${row.label} ${accountUsagePercent(row.percent,row.reading)}`:null;
}

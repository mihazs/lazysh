import {t,formatNumber,type UiKey} from './i18n/core';
export type AccountUsageMetric = {
  type:'metric'; label:string; percent:number; value:string; detail:string; headline:'percent'|'value';
  reading:'used'|'left'; resetAt:string|null; windowSeconds:number|null; regen:string|null; modelPool:boolean;
};
export type AccountUsageText = {type:'text';label:string;value:string;usedCents:number|null;limitCents:number|null;percent:number|null};
export type AccountUsageEntry = {
  id:string;name:string;shortName:string;plan:string|null;status:'ready'|'error';stale:boolean;fetchedAt:string|null;
  rows:(AccountUsageMetric|AccountUsageText)[];
  resetCredits:{available:number;credits:{title:string|null;expiresAt:string|null}[]}|null;
};
export type AccountUsageResponse = {schemaVersion:1;source?:'builtin'|'external_cli'|null;state:'ready'|'companion_required'|'invalid_report'|'busy'|'disconnected'|'timeout'|'unavailable';report:{primary:string|null;entries:AccountUsageEntry[]}|null};
export const accountUsageMessages = {
  companion_required:'accountUsageCompanionRequired',invalid_report:'accountUsageInvalid',busy:'accountUsageBusy',disconnected:'accountUsageDisconnected',timeout:'accountUsageTimeout',unavailable:'accountUsageUnavailable',
} as const satisfies Record<Exclude<AccountUsageResponse['state'],'ready'>,UiKey>;
export function accountUsagePercent(percent:number,reading:'used'|'left') {return t('accountUsagePercent',{percent:formatNumber(percent),reading:t(reading==='used'?'accountUsageUsed':'accountUsageLeft')});}

export function accountUsageHeadline(entry:AccountUsageEntry):{text:string;percent:number|null} {
  const metrics=entry.rows.filter((row):row is AccountUsageMetric=>row.type==='metric');
  const shared=metrics.filter(row=>!row.modelPool);
  const candidates=shared.length?shared:metrics;
  const quotas=candidates.filter(row=>row.headline==='percent');
  const consumed=(row:AccountUsageMetric)=>row.reading==='left'?100-row.percent:row.percent;
  const metric=quotas.reduce<AccountUsageMetric|undefined>((highest,row)=>!highest||consumed(row)>consumed(highest)?row:highest,undefined)??candidates[0];
  if(metric) return {text:metric.headline==='value'?metric.value:accountUsagePercent(metric.percent,metric.reading),percent:metric.percent};
  const text=entry.rows.find(row=>row.type==='text');
  return {text:text?.value??(t(entry.status==='error'?'accountUsageProviderUnavailable':'accountUsageNoQuota')),percent:null};
}
export function accountUsageStale(entry:AccountUsageEntry,now=Date.now()):boolean {
  const fetched=entry.fetchedAt?Date.parse(entry.fetchedAt):NaN;
  return entry.status==='error' || entry.stale || !Number.isFinite(fetched) || fetched>now+60_000 || now-fetched>10*60_000;
}

import {Activity,RefreshCw} from 'lucide-react';
import {t,useUi,formatDateTime} from './i18n/core';
import {accountUsageHeadline,accountUsageMessages,accountUsagePercent,accountUsageStale} from './accountUsageReport';
import type {AccountUsageModel} from './useAccountUsage';
import './AccountUsage.css';
export function AccountUsageBar({model,onOpen}:{model:AccountUsageModel;onOpen:()=>void}) {
  useUi();
  const {entry,response,refreshing}=model;
  const headline=entry?accountUsageHeadline(entry):null;
  const stale=!!entry&&(accountUsageStale(entry)||response?.state!=='ready');
  return <button type="button" className="account-usage-chip" onClick={onOpen} aria-label={t('accountUsageOpen')} title={entry?`${entry.name}: ${headline?.text}${stale?` · ${t('accountUsageStaleShort')}`:''}`:t('accountUsageTitle')}>
    <Activity size={12} aria-hidden="true"/>{headline?.percent!==null&&headline?.percent!==undefined&&<meter min={0} max={100} value={Math.min(100,headline.percent)} aria-hidden="true"/>}<span>{entry?`${entry.shortName} ${headline?.text}`:t(refreshing?'accountUsageLoading':'accountUsageShort')}</span>{stale&&<span aria-label={t('accountUsageStaleLabel')}>· {t('accountUsageStaleShort')}</span>}
  </button>;
}
export function AccountUsageDetails({model,onRestoreHostTools}:{model:AccountUsageModel;onRestoreHostTools?:(restored:()=>void)=>void}) {
  useUi();
  const {entry,response,refreshing,refresh,select}=model;
  const problem=response&&response.state!=='ready'?t(accountUsageMessages[response.state]):null;
  return <section className="account-usage-details" aria-label={t('accountUsageTitle')}>
    <header><h2>{t('accountUsageTitle')}</h2><button type="button" onClick={refresh} disabled={refreshing}><RefreshCw size={16} aria-hidden="true"/>{t(refreshing?'accountUsageRefreshing':'accountUsageRefresh')}</button></header>
    <p>{t('accountUsageDescription')}</p>
    {problem&&<p role="status">{problem}</p>}
    {response?.state==='disconnected'&&onRestoreHostTools&&<button type="button" onClick={()=>onRestoreHostTools(refresh)}>{t('accountUsageRestore')}</button>}
    {response?.state==='unavailable'&&<p>{t('accountUsageSetup')}</p>}
    {response?.source&&<p>{t(response.source==='builtin'?'accountUsageBuiltin':'accountUsageExternal')}</p>}
    {response?.report?.entries.length===0&&<p>{t('accountUsageEmpty')}</p>}
    {entry&&<>
      <label>{t('accountUsageAccount')}<select value={entry.id} onChange={e=>select(e.target.value)}>{response?.report?.entries.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <p>{entry.plan??t('accountUsagePlanUnknown')} · {t(entry.status==='error'?'accountUsageProviderUnavailable':accountUsageStale(entry)||response?.state!=='ready'?'accountUsageStale':'accountUsageLatest')}{entry.fetchedAt&&<> · <time dateTime={entry.fetchedAt}>{formatDateTime(new Date(entry.fetchedAt))}</time></>}</p>
      <dl>{entry.rows.map((row,index)=><div key={`${row.label}:${index}`}><dt>{row.label}</dt><dd>{row.type==='metric'?<>
        <strong>{row.headline==='value'?row.value:accountUsagePercent(row.percent,row.reading)}</strong>
        <meter min={0} max={100} value={Math.min(100,row.percent)} aria-label={`${row.label} ${t(row.reading==='used'?'accountUsageUsed':'accountUsageLeft')}`} aria-valuetext={accountUsagePercent(row.percent,row.reading)}/>
        <span>{row.headline==='percent'?row.value:null}{row.detail&&` · ${row.detail}`}</span>
        {row.resetAt&&<span>{row.regen?t('accountUsageRegenerates',{amount:row.regen}):t('accountUsageResets')} · <time dateTime={row.resetAt}>{formatDateTime(new Date(row.resetAt))}</time></span>}
        {row.modelPool&&<span>{t('accountUsageModelPool')}</span>}
      </>:row.value}</dd></div>)}</dl>
      {entry.resetCredits&&<p>{t('accountUsageResetCredits',{count:entry.resetCredits.available})}{entry.resetCredits.credits.map((credit,index)=><span key={index}>{credit.title}{credit.expiresAt&&` · ${t('accountUsageExpires',{date:formatDateTime(new Date(credit.expiresAt))})}`}</span>)}</p>}
    </>}
  </section>;
}

import {useEffect,useRef} from 'react';
import {Activity,Download,RefreshCw} from 'lucide-react';
import {t,useUi,formatDateTime} from './i18n/core';
import {accountUsageHeadline,accountUsageMessages,accountUsagePercent,accountUsageSpendPercent,accountUsageStale} from './accountUsageReport';
import type {AccountUsageModel} from './useAccountUsage';
import './AccountUsage.css';
/** The status-bar chip: the account of the agent in the current pane (or the chosen one), with an honest label when that account is not reported. */
export function AccountUsageBar({model,onOpen,onShown}:{model:AccountUsageModel;onOpen:()=>void;onShown?:(shown:boolean)=>void}) {
  useUi();
  const chip=useRef<HTMLButtonElement>(null);
  // Reports whether the chip has a box on screen: a short phone window or a closed menu hides it, and nothing then needs to follow the pane.
  useEffect(()=>{
    const node=chip.current;
    if(!node||!onShown)return;
    if(typeof ResizeObserver==='undefined'){onShown(true);return()=>onShown(false);}
    const observer=new ResizeObserver(()=>onShown(node.getClientRects().length>0));
    observer.observe(node);
    return()=>{observer.disconnect();onShown(false);};
  },[onShown]);
  const {bar:entry,response,refreshing,target}=model;
  const headline=entry?accountUsageHeadline(entry):null;
  const stale=!!entry&&(accountUsageStale(entry)||response?.state!=='ready');
  // A ready report without the account the pane's agent spends says so, rather than showing another account's quota.
  const absent=!entry&&!!target&&!target.pending&&response?.state==='ready'&&!!response.report?.entries.length?t(target.providerId===null?'accountUsageAgentUnsupported':'accountUsageProviderMissing',{name:target.label}):null;
  const text=entry?`${entry.name} ${headline?.text}`:absent??t(refreshing||target?.pending?'accountUsageLoading':response?.state==='companion_required'?'accountUsageSetupShort':response?.state&&response.state!=='ready'?'accountUsageUnavailableShort':response?.report?.entries.length===0?'accountUsageEmptyShort':'accountUsageShort');
  return <button type="button" ref={chip} className="account-usage-chip" onClick={onOpen} aria-label={t('accountUsageOpen')} data-following={target?.agent?'':undefined} title={entry?`${entry.name}: ${headline?.text}${stale?` · ${t('accountUsageStaleShort')}`:''}`:absent??t('accountUsageTitle')}>
    <Activity size={12} aria-hidden="true"/>{headline?.percent!==null&&headline?.percent!==undefined&&<meter min={0} max={100} value={Math.min(100,headline.percent)} aria-hidden="true"/>}<span>{text}</span>{stale&&<span aria-label={t('accountUsageStaleLabel')}>· {t('accountUsageStaleShort')}</span>}
  </button>;
}
export function AccountUsageDetails({model,onRestoreHostTools,onOpenCompanion}:{model:AccountUsageModel;onOpenCompanion?:()=>void;onRestoreHostTools?:(restored:()=>void)=>void}) {
  useUi();
  const {entry,response,refreshing,refresh,select}=model;
  const problem=response&&response.state!=='ready'?t(accountUsageMessages[response.state]):null;
  return <section className="account-usage-details" aria-label={t('accountUsageTitle')}>
    <header><h2>{t('accountUsageTitle')}</h2><button type="button" onClick={refresh} disabled={refreshing}><RefreshCw size={16} aria-hidden="true"/>{t(refreshing?'accountUsageRefreshing':'accountUsageRefresh')}</button></header>
    {problem&&<p role="status">{problem}</p>}
    {response?.state==='disconnected'&&onRestoreHostTools&&<button type="button" onClick={()=>onRestoreHostTools(refresh)}>{t('accountUsageRestore')}</button>}
    {onOpenCompanion&&(response?.state==='companion_required'||response?.state==='invalid_report')&&<button type="button" onClick={onOpenCompanion}><Download size={16} aria-hidden="true"/>{t('accountUsageInstall')}</button>}
    {entry&&response?.source&&<p>{t(response.source==='builtin'?'accountUsageBuiltin':'accountUsageExternal')}</p>}
    {response?.report?.entries.length===0&&<p>{t('accountUsageEmpty')}</p>}
    {entry&&<>
      <p>{t('accountUsageDescription')}</p>
      <label>{t('accountUsageAccount')}<select value={entry.id} onChange={e=>select(e.target.value)}>{response?.report?.entries.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
      <p>{entry.plan??t('accountUsagePlanUnknown')} · {t(entry.status==='error'?'accountUsageProviderUnavailable':accountUsageStale(entry)||response?.state!=='ready'?'accountUsageStale':'accountUsageLatest')}{entry.fetchedAt&&<> · <time dateTime={entry.fetchedAt}>{formatDateTime(new Date(entry.fetchedAt))}</time></>}</p>
      <dl>{entry.rows.map((row,index)=>{
        const spend=row.type==='text'?accountUsageSpendPercent(row):null;
        return <div key={`${row.label}:${index}`}><dt>{row.label}</dt><dd>{row.type==='metric'?<>
        <strong>{row.headline==='value'?row.value:accountUsagePercent(row.percent,row.reading)}</strong>
        <meter min={0} max={100} value={Math.min(100,row.percent)} aria-label={`${row.label} ${t(row.reading==='used'?'accountUsageUsed':'accountUsageLeft')}`} aria-valuetext={accountUsagePercent(row.percent,row.reading)}/>
        <span>{row.headline==='percent'?row.value:null}{row.detail&&` · ${row.detail}`}</span>
        {row.resetAt&&<span>{row.regen?t('accountUsageRegenerates',{amount:row.regen}):t('accountUsageResets')} · <time dateTime={row.resetAt}>{formatDateTime(new Date(row.resetAt))}</time></span>}
        {row.modelPool&&<span>{t('accountUsageModelPool')}</span>}
      </>:<>{row.value}{spend!==null&&<><span>{accountUsagePercent(spend,'used')}</span><meter min={0} max={100} value={Math.min(100,spend)} aria-label={`${row.label} ${t('accountUsageUsed')}`} aria-valuetext={accountUsagePercent(spend,'used')}/></>}</>}</dd></div>;})}</dl>
      {entry.resetCredits&&<p>{t('accountUsageResetCredits',{count:entry.resetCredits.available})}{entry.resetCredits.credits.map((credit,index)=><span key={index}>{credit.title}{credit.expiresAt&&` · ${t('accountUsageExpires',{date:formatDateTime(new Date(credit.expiresAt))})}`}</span>)}</p>}
    </>}
  </section>;
}

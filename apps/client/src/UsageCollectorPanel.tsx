import {useCallback,useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import {t,useUi,formatDateTime} from './i18n/core';
import {captureUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import {useProtectedInvoke} from './access';
import {formatRelativeTime} from './relativeTime';
import {ageMs,entryHeadline,entryStale,type UsageCollectorReply,type UsageCollectorStatus} from './usageCollector';
import './AccountUsage.css';

/** The host's background usage collector: whether it runs, its last run and how old every sample is. Read only; the host owner changes it with `lazysh-agent usage-collector`. */
export default function UsageCollectorPanel({sessionId}:{sessionId:string}) {
  useUi();
  const invoke=useProtectedInvoke();
  const [reply,setReply]=useState<{reply:UsageCollectorReply;receivedAt:number}|null>(null);
  const [error,setError]=useState<UiErrorCause>('');
  const [busy,setBusy]=useState(false);
  const request=useRef(0);
  const load=useCallback(async()=>{
    const current=++request.current;setBusy(true);setError('');
    try {
      const value=await invoke<UsageCollectorReply>('usage_collector_status',{sessionId});
      if(request.current===current)setReply({reply:value,receivedAt:Date.now()});
    } catch(failure) {
      if(request.current===current){setReply(null);setError(captureUiError(failure));}
    } finally {if(request.current===current)setBusy(false);}
  },[invoke,sessionId]);
  useEffect(()=>{setReply(null);void load();return()=>{request.current++;};},[load]);
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),30_000);return()=>window.clearInterval(timer);},[]);
  const answer=reply?.reply;
  const status=answer?.state==='ready'?answer.status:null;
  return <section className="account-usage-details" aria-label={t('usageCollectorTitle')}>
    <header><h2>{t('usageCollectorTitle')}</h2><button type="button" onClick={()=>void load()} disabled={busy}><RefreshCw size={16} aria-hidden="true"/>{t(busy?'usageCollectorRefreshing':'usageCollectorRefresh')}</button></header>
    {error&&<p role="alert">{uiErrorText(error)}</p>}
    {answer?.state==='companion_required'&&<p role="status">{t('usageCollectorCompanion')}</p>}
    {status&&reply&&<Status status={status} receivedAt={reply.receivedAt} now={now}/>}
  </section>;
}

function Age({at,status,receivedAt,now}:{at:string;status:UsageCollectorStatus;receivedAt:number;now:number}) {
  const age=ageMs(at,status.observedAt,receivedAt,now);
  return age===null?<>{t('usageCollectorTimeUnknown')}</>:<time dateTime={at} title={formatDateTime(new Date(at))}>{formatRelativeTime(now-age,now)}</time>;
}

function Status({status,receivedAt,now}:{status:UsageCollectorStatus;receivedAt:number;now:number}) {
  const {collector,lastRun,samples,recent}=status;
  const age=(at:string)=><Age at={at} status={status} receivedAt={receivedAt} now={now}/>;
  const timer=collector.timer.state;
  return <>
    <p>{collector.enabled?t('usageCollectorOn',{minutes:collector.intervalMinutes}):t('usageCollectorOff')}</p>
    {collector.enabled&&timer!=='installed'&&<p role="status">{t(timer==='absent'?'usageCollectorTimerAbsent':timer==='drift'?'usageCollectorTimerDrift':'usageCollectorTimerUnsupported')}</p>}
    {collector.enabled&&timer==='installed'&&collector.timer.linger===false&&<p>{t('usageCollectorLinger')}</p>}
    {!status.accountQuotaEnabled&&<p role="status">{t('usageCollectorQuotaOff')}</p>}
    <p>{lastRun?<>{t('usageCollectorLastRun')} {age(lastRun.at)} · {t(lastRun.outcome==='recorded'?'usageCollectorRunRecorded':lastRun.outcome==='skipped'?'usageCollectorRunSkipped':'usageCollectorRunUnavailable')}{lastRun.outcome==='unavailable'&&lastRun.reason&&<> ({lastRun.reason})</>}</>:t('usageCollectorNoRun')}</p>
    {samples.state==='invalid'?<p role="status">{t('usageCollectorInvalid')}</p>:samples.count===0?<p>{t('usageCollectorNoSamples')}</p>:<>
      <p>{t('usageCollectorSamples',{count:samples.count})}{samples.newest&&<> · {t('usageCollectorNewest')} {age(samples.newest)}</>}{samples.oldest&&<> · {t('usageCollectorOldest')} {age(samples.oldest)}</>}</p>
      <ul aria-label={t('usageCollectorSampleList')}>{recent.map(sample=><li key={sample.recordedAt}>
        <strong>{age(sample.recordedAt)}</strong>
        {sample.entries.length===0?<span> · {t('usageCollectorNoQuota')}</span>:sample.entries.map(entry=><span key={entry.id}> · {entry.name}: {entryHeadline(entry)??t('usageCollectorNoQuota')}{entryStale(entry,sample.recordedAt)&&<> ({t('usageCollectorStale')})</>}</span>)}
        {sample.truncated&&<span> · {t('usageCollectorCut')}</span>}
      </li>)}</ul>
    </>}
  </>;
}

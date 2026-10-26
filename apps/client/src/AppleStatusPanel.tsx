import {t,useUi} from './i18n/core';
import {captureUiError,LocalUiError,uiErrorText,type UiErrorCause} from './i18n/localError';
import { useProtectedInvoke } from './access';
import { useEffect, useRef, useState } from 'react';

import { listen } from '@tauri-apps/api/event';
import { parseSnapshot } from './AgentPanel';
import { parseApprovals } from './ApprovalPanel';
import { sampleFreshness, type AppleUsageReport } from './UsagePanel';

type Capability = {liveActivities:boolean; watchPaired:boolean; watchInstalled:boolean; watchReachable:boolean; reason:string};
type Props = {sessionId:string; usage?:AppleUsageReport|null; onReview?:()=>void};
type ReviewIntent = {subscriptionId:string;sessionId:string;expiresAt:number;approvalId?:string};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export default function AppleStatusPanel({sessionId, usage=null, onReview}:Props) {
  useUi();
  const invoke = useProtectedInvoke();
  const [capability, setCapability] = useState<Capability>();
  const [subscription, setSubscription] = useState<string>();
  const [error, setError] = useState<UiErrorCause>('');
  const [busy, setBusy] = useState(false);
  const active = useRef<string|undefined>(undefined);
  const sequence = useRef(0);
  const running = useRef(false);
  const startActivity = useRef(false);
  const review = useRef(onReview); review.current = onReview;
  const pendingReview = useRef<ReviewIntent|undefined>(undefined);
  function stop() {
    const id=active.current; active.current=undefined;
    pendingReview.current=undefined;
    setSubscription(undefined); setBusy(false);
    if(id) void invoke('apple_status_configure',{subscriptionId:id, enabled:false}).catch(()=>setError(new LocalUiError('appleStatusStopFailed')));
  }
  useEffect(()=>{
    let alive=true;
    void invoke<Capability>('apple_status_capability').then(value=>{
      if(alive && value && typeof value.liveActivities==='boolean' && typeof value.watchInstalled==='boolean' && typeof value.reason==='string') setCapability(value);
    }).catch(()=>{if(alive)setError(new LocalUiError('appleStatusCapabilityUnavailable'));});
    const deliverReview=()=>{
      const intent=pendingReview.current;
      const now=Math.floor(Date.now()/1000);
      if(!intent || intent.subscriptionId!==active.current || intent.sessionId!==sessionId || intent.expiresAt<=now || intent.expiresAt>now+65) {pendingReview.current=undefined;return;}
      if(!document.hidden){pendingReview.current=undefined;review.current?.();}
    };
    const unlisten=listen<unknown>('lazysh-apple-review',event=>{
      const value=event.payload as ReviewIntent|null;
      if(!value || typeof value!=='object' || typeof value.subscriptionId!=='string' || !uuid.test(value.subscriptionId)
        || typeof value.sessionId!=='string' || !uuid.test(value.sessionId) || !Number.isSafeInteger(value.expiresAt)
        || (value.approvalId!==undefined && value.approvalId!==null && (typeof value.approvalId!=='string' || !uuid.test(value.approvalId))))return;
      pendingReview.current={subscriptionId:value.subscriptionId,sessionId:value.sessionId,expiresAt:value.expiresAt};deliverReview();
    });
    document.addEventListener('visibilitychange',deliverReview);
    return ()=>{
      alive=false;
      pendingReview.current=undefined;document.removeEventListener('visibilitychange',deliverReview);
      void unlisten.then(remove=>remove()).catch(()=>{});
      const id=active.current; active.current=undefined;
      if(id) void invoke('apple_status_configure',{subscriptionId:id,enabled:false}).catch(()=>{});
    };
  },[sessionId]);
  async function enable(activity:boolean) {
    const id=crypto.randomUUID(); active.current=id; sequence.current=0; startActivity.current=activity;
    setBusy(true);setError('');
    try {
      await invoke('apple_status_configure',{subscriptionId:id,enabled:true});
      if(active.current===id) {setSubscription(id);setBusy(false);}
    } catch(e) {if(active.current===id){active.current=undefined;setBusy(false);setError(captureUiError(e));}}
  }
  useEffect(()=>{
    if(!subscription)return;
    let alive=true;
    async function publish() {
      if(running.current || active.current!==subscription || document.hidden)return;
      running.current=true;
      try {
        const [activity, approvals] = await Promise.all([
          invoke('agent_snapshot',{sessionId}), invoke('agent_approvals',{sessionId}),
        ]);
        const now=Math.floor(Date.now()/1000);
        const rows=parseSnapshot(activity);
        const requests=parseApprovals(approvals);
        if(!alive || active.current!==subscription)return;
        const recent=rows.filter(row=>{const time=Math.floor(Date.parse(row.updatedAt)/1000);return time>=now-60 && time<=now+5;});
        const recordedAt=usage?.recordedAt?Date.parse(usage.recordedAt):null;
        const age=usage && recordedAt!==null?Date.parse(usage.observedAt)-recordedAt:null;
        const usageReport=usage?{inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,cacheReadTokens:usage.cacheReadTokens,cacheWriteTokens:usage.cacheWriteTokens,
          recordedAt:recordedAt===null?null:Math.floor(recordedAt/1000),freshness:sampleFreshness(usage,usage.observedAt,Date.now()-usage.receivedAt),
          freshUntil:usage.freshness==='fresh' && age!==null && age>=0?Math.max(0,Math.floor((usage.receivedAt+15*60_000-age)/1000)):null}:null;
        const snapshot={subscriptionId:subscription,sessionId,sequence:++sequence.current,observedAt:now,expiresAt:now+60,
          running:recent.filter(row=>row.state==='working').length,waiting:recent.filter(row=>row.state==='needs_attention').length,
          usage:usageReport,
          approvals:requests.filter(row=>Date.parse(row.expiresAt)>Date.now()).slice(0,8).map(row=>({id:row.id,expiresAt:Math.floor(Date.parse(row.expiresAt)/1000)})),
        };
        const start=startActivity.current;
        await invoke('apple_status_publish',{snapshot,startActivity:start});
        if(active.current===subscription && start)startActivity.current=false;
        if(alive)setError('');
      }catch(e){if(alive)setError(captureUiError(e));}
      finally{running.current=false;}
    }
    void publish(); const timer=window.setInterval(()=>void publish(),10000);
    return()=>{alive=false;window.clearInterval(timer);};
  },[subscription,sessionId,usage]);
  return <section className="tool-panel" aria-label={t('appAppleStatus')}>
    <h3>{t('appAppleStatus')}</h3>
    <p>{t('appleStatusPrivacy')}</p>
    {capability && <p>{capability.reason} {capability.watchInstalled?(capability.watchReachable?t('appleStatusWatchReachable'):t('appleStatusWatchUnavailable')): t('appleStatusWatchMissing')}</p>}
    {!subscription && <div className="tool-bar">
      <button disabled={!capability?.watchInstalled || busy} onClick={()=>void enable(false)}>{t('appleStatusEnableWatch')}</button>
      <button disabled={!capability?.liveActivities || busy} onClick={()=>void enable(true)}>{t('appleStatusStartActivity')}</button>
    </div>}
    {subscription && <><p role="status">{t('appleStatusSharing')}</p><button onClick={stop}>{t('appleStatusStop')}</button></>}
    <p>{t('appleStatusReview')}</p>
    {error && <p role="alert" className="inline-error">{uiErrorText(error)}</p>}
  </section>;
}

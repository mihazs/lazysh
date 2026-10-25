import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { parseSnapshot } from './AgentPanel';
import { parseApprovals } from './ApprovalPanel';
import { errorMessage } from './SessionTools';

type Capability = {liveActivities:boolean; watchPaired:boolean; watchInstalled:boolean; watchReachable:boolean; reason:string};
type Props = {sessionId:string; totalTokens?:number|null; onReview?:()=>void};

export default function AppleStatusPanel({sessionId, totalTokens=null, onReview}:Props) {
  const [capability, setCapability] = useState<Capability>();
  const [subscription, setSubscription] = useState<string>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef<string|undefined>(undefined);
  const sequence = useRef(0);
  const running = useRef(false);
  const startActivity = useRef(false);
  const review = useRef(onReview); review.current = onReview;
  function stop() {
    const id=active.current; active.current=undefined;
    setSubscription(undefined); setBusy(false);
    if(id) void invoke('apple_status_configure',{subscriptionId:id, enabled:false}).catch(()=>setError('Could not clear native status. Existing snapshots expire within 60 seconds.'));
  }
  useEffect(()=>{
    let alive=true;
    void invoke<Capability>('apple_status_capability').then(value=>{
      if(alive && value && typeof value.liveActivities==='boolean' && typeof value.watchInstalled==='boolean' && typeof value.reason==='string') setCapability(value);
    }).catch(()=>{if(alive)setError('Apple status capability unavailable.');});
    const unlisten=listen<{sessionId:string;approvalId?:string}>('lazysh-apple-review',event=>{
      if(active.current && event.payload.sessionId===sessionId && !document.hidden) review.current?.();
    });
    return ()=>{
      alive=false;
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
    } catch(e) {if(active.current===id){active.current=undefined;setBusy(false);setError(errorMessage(e));}}
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
        const snapshot={subscriptionId:subscription,sessionId,sequence:++sequence.current,observedAt:now,expiresAt:now+60,
          running:recent.filter(row=>row.state==='working').length,waiting:recent.filter(row=>row.state==='needs_attention').length,
          totalTokens:Number.isSafeInteger(totalTokens) && totalTokens!==null && totalTokens>=0?totalTokens:null,
          approvals:requests.filter(row=>Date.parse(row.expiresAt)>Date.now()).slice(0,8).map(row=>({id:row.id,expiresAt:Math.floor(Date.parse(row.expiresAt)/1000)})),
        };
        const start=startActivity.current;
        await invoke('apple_status_publish',{snapshot,startActivity:start});
        if(active.current===subscription && start)startActivity.current=false;
        if(alive)setError('');
      }catch(e){if(alive)setError(errorMessage(e));}
      finally{running.current=false;}
    }
    void publish(); const timer=window.setInterval(()=>void publish(),10000);
    return()=>{alive=false;window.clearInterval(timer);};
  },[subscription,sessionId,totalTokens]);
  return <section className="tool-panel" aria-label="Apple status">
    <h3>Apple status</h3>
    <p>Share generic counts from agent reports received in the last minute. Host names, prompts, commands and credentials stay off these surfaces.</p>
    {capability && <p>{capability.reason} {capability.watchInstalled?(capability.watchReachable?'Watch reachable.':'Watch unavailable; cached status expires.'): 'Watch companion not installed.'}</p>}
    {!subscription && <div className="tool-bar">
      <button disabled={!capability?.watchInstalled || busy} onClick={()=>void enable(false)}>Enable Watch status</button>
      <button disabled={!capability?.liveActivities || busy} onClick={()=>void enable(true)}>Start Live Activity</button>
    </div>}
    {subscription && <><p role="status">Sharing generic status while this view is open. Collection pauses in the background; the last snapshot expires after one minute.</p><button onClick={stop}>Stop Apple status</button></>}
    <p>Watch Review opens the approval screen on your active iPhone. Approve and deny actions require that screen. Token usage appears only when an inspected usage sample is supplied.</p>
    {error && <p role="alert" className="inline-error">{error}</p>}
  </section>;
}

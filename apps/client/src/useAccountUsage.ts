import {useCallback,useEffect,useRef,useState} from 'react';
import {useAccessSnapshot,bindProtectedInvoke,captureAccess} from './access';
import type {AccountUsageResponse} from './accountUsageReport';
import {entryForTarget,type UsageTarget} from './usageAgentProvider';
const INTERVAL=300_000;
/** `target` is the account the status bar follows (null: the host's default account); the details page keeps its own account choice. */
export function useAccountUsage(sessionId:string|null,active=true,target:UsageTarget|null=null) {
  const access=useAccessSnapshot();
  const [stored,setStored]=useState<{sessionId:string;response:AccountUsageResponse}|null>(null);
  const [refreshing,setRefreshing]=useState(false);
  const [selection,setSelection]=useState<{sessionId:string;id:string;base:string}|null>(null);
  const [tick,setTick]=useState(0);
  const [visible,setVisible]=useState(()=>document.visibilityState!=='hidden');
  useEffect(()=>{const changed=()=>setVisible(document.visibilityState!=='hidden');document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
  const request=useRef(0);
  const inflight=useRef(false);
  const refresh=useCallback(()=>setTick(n=>n+1),[]);
  useEffect(()=>{
    const invoke=bindProtectedInvoke(captureAccess());
    const generation=++request.current;
    let live=true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const allowed=()=>live && request.current===generation && active && sessionId!==null && visible && !access.status?.locked;
    const read=async()=>{
      if(!allowed()) return;
      if(inflight.current) {timer=setTimeout(()=>void read(),100);return;}
      inflight.current=true;setRefreshing(true);
      try {
        const response=await invoke<AccountUsageResponse>('account_usage',{sessionId});
        if(allowed()) setStored(previous=>({sessionId:sessionId!,response:response.state==='ready'||previous?.sessionId!==sessionId?response:{...response,source:previous.response.source,report:previous.response.report}}));
      } catch {
        if(allowed()) setStored(previous=>({sessionId:sessionId!,response:{schemaVersion:1,state:'unavailable',source:previous?.sessionId===sessionId?previous.response.source:null,report:previous?.sessionId===sessionId?previous.response.report:null}}));
      } finally {
        inflight.current=false;
        if(live) setRefreshing(false);
        if(allowed()) timer=setTimeout(()=>void read(),INTERVAL);
      }
    };
    if(!active||!visible||sessionId===null)setRefreshing(false);
    void read();
    return ()=>{live=false;if(timer)clearTimeout(timer);};
  },[sessionId,active,visible,tick,access.epoch,access.status?.locked]);
  const response=stored?.sessionId===sessionId?stored.response:null;
  const entries=response?.report?.entries??[];
  // A pick on the details page lasts until the followed agent or provider changes.
  const base=target?`${target.providerId}|${target.label}`:'';
  const selected=selection?.sessionId===sessionId && selection.base===base?selection.id:null;
  const primary=entries.find(e=>e.id===response?.report?.primary)??entries[0]??null;
  const bar=target?entryForTarget(entries,target)??null:primary;
  const entry=entries.find(e=>e.id===selected)??bar??primary;
  return {response,refreshing,refresh,entry,bar,target,select:(id:string)=>{if(sessionId)setSelection({sessionId,id,base});}};
}
export type AccountUsageModel=ReturnType<typeof useAccountUsage>;

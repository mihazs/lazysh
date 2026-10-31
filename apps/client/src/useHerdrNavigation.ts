import {useEffect,useMemo,useRef,useState} from 'react';
import {bindProtectedInvoke,captureAccess} from './access';
import {captureUiError,LocalUiError,type UiErrorCause} from './i18n/localError';

export type LiveAgent={terminal_id:string;pane_id:string;workspace_id:string;tab_id:string;agent_status:'idle'|'working'|'blocked'|'done'|'unknown';agent:string|null;name:string|null;cwd:string|null};
export type HerdrTree = {
  workspaces: {workspace_id:string;label:string;focused:boolean;agent_status:LiveAgent['agent_status']}[];
  tabs: {workspace_id:string;tab_id:string;label:string;number:number;focused:boolean;agent_status:LiveAgent['agent_status']}[];
  panes: {workspace_id:string;tab_id:string;pane_id:string;terminal_id?:string;cwd?:string|null;focused:boolean;agent_status:LiveAgent['agent_status']}[];
  agents?:Omit<LiveAgent,'cwd'>[];
};
export const herdrStatusKeys={idle:'herdrAgentIdle',working:'herdrAgentWorking',blocked:'herdrAgentBlocked',done:'herdrAgentDone',unknown:'herdrAgentUnknown'} as const;
const invalid=()=>new LocalUiError('herdrAgentsInvalid');
function boundedText(value:unknown,limit:number):value is string {
  return typeof value==='string' && value.length>0 && new TextEncoder().encode(value).length<=limit && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
}
function servers(value:unknown):string[] {
  if(!Array.isArray(value) || value.length>1000)throw invalid();
  const names=value.map(row=>{if(!row || !boundedText(row.name,200))throw invalid();return row.name as string;});
  if(new Set(names).size!==names.length)throw invalid();
  return names;
}
export function parseHerdrAgents(value:unknown):LiveAgent[] {
  if(!value || typeof value!=='object')throw invalid();
  const tree=value as {agents?:unknown;panes?:unknown};
  if(tree.agents===undefined)throw new LocalUiError('herdrAgentsUnsupported');
  if(!Array.isArray(tree.panes) || tree.panes.length>4096 || (tree.agents!==undefined && (!Array.isArray(tree.agents) || tree.agents.length>4096)))throw invalid();
  const seen=new Set<string>();
  return ((tree.agents??[]) as unknown[]).map(item=>{
    if(!item || typeof item!=='object')throw invalid();
    const row=item as Record<string,unknown>;
    if(!boundedText(row.terminal_id,256) || !boundedText(row.workspace_id,50) || !boundedText(row.tab_id,50) || !boundedText(row.pane_id,50)
      || typeof row.agent_status!=='string' || !Object.hasOwn(herdrStatusKeys,row.agent_status)
      || (row.agent!=null && !boundedText(row.agent,200)) || (row.name!=null && !boundedText(row.name,64)))throw invalid();
    const pane=(tree.panes as Record<string,unknown>[]).find(p=>p && p.pane_id===row.pane_id && p.workspace_id===row.workspace_id && p.tab_id===row.tab_id);
    const key=JSON.stringify([row.terminal_id,row.pane_id]);
    if(!pane || seen.has(key) || (pane.cwd!=null && !boundedText(pane.cwd,4096)))throw invalid();
    seen.add(key);
    return {terminal_id:row.terminal_id,pane_id:row.pane_id,workspace_id:row.workspace_id,tab_id:row.tab_id,agent_status:row.agent_status as LiveAgent['agent_status'],agent:(row.agent??null) as string|null,name:(row.name??null) as string|null,cwd:(pane.cwd??null) as string|null};
  });
}


/** One visibility- and lease-owned reader for a terminal's selected Herdr server. */
export function useHerdrNavigation({sessionId,herdrSession,visible}:{sessionId:string;herdrSession?:string;visible:boolean}) {
  const [lease]=useState(captureAccess);
  const invoke=useMemo(()=>bindProtectedInvoke(lease),[lease]);
  const [choice,setChoice]=useState<{host:string;name:string}|null>(null);
  const selected=choice?.host===sessionId?choice.name:herdrSession??'';
  const [result,setResult]=useState<{host:string;servers:string[];server:string;rows:LiveAgent[];snapshot?:HerdrTree;loaded:boolean}|null>(null);
  const [failure,setFailure]=useState<{host:string;cause:UiErrorCause}|null>(null);
  const [busy,setBusy]=useState(false);
  const [query,setQuery]=useState('');
  useEffect(()=>setQuery(''),[sessionId]);
  const flight=useRef(false);
  const refresh=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{
    let current=true;
    setResult(previous=>previous?.host===sessionId?{...previous,server:selected,rows:[],snapshot:undefined,loaded:false}:null);setFailure(null);setBusy(false);
    const read=async()=>{
      if(!current || !visible || document.hidden || !lease.current() || flight.current)return;
      flight.current=true;setBusy(true);
      const owns=()=>current && visible && !document.hidden && lease.current();
      try {
        const names=servers(await invoke('multiplexer_sessions',{sessionId,kind:'herdr'}));
        if(!owns())return;
        // An attached target is a read hint, never input authority or permission to substitute another server.
        const server=names.includes(selected)?selected:!selected && names.length===1?names[0]:'';
        setResult(previous=>previous?.host===sessionId && previous.server===server?{...previous,servers:names,loaded:previous.loaded || !server}:{host:sessionId,servers:names,server,rows:[],loaded:!server});
        if(server){
          const snapshot=await invoke<HerdrTree>('herdr_tree',{sessionId,name:server});
          const rows=snapshot.agents===undefined?[]:parseHerdrAgents(snapshot);
          if(owns())setResult({host:sessionId,servers:names,server,rows,snapshot,loaded:true});
        }
        if(owns())setFailure(null);
      }catch(error){if(owns()){setResult(previous=>previous?.host===sessionId?{...previous,rows:[],snapshot:undefined,loaded:false}:null);setFailure({host:sessionId,cause:captureUiError(error)});}}
      finally{flight.current=false;if(current)setBusy(false);else void refresh.current();}
    };
    refresh.current=read;
    if(visible)void read();
    const timer=visible?window.setInterval(()=>void read(),5000):undefined;
    return()=>{current=false;window.clearInterval(timer);};
  },[sessionId,selected,visible,invoke,lease]);
  const data=result?.host===sessionId?result:null;
  const agentFailure=data?.snapshot && data.snapshot.agents===undefined?{host:sessionId,cause:new LocalUiError('herdrAgentsUnsupported')}:failure;
  return {data,failure,agentFailure,busy,query,setQuery,lease,refresh:()=>refresh.current(),selectServer:(name:string)=>setChoice({host:sessionId,name})};
}

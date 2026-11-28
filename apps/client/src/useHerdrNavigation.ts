import {useEffect,useMemo,useRef,useState} from 'react';
import {bindProtectedInvoke,captureAccess} from './access';
import {captureUiError,LocalUiError,type UiErrorCause} from './i18n/localError';
import {withReportedStatus,type ReportedSessionSource} from './HerdrSessionDetails';
import {rememberHerdrAgents,useHerdrEvents} from './herdrEvents';

export type ReportedSessionRef={source:string;agent:'codex'|'claude'|'opencode';kind:'id';value:string};
function reportedSession(value:unknown,agent:unknown):ReportedSessionRef|undefined {
  if(!value || typeof value!=='object')return;
  const v=value as Record<string,unknown>;
  if(!['codex','claude','opencode'].includes(v.agent as string) || v.agent!==agent || v.source!==`herdr:${v.agent}` || v.kind!=='id'
    || !boundedText(v.value,256) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(v.value))return;
  return {source:v.source as string,agent:v.agent as ReportedSessionRef['agent'],kind:'id',value:v.value};
}
export type LiveAgent={terminal_id:string;pane_id:string;workspace_id:string;tab_id:string;agent_status:'idle'|'working'|'blocked'|'done'|'unknown';agent:string|null;name:string|null;cwd:string|null;agent_session?:ReportedSessionRef;
  /** Set when an Unknown Herdr state was replaced by the exact matching companion report. */
  status_source?:'report'};
export type HerdrTree = {
  workspaces: {workspace_id:string;label:string;focused:boolean;agent_status:LiveAgent['agent_status']}[];
  tabs: {workspace_id:string;tab_id:string;label:string;number:number;focused:boolean;agent_status:LiveAgent['agent_status']}[];
  panes: {workspace_id:string;tab_id:string;pane_id:string;terminal_id?:string;cwd?:string|null;label?:string;focused:boolean;agent_status:LiveAgent['agent_status']}[];
  agents?:Omit<LiveAgent,'cwd'>[];
};
/** Where the guarded Herdr client attached through this terminal shows itself, in the server's public identifiers. */
type ClientLocation=Readonly<{workspace:string;tab:string;pane:string;terminal:string}>;
function clientLocation(reply:unknown,server:string):ClientLocation|undefined {
  const row=reply as {kind?:unknown;server?:unknown;destination?:Record<string,unknown>}|null;
  const at=row?.destination;
  if(!at || row.kind!=='observed' || row.server!==server || !(['workspace','tab','pane','terminal'] as const).every(key=>boundedText(at[key],256)))return;
  return {workspace:at.workspace as string,tab:at.tab as string,pane:at.pane as string,terminal:at.terminal as string};
}
/** Herdr's snapshot flags are the server's shared focus; the guarded client's own read replaces them with what this display shows. */
export function withClientFocus(tree:HerdrTree,at:ClientLocation):HerdrTree {
  return {...tree,
    workspaces:tree.workspaces.map(item=>({...item,focused:item.workspace_id===at.workspace})),
    tabs:tree.tabs.map(item=>({...item,focused:item.workspace_id===at.workspace && item.tab_id===at.tab})),
    panes:tree.panes.map(item=>({...item,focused:item.workspace_id===at.workspace && item.tab_id===at.tab && item.pane_id===at.pane && item.terminal_id===at.terminal}))};
}
/** Display form of a host path: the login user's home becomes `~` and another user's home `~name`. */
export function homeRelativePath(path:string,destination:string) {
  const user=/^([^@\s/]+)@/.exec(destination)?.[1];
  const home=/^\/(?:home|Users)\/([^/]+)(?=\/|$)/.exec(path)??/^\/(root)(?=\/|$)/.exec(path);
  return home?`~${home[1]===user?'':home[1]}${path.slice(home[0].length)}`:path;
}
export const herdrStatusKeys={idle:'herdrAgentIdle',working:'herdrAgentWorking',blocked:'herdrAgentBlocked',done:'herdrAgentDone',unknown:'herdrAgentUnknown'} as const;
const invalid=()=>new LocalUiError('herdrAgentsInvalid');
function boundedText(value:unknown,limit:number):value is string {
  return typeof value==='string' && value.length>0 && new TextEncoder().encode(value).length<=limit && !/[\x00-\x1f\x7f-\x9f\uD800-\uDFFF]/u.test(value);
}
export function servers(value:unknown):string[] {
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
    const reference=reportedSession(row.agent_session,row.agent);
    return {...(reference?{agent_session:reference}:{}),terminal_id:row.terminal_id,pane_id:row.pane_id,workspace_id:row.workspace_id,tab_id:row.tab_id,agent_status:row.agent_status as LiveAgent['agent_status'],agent:(row.agent??null) as string|null,name:(row.name??null) as string|null,cwd:(pane.cwd??null) as string|null};
  });
}


/** While the host streams the server's events a change is read when it arrives; the timer then only re-reads
 * every this many ticks, in case an event was missed. */
const LIVE_SAFETY_TICKS=12;
/** One visibility- and lease-owned reader for a terminal's selected Herdr server. Where the host companion streams
 * `events.subscribe` (docs/companion.md), the tree is read when an event arrives instead of on every tick, and a
 * lost or unsupported stream returns to the timer.
 * `clientFocus` also asks the guarded client where it shows itself. That read shares the guard with Chat, so only the navigation surface that marks the current row asks for it. */
export function useHerdrNavigation({sessionId,herdrSession,visible,reports,intervalMs=5000,clientFocus=false}:{sessionId:string;herdrSession?:string;visible:boolean;reports?:ReportedSessionSource;intervalMs?:number;clientFocus?:boolean}) {
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
  const located=useRef<{host:string;server:string;at:ClientLocation}|null>(null);
  const live=useRef(false);
  const refresh=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{
    let current=true;
    let recoveryPending=false;
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
          let at:ClientLocation|undefined;
          if(clientFocus) {
            try {at=clientLocation(await invoke('herdr_chat',{sessionId,action:{kind:'observe'}}),server);}
            catch(error) {
              // Stock Herdr has no such read and keeps the shared focus. A Chat turn holds the guard only briefly, so keep the last reading instead of flickering back to it.
              if((error as {kind?:string}|undefined)?.kind==='herdr_chat_busy' && located.current?.host===sessionId && located.current.server===server)at=located.current.at;
            }
            located.current=at?{host:sessionId,server,at}:null;
          }
          if(owns()){setResult({host:sessionId,servers:names,server,rows,snapshot:at?withClientFocus(snapshot,at):snapshot,loaded:true});rememberHerdrAgents(sessionId,server,rows);}
        }
        if(owns())setFailure(null);
      }catch(error){if(owns()){setResult(previous=>previous?.host===sessionId?{...previous,rows:[],snapshot:undefined,loaded:false}:null);setFailure({host:sessionId,cause:captureUiError(error)});}}
      finally{flight.current=false;if(current)setBusy(false);else void refresh.current();if(recoveryPending){recoveryPending=false;void read();}}
    };
    refresh.current=read;
    if(visible)void read();
    const recovered=(event:Event)=>{
      if((event as CustomEvent<unknown>).detail!==sessionId || !visible || document.hidden || !lease.current())return;
      if(flight.current)recoveryPending=true;else void read();
    };
    window.addEventListener('lazysh-host-tools-restored',recovered);
    let quiet=0;
    const timer=visible?window.setInterval(()=>{
      if(live.current && ++quiet<LIVE_SAFETY_TICKS)return;
      quiet=0;void read();
    },intervalMs):undefined;
    return()=>{current=false;window.clearInterval(timer);window.removeEventListener('lazysh-host-tools-restored',recovered);};
  },[sessionId,selected,visible,invoke,lease,intervalMs,clientFocus]);
  const owned=result?.host===sessionId?result:null;
  const [shown,setShown]=useState(()=>!document.hidden);
  useEffect(()=>{
    const change=()=>setShown(!document.hidden);
    document.addEventListener('visibilitychange',change);
    return()=>document.removeEventListener('visibilitychange',change);
  },[]);
  const pending=useRef<number|undefined>(undefined);
  useEffect(()=>()=>window.clearTimeout(pending.current),[]);
  // One read after a burst of events, and never inside a read that is already running.
  const reread=()=>{
    window.clearTimeout(pending.current);
    pending.current=window.setTimeout(function again(){
      if(flight.current){pending.current=window.setTimeout(again,250);return;}
      void refresh.current();
    },250);
  };
  const watch=useHerdrEvents({enabled:visible && shown,sessionId,server:owned?.server??'',lease,invoke,onEvent:reread});
  live.current=watch==='live';
  const reportReadable=!!reports?.available && reports.lease.current();
  const data=useMemo(()=>owned && withReportedStatus(owned,reports,sessionId),[owned,reports?.rows,reports?.host,reportReadable,sessionId]);
  const agentFailure=data?.snapshot && data.snapshot.agents===undefined?{host:sessionId,cause:new LocalUiError('herdrAgentsUnsupported')}:failure;
  return {data,failure,agentFailure,busy,query,setQuery,lease,watch,refresh:()=>refresh.current(),selectServer:(name:string)=>setChoice({host:sessionId,name})};
}

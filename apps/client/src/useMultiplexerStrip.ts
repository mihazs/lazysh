import {useEffect,useMemo,useRef,useState} from 'react';
import {useMountedAccess,useProtectedApi,useProtectedInvoke} from './access';
import {api as nativeApi} from './bridge';
import {captureUiError,LocalUiError,type UiErrorCause} from './i18n/localError';
import {herdrFocusAction,herdrStrip,muxEditAction,tmuxStrip,zellijStrip,type MuxEdit,type MuxRef,type MuxStrip,type ZellijTabRow} from './multiplexerTabs';
import {useHerdrNavigation,type HerdrTree} from './useHerdrNavigation';
import type {SessionAttachment} from './workspace';

const interval=5000;
/** Reads `load` now and every few seconds while `enabled`; a failed read keeps the last good one, so a brief outage does not blank the strip. */
function usePolled<T>(enabled:boolean,key:string,load:()=>Promise<T>) {
  const [result,setResult]=useState<{key:string;value:T}>();
  const latest=useRef(load);latest.current=load;
  const refresh=useRef<()=>Promise<void>>(async()=>{});
  useEffect(()=>{
    if(!enabled)return;
    let current=true,flight=false;
    const read=async()=>{
      if(!current || flight || document.hidden)return;
      flight=true;
      try {const value=await latest.current();if(current)setResult({key,value});}
      catch {/* The navigation sheets report host errors; the strip just keeps what it last read. */}
      finally {flight=false;}
    };
    refresh.current=read;
    void read();
    const timer=window.setInterval(()=>void read(),interval);
    return()=>{current=false;window.clearInterval(timer);};
  },[enabled,key]);
  return {value:result?.key===key?result.value:undefined,refresh:()=>refresh.current()};
}

/**
 * The tabs of the multiplexer a terminal is attached to as one backend-agnostic strip. Herdr reuses the navigation reader, Zellij reads
 * `zellij_tabs`, and tmux reads the Jump To snapshot of the same control stream; a selection goes through each one's guarded command.
 */
export function useMultiplexerStrip({sessionId,attached,enabled,onError}:{sessionId:string;attached?:SessionAttachment;enabled:boolean;onError:(cause:UiErrorCause)=>void}) {
  const invoke=useProtectedInvoke();
  const api=useProtectedApi(nativeApi);
  const {access,mounted}=useMountedAccess();
  const kind=attached?.kind,name=attached?.name??'';
  const herdr=useHerdrNavigation({sessionId,herdrSession:kind==='herdr'?name:undefined,visible:enabled && kind==='herdr'});
  const zellij=usePolled(enabled && kind==='zellij',`${sessionId}:${name}`,()=>invoke<ZellijTabRow[]>('zellij_tabs',{sessionId,name}));
  const tmux=usePolled(enabled && kind==='tmux',sessionId,()=>api.tmuxJumpSnapshot(sessionId));
  const herdrTree=herdr.data?.snapshot;
  const read=useMemo(()=>kind==='herdr'?herdrTree && herdrStrip(herdrTree):kind==='zellij'?zellij.value && zellijStrip(name,zellij.value):kind==='tmux'?tmux.value && tmuxStrip(tmux.value):undefined,
    [kind,name,herdrTree,zellij.value,tmux.value]);
  // Returning to a terminal shows what it last read while the new reading is on its way, so the strip does not blink in and out.
  const owner=`${kind}:${sessionId}:${name}`,last=useRef<{owner:string;strip:MuxStrip}|undefined>(undefined);
  if(read)last.current={owner,strip:read};
  const strip=enabled?read??(last.current?.owner===owner?last.current.strip:undefined):undefined;
  const busy=useRef(false);
  const [pending,setPending]=useState(false);
  // One command at a time, each one's host error reported and its multiplexer read again afterwards so the strip shows the result at once.
  async function guarded(reread:()=>Promise<void>,work:()=>Promise<void>):Promise<boolean> {
    if(busy.current || !mounted.current || !access.current())return false;
    busy.current=true;setPending(true);
    try {await work();return true;}
    catch(error) {if(mounted.current && access.current())onError(captureUiError(error));return false;}
    finally {
      busy.current=false;
      if(mounted.current){setPending(false);void reread();}
    }
  }
  // Checked against a fresh tree: a workspace or tab that has gone is refused, never acted on by guess.
  const herdrServer=()=>{
    const server=herdr.data?.server;
    if(!server)throw new LocalUiError('herdrNavigationChanged');
    return server;
  };
  const freshTree=(server:string)=>invoke<HerdrTree>('herdr_tree',{sessionId,name:server});
  const select=(ref:MuxRef)=>guarded(ref.kind==='herdr'?herdr.refresh:ref.kind==='zellij'?zellij.refresh:tmux.refresh,async()=>{
    if(ref.kind==='herdr') {
      const server=herdrServer();
      await invoke('herdr_action',{sessionId,name:server,action:herdrFocusAction(await freshTree(server),ref.target)});
    } else if(ref.kind==='zellij')await invoke('zellij_action',{sessionId,name,action:{type:'goToTab',index:ref.index}});
    else await api.tmuxJump(sessionId,ref.generation,ref.session,ref.window);
  });
  /** Resolves true once the command ran. Renames or creates through the multiplexer's typed action; a new tab or window is then switched to, like the multiplexer's own `new-tab`. */
  const edit=(change:MuxEdit,label:string,directory:string)=>guarded(change.kind==='herdr'?herdr.refresh:change.kind==='zellij'?zellij.refresh:tmux.refresh,async()=>{
    if(change.kind==='herdr') {
      const server=herdrServer(),before=await freshTree(server);
      await invoke('herdr_action',{sessionId,name:server,action:muxEditAction(change,label,directory,before)});
      if(change.type!=='createTab')return;
      const after=await freshTree(server),known=new Set(before.tabs.map(tab=>tab.tab_id));
      const created=after.tabs.filter(tab=>tab.workspace_id===change.workspace && !known.has(tab.tab_id));
      if(created.length===1)await invoke('herdr_action',{sessionId,name:server,action:herdrFocusAction(after,{kind:'tab',workspace:change.workspace,tab:created[0].tab_id})});
    } else if(change.kind==='zellij')await invoke('zellij_action',{sessionId,name,action:muxEditAction(change,label,directory)});
    else {
      const before=change.type==='createWindow'?await api.tmuxJumpSnapshot(sessionId):undefined;
      await invoke('tmux_action',{sessionId,action:muxEditAction(change,label,directory),...(attached?.tmuxServer && attached.tmuxServer!=='default'?{tmuxServer:attached.tmuxServer}:{})});
      if(!before || change.type!=='createWindow')return;
      const after=await api.tmuxJumpSnapshot(sessionId),known=new Set(before.sessions.flatMap(session=>session.windows.map(window=>window.id)));
      const created=after.sessions.find(session=>session.id===change.target)?.windows.filter(window=>!known.has(window.id))??[];
      if(created.length===1)await api.tmuxJump(sessionId,after.generation,change.target,created[0].id);
    }
  });
  return {strip,pending,select,edit};
}

import {useEffect,useMemo,useRef,useState} from 'react';
import {useMountedAccess,useProtectedApi,useProtectedInvoke} from './access';
import {api as nativeApi} from './bridge';
import {captureUiError,LocalUiError,type UiErrorCause} from './i18n/localError';
import {herdrFocusAction,herdrStrip,tmuxStrip,zellijStrip,type MuxRef,type MuxStrip,type ZellijTabRow} from './multiplexerTabs';
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
  async function select(ref:MuxRef) {
    if(busy.current || !mounted.current || !access.current())return;
    busy.current=true;setPending(true);
    const reread=ref.kind==='herdr'?herdr.refresh:ref.kind==='zellij'?zellij.refresh:tmux.refresh;
    try {
      if(ref.kind==='herdr') {
        const server=herdr.data?.server;
        if(!server)throw new LocalUiError('herdrNavigationChanged');
        // Checked against a fresh tree: a tab that has gone is refused, never focused by guess.
        const action=herdrFocusAction(await invoke<HerdrTree>('herdr_tree',{sessionId,name:server}),ref.target);
        await invoke('herdr_action',{sessionId,name:server,action});
      } else if(ref.kind==='zellij')await invoke('zellij_action',{sessionId,name,action:{type:'goToTab',index:ref.index}});
      else await api.tmuxJump(sessionId,ref.generation,ref.session,ref.window);
    } catch(error) {if(mounted.current && access.current())onError(captureUiError(error));}
    finally {
      busy.current=false;
      if(mounted.current){setPending(false);void reread();}
    }
  }
  return {strip,pending,select};
}

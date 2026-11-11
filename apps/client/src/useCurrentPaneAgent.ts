import {useEffect,useState} from 'react';
import {bindProtectedInvoke,captureAccess,useAccessSnapshot} from './access';
import {parseSnapshot} from './AgentPanel';
import {parseTerminalSnapshot} from './ChatTerminalInput';
import {focusedPane} from './herdrPaneLink';
import {useHerdrNavigation} from './useHerdrNavigation';

const INTERVAL=5000;
/** The companion writes this summary when an agent's session ends, so the pane no longer runs it. */
const SESSION_ENDED='Session ended';

/** The agent in the tmux pane the terminal is attached to: the newest companion hook report carrying that pane's `TMUX_PANE`. `undefined` until the first read. */
function useTmuxPaneAgent(sessionId:string|null) {
  const access=useAccessSnapshot();
  const [found,setFound]=useState<{sessionId:string;agent:string|null}|null>(null);
  useEffect(()=>{
    if(sessionId===null)return;
    const lease=captureAccess();
    const invoke=bindProtectedInvoke(lease);
    let live=true,flight=false;
    const read=async()=>{
      if(flight||document.hidden||!lease.current())return;
      flight=true;
      let agent:string|null=null;
      try {
        const reports=parseSnapshot(await invoke('agent_snapshot',{sessionId}));
        const pane=parseTerminalSnapshot(await invoke('tmux_chat',{sessionId,action:{kind:'snapshot'}})).destination.paneId;
        const newest=reports.find(row=>row.paneId===pane);
        agent=newest&&newest.summary!==SESSION_ENDED?newest.agent:null;
      } catch { /* An old companion or a pane that cannot be read means no agent is known, so the default account shows. */ }
      finally {flight=false;}
      if(live&&lease.current())setFound({sessionId,agent});
    };
    void read();
    const timer=setInterval(()=>void read(),INTERVAL);
    return()=>{live=false;clearInterval(timer);};
  },[sessionId,access.epoch]);
  return found?.sessionId===sessionId?found.agent:undefined;
}

/** The agent running in the pane the user is looking at: its name, null when none is detected or the pane cannot be read, undefined until the first read.
 * Herdr: the focused pane of the attached server, resolved by the Agent view's `focusedPane`. tmux: the companion's hook report for the attached pane.
 * A plain shell, Zellij or a local terminal has no pane identity, so no agent is detected there. Reads happen only while `enabled` (the usage item is on screen and follows the agent). */
export function useCurrentPaneAgent(sessionId:string|null,attached:{kind:string;name:string}|undefined,enabled:boolean):string|null|undefined {
  const herdrSession=attached?.kind==='herdr'?attached.name:undefined;
  const herdr=useHerdrNavigation({sessionId:sessionId??'',herdrSession,visible:enabled&&sessionId!==null&&herdrSession!==undefined});
  const tmux=useTmuxPaneAgent(enabled&&attached?.kind==='tmux'?sessionId:null);
  if(attached?.kind==='tmux')return tmux;
  if(herdrSession===undefined)return null;
  const data=herdr.data;
  if(herdr.failure||herdr.agentFailure)return null;
  if(!data?.loaded)return undefined;
  return focusedPane(data)?.agent?.agent||null;
}

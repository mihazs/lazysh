import {createRoot} from 'react-dom/client';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import HerdrNavigation from '../../src/HerdrNavigation';
import NotificationPanel,{NotificationMonitor} from '../../src/NotificationPanel';

type Channel={onmessage:(event:unknown)=>void};
const pane=(id:string,status:string)=>({workspace_id:'w1',tab_id:'w1:t1',pane_id:id,terminal_id:`term-${id}`,cwd:'/srv/app',focused:id==='w1:p1',agent_status:status});
/** A tree of one workspace with a Codex pane in the given status. */
export const treeWith=(status:string)=>({
  workspaces:[{workspace_id:'w1',label:'Development',focused:true,agent_status:status}],
  tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'agents',number:1,focused:true,agent_status:status}],
  panes:[pane('w1:p1','idle'),pane('w1:p2',status)],
  agents:[{terminal_id:'term-w1:p2',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p2',name:null,agent:'codex',agent_status:status,agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'codex-session-1'}}],
});

/** The real Herdr view, notification monitor and inbox over one recorded synthetic bridge whose event stream the test drives.
 * `watch` is how the host answers `agent_watch_start`: a live stream, a companion that cannot stream, or a channel that cannot open. */
export function mountHerdrEvents(options:{watch:'live'|'old'|'off';status:string;view?:boolean}) {
  const calls:{command:string;args:Record<string,unknown>}[]=[];
  let tree=treeWith(options.status),channel:Channel|undefined;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic Herdr events authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'e'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'isTauri',{configurable:true,value:true});
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{transformCallback:()=>1,unregisterCallback(){},invoke:async(command:string,args:Record<string,unknown>={})=>{
    calls.push({command,args});
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_tree')return tree;
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
    if(command==='agent_watch_start'){
      if(options.watch==='off')throw new Error('The channel could not open');
      channel=args.events as Channel;
      setTimeout(()=>channel!.onmessage(options.watch==='old'?{type:'unavailable',reason:'companion_required'}:{type:'frame',frame:{type:'hello',protocol:1,session:'default'}}));
      return 'watch-1';
    }
    if(command==='agent_watch_stop'||command==='notify_agent_attention')return;
    if(command==='plugin:notification|is_permission_granted')return true;
    if(command.startsWith('plugin:'))return;
    throw new Error(`Unexpected Herdr events fixture command: ${command}`);
  }}});
  const sessions=[{id:'herdr-events-host',hostId:'h1',name:'builder',connected:true}];
  const host=document.createElement('div');host.className='herdr-events-fixture';
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'20',background:'var(--background)',padding:'12px',display:'flex',flexDirection:'column',gap:'12px'});document.body.append(host);
  const root=createRoot(host);
  root.render(<>
    <NotificationMonitor sessions={sessions}/>
    {options.view!==false && <HerdrNavigation sessionId="herdr-events-host" hostLabel="builder" herdrSession="default" visible mode="spaces"
      onNavigate={async()=>{}} onAttach={async()=>{throw new Error('No attach');}} onClose={()=>{}}/>}
    <NotificationPanel sessions={sessions}/>
  </>);
  return {
    calls,
    /** Changes what the next tree read returns. */
    setStatus(status:string){tree=treeWith(status);},
    /** One companion frame, as the native channel delivers it. */
    emit(frame:unknown){channel!.onmessage({type:'frame',frame});},
    dispose(){root.unmount();host.remove();},
  };
}

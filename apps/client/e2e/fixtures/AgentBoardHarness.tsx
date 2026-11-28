import {agentBoardContainer} from './agentBoardContainer';
import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import AgentPanel from '../../src/AgentPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {agentApproval,agentBoardRecord,agentBoardSession,companionSettings,notificationPolicy,inactiveBoardDisplay} from '../../src/test/agentBoardData';

/** Real board with synthetic host records and deliberately held native decisions. */
export function mountAgentBoard(host?:{key:string;label:string}){
  const calls:{command:string;args:unknown}[]=[];
  let hostBrowser={schemaVersion:1,revision:0,hostBrowserEnabled:false};
  let reports=[agentBoardRecord];
  let update:{state:string;from:string;to:string;reason?:string}|undefined;
  const approval=agentApproval();let decided=false;let finish!:(value:unknown)=>void;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic agent board authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:reports,...(update?{update}:{})};
    if(command==='agent_approvals')return {schemaVersion:1,requests:decided?[]:[approval]};
    if(command==='get_companion_settings')return companionSettings;
    if(command==='get_notification_policy')return notificationPolicy;
    if(command==='update_companion_settings'){const {expectedRevision:_,...settings}=(args as {settings:typeof companionSettings & {expectedRevision:number}}).settings;return {...companionSettings,...settings,revision:8};}
    if(command==='get_host_browser_settings')return hostBrowser;
    if(command==='update_host_browser_settings'){const {hostBrowserEnabled}=(args as {settings:{hostBrowserEnabled:boolean}}).settings;hostBrowser={...hostBrowser,revision:hostBrowser.revision+1,hostBrowserEnabled};return hostBrowser;}
    if(command==='resolve_agent_approval')return new Promise(resolve=>{finish=resolve;});
    if(command==='board_keep_awake_status')return inactiveBoardDisplay;
    throw new Error('Unexpected agent board fixture command');
  }}});
  const container=agentBoardContainer();
  const root=createRoot(container);
  function Fixture() {
    const [target,setTarget]=useState<HTMLDivElement|null>(null),[opened,setOpened]=useState(false);
    return <><AgentPanel sessionId={agentBoardSession} hostKey={host?.key} hostLabel={host?.label} settingsTarget={target} settingsActive={opened} onOpenSetup={()=>setOpened(true)}/><div ref={setTarget} hidden={!opened}/></>;
  }
  root.render(<Fixture/>);
  return {calls,setReports(rows:typeof reports){reports=rows;},setUpdate(next?:typeof update){update=next;},complete(){decided=true;finish({schemaVersion:1,accepted:true});},dispose(){root.unmount();container.remove();}};
}

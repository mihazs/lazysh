import {createRoot} from 'react-dom/client';
import AgentPanel from '../../src/AgentPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {agentApproval,agentBoardRecord,agentBoardSession,companionSettings,inactiveBoardDisplay} from '../../src/test/agentBoardData';

/** Real board with synthetic host records and deliberately held native decisions. */
export function mountAgentBoard(){
  const calls:{command:string;args:unknown}[]=[];
  const approval=agentApproval();let decided=false;let finish!:(value:unknown)=>void;
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic agent board authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:unknown)=>{
    calls.push({command,args});
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:[agentBoardRecord]};
    if(command==='agent_approvals')return {schemaVersion:1,requests:decided?[]:[approval]};
    if(command==='get_companion_settings')return companionSettings;
    if(command==='update_companion_settings'){const {expectedRevision:_,...settings}=(args as {settings:typeof companionSettings & {expectedRevision:number}}).settings;return {...companionSettings,...settings,revision:8};}
    if(command==='resolve_agent_approval')return new Promise(resolve=>{finish=resolve;});
    if(command==='board_keep_awake_status')return inactiveBoardDisplay;
    throw new Error('Unexpected agent board fixture command');
  }}});
  const host=document.createElement('div');host.className='agent-board-fixture';
  Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'100',background:'var(--background)',padding:'12px'});document.body.append(host);
  const root=createRoot(host);root.render(<AgentPanel sessionId={agentBoardSession}/>);
  return {calls,complete(){decided=true;finish({schemaVersion:1,accepted:true});},dispose(){root.unmount();host.remove();}};
}

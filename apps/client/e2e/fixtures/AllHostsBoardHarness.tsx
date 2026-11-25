import {agentBoardContainer} from './agentBoardContainer';
import {createRoot} from 'react-dom/client';
import AgentPanel from '../../src/AgentPanel';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';

type Hosts = Record<string,{key:string;label:string}>;

/** The real board with two connected hosts that answer their own snapshots, so one of them can be made to fail. */
export function mountAllHostsBoard(hosts:Hosts,active:string) {
  const calls:{command:string;sessionId:string}[]=[];
  const reports:Record<string,unknown[]>={};
  const failing=new Set<string>();
  const opened:unknown[]=[];
  window.addEventListener('lazysh-inbox-open',event=>opened.push((event as CustomEvent).detail));
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic all hosts board authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'c'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:{sessionId:string})=>{
    calls.push({command,sessionId:args.sessionId});
    if(command==='agent_snapshot'){if(failing.has(args.sessionId))throw new Error('Owned fixture companion unavailable');return {schemaVersion:1,sessions:reports[args.sessionId]??[]};}
    if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
    throw new Error('Unexpected all hosts board fixture command');
  }}});
  const container=agentBoardContainer();
  const root=createRoot(container);
  root.render(<AgentPanel sessionId={active} hostKey={hosts[active].key} hostLabel={hosts[active].label} showHerdr={false} hosts={Object.entries(hosts).map(([sessionId,host])=>({sessionId,hostKey:host.key,hostLabel:host.label}))}/>);
  return {calls,opened,setReports(sessionId:string,rows:unknown[]){reports[sessionId]=rows;},fail(sessionId:string,on:boolean){if(on)failing.add(sessionId);else failing.delete(sessionId);},dispose(){root.unmount();container.remove();}};
}

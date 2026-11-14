import {createRoot} from 'react-dom/client';
import HerdrNavigation from '../../src/HerdrNavigation';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import type {HerdrNavigationTarget} from '../../src/bridge';

type Request={target:Record<string,string>;agent?:{kind:string;name:string;prompt?:string}};
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
const step=(stage:string,argv:string[])=>({stage,argv,command:argv.map(quote).join(' ')});
/** A stand-in for the native plan: the dialog must display exactly what it returns. */
function plan(server:string,{target,agent}:Request) {
  const steps=[];
  const worktree=target.type==='worktree';
  if(agent)steps.push(step('agentCheck',['command','-v','--',agent.kind]));
  if(worktree)steps.push(step('worktree',['git','-C',target.repository,'worktree','add','-b',target.branch,'--',target.path,target.base]));
  steps.push(step('workspace',['herdr','--session',server,'workspace','create','--no-focus','--label',worktree?target.branch:target.label,'--cwd',worktree?target.path:target.directory]));
  if(agent)steps.push(step('agent',['herdr','--session',server,'agent','start',agent.name,'--kind',agent.kind,'--pane','<new-workspace-pane>','--timeout','60000',...(agent.prompt?['--',agent.prompt]:[])]));
  return {steps};
}
const tree={
  workspaces:[{workspace_id:'w1',label:'Development',focused:true,agent_status:'idle'},{workspace_id:'w2',label:'Scratch',focused:false,agent_status:'unknown'}],
  tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'shell',number:1,focused:true,agent_status:'idle'},{workspace_id:'w2',tab_id:'w2:t1',label:'1',number:1,focused:false,agent_status:'unknown'}],
  panes:[{workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',terminal_id:'t1',cwd:'/srv/app',focused:true,agent_status:'idle'},{workspace_id:'w2',tab_id:'w2:t1',pane_id:'w2:p1',terminal_id:'t2',cwd:null,focused:false,agent_status:'unknown'}],
  agents:[],
};

/** Real Herdr Spaces view and creation dialog over a recorded synthetic bridge. */
export function mountHerdrCreate(options:{outcome?:Record<string,unknown>;tree?:unknown;hostLabel?:string;sidebar?:boolean}={}) {
  const calls:{command:string;args:Record<string,unknown>}[]=[];
  const navigations:HerdrNavigationTarget[]=[];
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic Herdr creation authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'d'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>)=>{
    calls.push({command,args});
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_tree')return options.tree??tree;
    if(command==='list_directory')return args.path==='/'?[{name:'srv',isDir:true,size:0},{name:'.hidden',isDir:true,size:0},{name:'notes.txt',isDir:false,size:3}]:args.path==='/srv'?[{name:'api',isDir:true,size:0}]:[];
    if(command==='herdr_repository')return {root:'/srv/app',main:'/srv/app',head:'main',detached:false,worktrees:['/srv/app','/srv/app-worktrees/old']};
    if(command==='herdr_agent_kinds')return [{kind:'codex',label:'Codex',executable:'codex',prompt:true,installed:true},{kind:'claude',label:'Claude Code',executable:'claude',prompt:true,installed:false},{kind:'opencode',label:'OpenCode',executable:'opencode',prompt:false,installed:true}];
    if(command==='herdr_workspace_plan')return plan(args.name as string,args.request as Request);
    if(command==='herdr_workspace_create')return options.outcome??{workspaceId:'w9',paneId:'w9:p1'};
    throw new Error(`Unexpected Herdr creation fixture command: ${command}`);
  }}});
  const host=document.createElement('div');host.className='herdr-create-fixture';Object.assign(host.style,{position:'fixed',inset:'0',overflow:'auto',zIndex:'20',background:'var(--background)',padding:'12px'});document.body.append(host);
  const root=createRoot(host);
  const view=<HerdrNavigation sessionId="herdr-create-host" hostLabel={options.hostLabel??'builder'} herdrSession="default" visible mode="spaces"
    onNavigate={async(_server,target)=>{navigations.push(target);}} onAttach={async()=>{throw new Error('No attach');}} onClose={()=>{}}/>;
  // The sidebar option places the view in the app's Workspaces sidebar so its shared grid and widths apply.
  root.render(options.sidebar?<aside className="sidebar sidebar-open" data-navigation="workspaces">{view}</aside>:view);
  return {calls,navigations,dispose(){root.unmount();host.remove();}};
}

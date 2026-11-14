import {createRoot} from 'react-dom/client';
import AgentView from '../../src/AgentView';
import '../../src/AgentView.css';
import {accessSnapshot,acknowledgeAccessReady,applyAccessStatus} from '../../src/access';
import {tmuxChatBound,tmuxChatReply,tmuxChatSnapshot} from '../../src/test/tmuxChat';
import {herdrNavigationTree} from '../../src/test/herdrNavigation';

export type Kind='tmux'|'zellij'|'herdr';
type Request={target:Record<string,unknown>;agent?:{kind:string;name:string;prompt?:string}};
const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
const step=(stage:string,argv:string[])=>({stage,argv,command:argv.map(quote).join(' ')});
const session={tmux:'work',zellij:'main',herdr:'default'} as const;
/** A stand-in for the native plan, with the argv the Rust plan builders produce (their exact words are asserted against real tmux, Zellij and Herdr by the cargo tests): the dialog must show what it returns. */
function plan(kind:Kind,{target,agent}:Request) {
  const worktree=target.type==='worktree';
  const directory=String(worktree?target.path:target.directory),label=String(worktree?target.branch:target.label);
  const steps=[step('agentCheck',['command','-v','--',agent!.kind])];
  if(target.create)steps.push(step('folder',['mkdir','-p','--',directory]));
  else if(!worktree && kind!=='herdr')steps.push(step('folderCheck',['test','-d',directory]));
  if(worktree)steps.push(step('worktree',['git','-C',String(target.repository),'worktree','add','-b',String(target.branch),'--',directory,String(target.base)]));
  const launch=[agent!.kind,...(agent!.prompt?[agent.prompt]:[])];
  if(kind==='tmux')steps.push(step('window',['tmux','-u','-L','default','new-window','-P','-F','#{pane_id}','-t','=work:','-n',label,'-c',directory,'--',...launch]));
  else if(kind==='zellij')steps.push(step('pane',['zellij','--session=main','run',`--cwd=${directory}`,`--name=${label}`,'--',...launch]));
  else steps.push(step('workspace',['herdr','--session','default','workspace','create','--no-focus','--label',label,'--cwd',directory]),step('agent',['herdr','--session','default','agent','start',agent!.name,'--kind',agent!.kind,'--pane','<new-workspace-pane>','--timeout','60000',...(agent!.prompt?['--',agent.prompt]:[])]));
  return {steps};
}
const page={schemaVersion:1,agent:'codex',view:'active_branch',nextOffset:0,hasMore:false,messages:[
  {id:'p',role:'user',blocks:[{type:'text',text:'Say hello'}]},
  {id:'a',role:'assistant',blocks:[{type:'text',text:'Hello from the new agent'}]},
]};

/** The real Agent view over a recorded synthetic bridge for one multiplexer: starting an agent makes the next reads report it where the terminal is. */
export function mountAgentLauncher(kind:Kind) {
  const calls:{command:string;args:Record<string,unknown>}[]=[];
  const terminal={shown:0};
  let launched:{directory:string}|undefined;
  const pane={tmux:'%7',zellij:'zellij:main:4',herdr:'wNEW:p1'}[kind];
  const row=()=>({sessionId:'codex-new',agent:'Codex',project:launched!.directory,state:'working',updatedAt:new Date().toISOString(),summary:'Working',paneId:pane,eventCount:1});
  const herdrTree=()=>launched&&calls.some(call=>call.command==='herdr_action')?{
    workspaces:[{workspace_id:'w2E',label:'Work',focused:false,agent_status:'idle'},{workspace_id:'wNEW',label:'new',focused:true,agent_status:'working'}],
    tabs:[{tab_id:'w2E:tC',workspace_id:'w2E',label:'Code',number:1,focused:false,agent_status:'idle'},{tab_id:'wNEW:t1',workspace_id:'wNEW',label:'1',number:1,focused:true,agent_status:'working'}],
    panes:[{...herdrNavigationTree.panes[0],focused:false,agent_status:'idle'},{pane_id:pane,terminal_id:'term-new',workspace_id:'wNEW',tab_id:'wNEW:t1',cwd:launched.directory,focused:true,agent_status:'working'}],
    agents:[{terminal_id:'term-new',name:'codex-new',agent:'codex',workspace_id:'wNEW',tab_id:'wNEW:t1',pane_id:pane,agent_status:'working',agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'session-new'}}],
  }:{...herdrNavigationTree,agents:[],panes:herdrNavigationTree.panes.map(item=>({...item,agent_status:'idle'}))};
  applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,reason:'Synthetic launcher authority',generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),nonce:'e'.repeat(64)});acknowledgeAccessReady(accessSnapshot().epoch);
  Object.defineProperty(window,'__TAURI_INTERNALS__',{configurable:true,value:{invoke:async(command:string,args:Record<string,unknown>)=>{
    calls.push({command,args});
    const request=args.request as Request|undefined;
    switch(command) {
      case 'multiplexer_sessions':return [{name:'default'}];
      case 'herdr_tree':return herdrTree();
      case 'herdr_action':return {};
      case 'agent_snapshot':return {schemaVersion:1,sessions:launched&&kind!=='herdr'?[row()]:[]};
      case 'tmux_chat':{
        const reply=await tmuxChatReply(command,args) as Record<string,unknown>;
        const destination={...tmuxChatSnapshot.destination,paneId:launched?pane:'%3'};
        return reply.kind==='destination'?{...tmuxChatSnapshot,destination}:reply.kind==='bound'?{...tmuxChatBound,destination}:reply;
      }
      case 'agent_reported_history':return {schemaVersion:1,sessionId:'codex-new',status:'available',path:'/home/owner/.codex/sessions/new.jsonl',reportedAt:'2026-11-14T10:00:00Z',paneId:pane};
      case 'agent_transcript':case 'agent_herdr_conversation':return page;
      case 'list_directory':return args.path==='/'?[{name:'srv',isDir:true,size:0}]:[];
      case 'herdr_repository':return {root:'/srv/app',main:'/srv/app',head:'main',detached:false,worktrees:['/srv/app']};
      case 'herdr_agent_kinds':return [{kind:'codex',label:'Codex',executable:'codex',prompt:true,installed:true},{kind:'claude',label:'Claude Code',executable:'claude',prompt:true,installed:false},{kind:'opencode',label:'OpenCode',executable:'opencode',prompt:false,installed:true}];
      case 'multiplexer_launch_plan':case 'herdr_workspace_plan':return plan(kind,request!);
      case 'multiplexer_launch':case 'herdr_workspace_create':{
        const target=request!.target;
        launched={directory:String(target.type==='worktree'?target.path:target.directory)};
        return kind==='herdr'?{workspaceId:'wNEW',paneId:pane}:{paneId:kind==='tmux'?pane:'terminal_4',...(target.type==='worktree'?{worktree:launched.directory}:{}),...(target.create?{folder:launched.directory}:{})};
      }
      default:throw new Error(`Unexpected launcher fixture command: ${command}`);
    }
  }}});
  const host=document.createElement('section');
  Object.assign(host.style,{position:'fixed',inset:'0',display:'grid',zIndex:'20',background:'var(--background)'});
  document.body.append(host);
  const root=createRoot(host);
  root.render(<AgentView sessionId="launcher-host" shown tmux={kind==='tmux'} tmuxSession={kind==='tmux'?session.tmux:undefined} zellijSession={kind==='zellij'?session.zellij:undefined}
    herdrSession={kind==='herdr'?session.herdr:undefined} herdrLaunch={kind==='herdr'} onEnterHerdr={async()=>{}} onShowTerminal={()=>{terminal.shown++;}}/>);
  return {calls,terminal,dispose(){root.unmount();host.remove();}};
}

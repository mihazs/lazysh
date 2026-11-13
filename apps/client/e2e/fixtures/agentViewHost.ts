import {expect,type Locator,type Page} from '@playwright/test';
import {installNativeBridge} from './nativeBridge';
import {tmuxChatBound,tmuxChatSnapshot} from '../../src/test/tmuxChat';

export type AgentViewOptions={
  agent?:'claude'|'codex';
  messages:unknown[];
  state?:'working'|'needs_attention'|'done';
  /** The `session` object of the page: model, mode, context and where the agent works. */
  session?:Record<string,unknown>;
  /** The app theme preference: `forest` (default, dark), `midnight` (dark) or `paper` (light). */
  theme?:'forest'|'midnight'|'paper';
  /** What the recorded turn says the agent is doing; `working` makes the last call of the turn a running one. */
  activity?:'working'|'waiting'|'idle';
  /** Sub-agents, background commands and monitors of the conversation. */
  work?:unknown[];
  /** Messages the agent has not taken yet. */
  queued?:{text:string;timestamp?:string}[];
};
declare global {interface Window {agentViewDesign:{inputs:{kind:string}[]}}}
const transcript='/home/owner/.claude/projects/-work/design.jsonl';

/** The real app on a synthetic host: one tmux terminal whose pane a hook report ties to a recorded conversation, shown in the Agent view. */
export async function openAgentView(page:Page,options:AgentViewOptions):Promise<Locator> {
  await installNativeBridge(page);
  await page.addInitScript(({snapshot,bound,transcript,options})=>{
    const claude=(options.agent??'claude')==='claude';
    window.agentViewDesign={inputs:[]};
    let connections=0;
    // Keep the top bar so the same header shows on a phone and on the desktop project.
    localStorage.setItem('lazysh.show-top-bar.v1','true');
    if(options.theme)localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,appTheme:options.theme}));
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture',attached:{kind:'tmux',name:'work'}}]));
    window.nativeFixtureInvoke=async(command,args)=>{
      switch(command) {
        case 'list_hosts':return [{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}];
        case 'local_capability':case 'apple_status_capability':return {available:false,reason:'Synthetic Agent view fixture.'};
        case 'transport_capabilities':return {mosh:false,et:false};
        case 'has_credentials':return false;
        case 'connect':return {sessionId:`ssh-${++connections}`};
        case 'attach_tmux':{
          const session=`display-${String(args.name)}`,events=args.events as {onmessage:(event:unknown)=>void};
          setTimeout(()=>events.onmessage({type:'data',data:[...new TextEncoder().encode('$ claude\r\n')]}));
          return {sessionId:session};
        }
        case 'tmux_chat':{
          const action=args.action as {kind:string;operation?:number;input?:{kind:string}};
          window.agentViewDesign.inputs.push(action);
          if(action.kind==='snapshot')return {...snapshot,destination:{...snapshot.destination,paneId:'%3'}};
          if(action.kind==='bind')return bound;
          if(action.kind==='release')return {kind:'released'};
          return {kind:'delivered',nextOperation:action.operation!+1};
        }
        case 'agent_snapshot':return {schemaVersion:1,sessions:[{sessionId:'design-thread',agent:claude?'Claude Code':'Codex',project:'/work/lazysh',state:options.state??'working',updatedAt:new Date().toISOString(),summary:'Working on your prompt',paneId:'%3',eventCount:4}]};
        case 'agent_reported_history':return {schemaVersion:1,sessionId:'design-thread',status:'available',path:transcript,reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'};
        case 'agent_transcript':return {schemaVersion:1,agent:claude?'claude':'codex',view:'active_branch',nextOffset:0,hasMore:false,session:options.session,...(options.activity?{activity:options.activity}:{}),...(options.work?{work:options.work}:{}),...(options.queued?.length?{queued:options.queued}:{}),messages:options.messages};
        case 'agent_approvals':return {schemaVersion:1,requests:[]};
        case 'agent_watch_start':{
          // The companion's live stream: it opens, then carries the whole recorded conversation.
          const events=args.events as {onmessage:(event:unknown)=>void},emit=(frame:unknown)=>events.onmessage({type:'frame',frame});
          setTimeout(()=>{emit({type:'hello',protocol:1,agent:claude?'claude':'codex'});emit({type:'snapshot',gen:1,seq:1,entries:options.messages.map(message=>({id:(message as {id:string}).id,rev:1,message})),...(options.work?{work:options.work}:{}),...(options.activity?{activity:options.activity}:{}),session:options.session});});
          return 'watch-1';
        }
        case 'multiplexer_tree':return {tmuxAvailable:true,herdrAvailable:false,zellijAvailable:false,tools:[{kind:'tmux',version:'3.4',support:'full',missing:[]}],sessions:[]};
        case 'resize':case 'ack_output':case 'disconnect':case 'cancel_credential_auth':case 'agent_watch_stop':return undefined;
        default:if(command.startsWith('plugin:event|'))return undefined;throw new Error(`Unexpected Agent view fixture command: ${command}`);
      }
    };
  },{snapshot:tmuxChatSnapshot,bound:tmuxChatBound,transcript,options});
  await page.goto('/');
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  // A phone has no tab strip: the restored session is the one shown.
  await page.getByRole('tab',{name:'Fixture / work',exact:true}).click({timeout:2000}).catch(()=>undefined);
  await page.getByRole('group',{name:'Session view',exact:true}).getByRole('button',{name:'Agent',exact:true}).click();
  const agent=page.getByRole('region',{name:'Agent view',exact:true}).and(page.locator(':visible'));
  await expect(agent.getByRole('region',{name:'Turn',exact:true}).first()).toBeVisible();
  return agent;
}

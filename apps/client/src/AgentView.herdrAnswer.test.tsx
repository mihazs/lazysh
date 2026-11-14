// @vitest-environment jsdom
import AgentView from './AgentView';
import {describe,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {herdrNavigationTree} from './test/herdrNavigation';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {advance,ask,calls,color,typeOwnAnswer,useAgentViewHarness} from './test/agentViewHarness';
import {herdrBound,herdrChatReply,herdrPrepared,herdrTarget} from './test/herdrChat';
import {dialogScreen,modelScreen,onTmux} from './test/agentDialogScreens';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

const SESSION='00000001-0000-4000-8000-000000000000';
useAgentViewHarness();

const request=(id:string,sessionId=SESSION)=>({id,expectedHash:'a'.repeat(64),agent:'claude',sessionId,project:'/work',paneId:null,toolName:'Bash',toolInput:{command:`run ${id}`},options:[],createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300_000).toISOString()});
type Host={pane:string;requests:unknown[];messages:unknown[];waiting:boolean;guard:boolean;session:string;decided:unknown[];agent:'claude'|'codex';status:string;screen:string[];summary?:string;press?:(input:{kind:string;rows?:number;enter?:boolean})=>void};
/** The focused Herdr pane runs Claude Code `SESSION`; `pane` is where Herdr says that session runs now, `waiting` what the companion's report of it says. */
function herdr(host:Partial<Host>={}) {
  const state:Host={pane:'w2E:pF',requests:[],messages:[{id:'p',role:'user',blocks:[{type:'text',text:'Hello'}]}],waiting:true,guard:false,session:SESSION,decided:[],agent:'claude',status:'idle',screen:[],...host};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'owned'}];
    if(command==='herdr_tree'){
      const agent={...herdrNavigationTree.agents[0],pane_id:state.pane,agent:state.agent,agent_status:state.status,agent_session:{source:`herdr:${state.agent}`,agent:state.agent,kind:'id',value:state.session}};
      return {...herdrNavigationTree,agents:[agent]};
    }
    if(command==='agent_herdr_conversation')return {schemaVersion:1,agent:state.agent,view:'active_branch',messages:state.messages,nextOffset:0,hasMore:false,activity:'waiting'};
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:[{sessionId:SESSION,agent:state.agent==='claude'?'Claude Code':'Codex',project:'/work',state:state.waiting?'needs_attention':'working',updatedAt:new Date().toISOString(),summary:state.summary??'Answer requested',paneId:null,eventCount:3}]};
    if(command==='agent_approvals')return {schemaVersion:1,requests:state.requests};
    if(command==='resolve_agent_approval'){state.decided.push(args);return {schemaVersion:1,accepted:true};}
    // The guard is the same one the composer binds to; a stock host has none.
    if(command==='herdr_chat'){const reply=await herdrChatReply(command,args) as {kind:string};
      return !state.guard?(reply.kind==='status'?{kind:'status',available:false}:Promise.reject({kind:'herdr_chat_unavailable',message:'no guard'})):reply.kind==='prepared'?{...herdrPrepared,destination:{...herdrTarget,pane:state.pane,terminal:'term-one'}}:reply.kind==='bound'?{...herdrBound,destination:{...herdrTarget,pane:state.pane,terminal:'term-one'}}:reply;}
    if(command==='herdr_agent_screen')return state.screen;
    if(command==='herdr_agent_input'){state.press?.((args as {input:{kind:string}}).input);return undefined;}
    throw new Error(`Unexpected ${command}`);
  });
  return state;
}
const mount=async()=>{render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" terminalInput={{backend:'herdr',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);await advance(0);await advance(0);};
const keys=()=>calls('herdr_agent_input').map(args=>(args as {input:object}).input);

describe('permission requests of the agent followed in a Herdr pane',()=>{
  const dock=()=>screen.getByRole('region',{name:'Pending approvals'});
  it('shows only this agent\'s requests, though its hook has no tmux pane, and sends the hook decision once without a key',async()=>{
    herdr({requests:[request('11111111-1111-4111-8111-111111111111'),request('22222222-2222-4222-8222-222222222222','another-session')]});
    await mount();
    expect(within(dock()).getAllByRole('article')).toHaveLength(1);expect(dock().textContent).toContain('run 11111111');expect(dock().textContent).not.toContain('run 22222222');
    const deny=within(dock()).getByRole('button',{name:'Deny request'});
    fireEvent.click(deny);expect(calls('resolve_agent_approval')).toEqual([]);
    await advance(400);
    await act(async()=>{fireEvent.click(deny);await vi.advanceTimersByTimeAsync(0);});
    expect(calls('resolve_agent_approval')).toEqual([{sessionId:'ssh',id:'11111111-1111-4111-8111-111111111111',expectedHash:'a'.repeat(64),agentSessionId:SESSION,paneId:null,decision:'deny'}]);
    expect(keys()).toEqual([]);
  });
  it('sends nothing once Herdr no longer shows that session in this pane',async()=>{
    const host=herdr({requests:[request('11111111-1111-4111-8111-111111111111')]});
    await mount();await advance(400);
    host.session='another-session';
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Allow this request'}));await vi.advanceTimersByTimeAsync(0);});
    expect(calls('resolve_agent_approval')).toEqual([]);expect(within(dock()).getByRole('alert')).toBeTruthy();
  });
  it('is not offered for an agent the person picked from the list, which has no input authority',async()=>{
    herdr({requests:[request('11111111-1111-4111-8111-111111111111')]});
    await mount();
    fireEvent.click(screen.getByRole('button',{name:'Agent view options'}));fireEvent.click(screen.getByRole('button',{name:'Choose another agent'}));await advance(0);
    fireEvent.click(within(screen.getByRole('region',{name:'Live Herdr agents'})).getAllByRole('button',{name:/Open conversation/})[0]);await advance(0);await advance(400);
    expect(screen.queryByRole('region',{name:'Pending approvals'})).toBeNull();
  });
});

describe('the open question of the agent followed in a Herdr pane',()=>{
  const card=()=>screen.getByRole('region',{name:'Question'});
  const click=async(name:string)=>{await act(async()=>{fireEvent.click(within(card()).getByRole('button',{name}));await vi.advanceTimersByTimeAsync(0);});};
  it.each([['stock',false],['guarded',true]])('sends the digit of the chosen option once through Herdr\'s own agent input on a %s host',async(_,guard)=>{
    herdr({guard,messages:ask([color])});
    await mount();await advance(400);
    await click('Blue');await click('Blue');
    expect(keys()).toEqual([{kind:'select',option:2,of:2}]);
    expect(calls('herdr_agent_input')[0]).toMatchObject({target:{herdrSession:'owned',pane:'w2E:pF',terminal:'term-one',agent:'claude',agentSessionId:SESSION}});
    // On a guarded host the guard carried no dialog key.
    expect(calls('herdr_chat').filter(args=>(args as {action:{kind:string}}).action.kind==='input')).toEqual([]);
    expect(within(card()).getByRole('status').textContent).toContain('Sent to the terminal');
  });
  it('picks the free-text row and types the line as one literal write, which Herdr\'s prompt would refuse for a waiting agent',async()=>{
    herdr({messages:ask([color])});
    await mount();await advance(400);
    await typeOwnAnswer(card(),'Green',click);
    expect(keys()).toEqual([{kind:'select',option:3,of:3},{kind:'type',text:'Green'}]);
    expect(keys().some(key=>(key as {kind:string}).kind==='send')).toBe(false);
  });
  it('confirms a multi-select list with the Submit row and then the review page',async()=>{
    herdr({messages:ask([{question:'Pick fruits',multiple:true,options:[{label:'Apple'},{label:'Pear'}]}])});
    await mount();await advance(400);
    fireEvent.click(within(card()).getByLabelText('Pear'));
    await act(async()=>{fireEvent.click(within(card()).getByRole('button',{name:'Send answer'}));await vi.advanceTimersByTimeAsync(800);});
    expect(keys()).toEqual([{kind:'select',option:2,of:2},{kind:'submit',of:2},{kind:'select',option:1,of:2}]);
  });
  it.each([['the report says the agent no longer waits',(host:Host)=>{host.waiting=false;}],['Herdr shows another session in the pane',(host:Host)=>{host.session='another-session';}]])('sends nothing when %s',async(_,change)=>{
    const host=herdr({messages:ask([color])});
    await mount();await advance(400);
    change(host);await click('Red');
    expect(keys()).toEqual([]);expect(within(card()).getByRole('alert').textContent).toContain('not sent');
  });
});

describe('a dialog open on the pane of the agent followed in Herdr',()=>{
  const dialog=()=>screen.getByRole('region',{name:'Dialog in the terminal'});
  const pressed=()=>calls('herdr_agent_input').map(args=>(args as {input:object}).input);
  /** The picker draws its highlight where the arrows put it and closes on Enter, as the TUI does. */
  const picker=(host:Host,at:number)=>{let ahead=0;host.screen=modelScreen(at);host.press=input=>{if(input.enter)host.screen=dialogScreen('model-closed');else{ahead+=input.rows!;host.screen=modelScreen(at+ahead);}};};
  const settle=async()=>{await mount();await advance(3000);await advance(400);};
  it('answers the /model picker with the arrows and Enter a person presses, through Herdr\'s own agent input, once',async()=>{
    const host=herdr();picker(host,5);
    await settle();
    expect(within(dialog()).getByRole('heading',{name:'Select model'})).toBeTruthy();
    await act(async()=>{fireEvent.click(within(dialog()).getByRole('button',{name:/^Fable/}));await vi.advanceTimersByTimeAsync(3000);});
    expect(pressed()).toEqual([{kind:'pick',rows:-2,enter:false},{kind:'pick',rows:0,enter:true}]);
    expect(calls('herdr_agent_input')[0]).toMatchObject({target:{herdrSession:'owned',pane:'w2E:pF',terminal:'term-one',agent:'claude',agentSessionId:SESSION}});
    expect(screen.queryByRole('region',{name:'Dialog in the terminal'})).toBeNull();
    // No tmux pane was involved, and Herdr's tree was read again before the keys.
    expect(calls('tmux_chat')).toEqual([]);expect(calls('herdr_tree').length).toBeGreaterThan(2);
  });
  it('answers a Codex approval prompt through the same card',async()=>{
    herdr({agent:'codex',status:'blocked',screen:onTmux(dialogScreen('codex-approval'))});
    await settle();
    expect(within(dialog()).getByRole('heading',{name:'Would you like to run the following command?'})).toBeTruthy();
    expect(within(dialog()).getByRole('button',{name:/^No, and tell Codex/})).toBeTruthy();
    expect(pressed()).toEqual([]);
  });
  it('does not read the screen while the agent is working, and reads it again when it stops',async()=>{
    const host=herdr({status:'working',screen:modelScreen(5)});
    await settle();
    expect(calls('herdr_agent_screen')).toEqual([]);expect(screen.queryByRole('region',{name:'Dialog in the terminal'})).toBeNull();
    host.status='idle';await advance(3000);await advance(3000);
    expect(within(dialog()).getByRole('heading',{name:'Select model'})).toBeTruthy();
  });
  it('says the agent waits in the terminal for a dialog it cannot read exactly, and sends no key',async()=>{
    herdr({waiting:false,screen:dialogScreen('permissions-tabs')});
    await settle();
    expect(within(dialog()).getByRole('status').textContent).toBe('The agent is waiting for you in the terminal.');
    expect(pressed()).toEqual([]);
  });
  it('leaves a permission prompt to the approval card, which the companion\'s report names',async()=>{
    herdr({status:'blocked',summary:'Permission requested',requests:[request('11111111-1111-4111-8111-111111111111')],screen:dialogScreen('permission')});
    await settle();
    expect(screen.queryByRole('region',{name:'Dialog in the terminal'})).toBeNull();expect(screen.getByRole('region',{name:'Pending approvals'})).toBeTruthy();
  });
  it('sends nothing when the pane no longer shows the dialog that was tapped',async()=>{
    const host=herdr({screen:modelScreen(5)});
    await settle();
    host.screen=dialogScreen('model-closed');
    await act(async()=>{fireEvent.click(within(dialog()).getByRole('button',{name:/^Fable/}));await vi.advanceTimersByTimeAsync(3000);});
    expect(pressed()).toEqual([]);
  });
});

describe('what a blocked agent followed in Herdr waits for',()=>{
  const header=()=>screen.getByRole('region',{name:'Agent view'}).querySelector('header')!;
  it('is named in the header from the companion report, with how long it has waited, where Herdr says only Needs attention',async()=>{
    herdr({status:'blocked',summary:'Permission requested'});
    await mount();
    expect(header().textContent).toContain('Waiting for your approval · ');expect(header().textContent).not.toContain('Needs attention');
  });
  it('keeps Herdr\'s own word when no report names the wait, and for an agent that is not blocked',async()=>{
    herdr({status:'blocked',waiting:false});
    await mount();
    expect(header().textContent).toContain('Needs attention');
    cleanup();herdr({status:'idle',summary:'Permission requested'});
    await mount();
    expect(header().textContent).not.toContain('Waiting for your approval');
  });
});

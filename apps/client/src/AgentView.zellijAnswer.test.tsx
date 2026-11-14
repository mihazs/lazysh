// @vitest-environment jsdom
import AgentView from './AgentView';
import {describe,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {advance,ask,calls,color,typeOwnAnswer,useAgentViewHarness} from './test/agentViewHarness';
import {dialogScreen,modelScreen,onTmux} from './test/agentDialogScreens';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

useAgentViewHarness();

type Host={agent:'Claude Code'|'Codex';state:string;paneId:string;messages:unknown[];screen:string[];press?:(input:{kind:string;rows?:number;enter?:boolean})=>void;listed:number};
/** The agent in Zellij pane 7 of the session `work` reports `needs_attention`; `screen` is what the host reads from that pane's viewport. */
function zellij(host:Partial<Host>={}) {
  const state:Host={agent:'Claude Code',state:'needs_attention',paneId:'zellij:work:7',messages:[{id:'p',role:'user',blocks:[{type:'text',text:'Hello'}]}],screen:[],listed:0,...host};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:[{sessionId:'the-session',agent:state.agent,project:'/work',state:state.state,updatedAt:new Date().toISOString(),summary:'Waiting',paneId:state.paneId,eventCount:3}]};
    if(command==='agent_reported_history')return {schemaVersion:1,sessionId:'the-session',status:'available',path:'/home/owner/a.jsonl',reportedAt:'2026-11-09T10:00:00Z',paneId:state.paneId};
    if(command==='agent_transcript')return {schemaVersion:1,agent:state.agent==='Codex'?'codex':'claude',view:'active_branch',messages:state.messages,nextOffset:0,hasMore:false,activity:'waiting'};
    if(command==='zellij_agent_screen')return state.screen;
    if(command==='zellij_agent_input'){state.press?.((args as {input:{kind:string}}).input);return null;}
    throw new Error(`Unexpected ${command}`);
  });
  return state;
}
const mount=async()=>{render(<AgentView sessionId="ssh" shown tmux={false} zellijSession="work" terminalInput={{backend:'zellij',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);await advance(0);await advance(0);};
const keys=()=>calls('zellij_agent_input').map(args=>(args as {input:object}).input);
const target=(agent:'claude'|'codex')=>({zellijSession:'work',pane:7,agent});

describe('a dialog open in the pane of the agent followed in Zellij',()=>{
  const dialog=()=>screen.getByRole('region',{name:'Dialog in the terminal'});
  /** The picker draws its highlight where the arrows put it and closes on Enter, as the TUI does. */
  const picker=(host:Host,at:number)=>{let ahead=0;host.screen=modelScreen(at);host.press=input=>{if(input.enter)host.screen=dialogScreen('model-closed');else{ahead+=input.rows!;host.screen=modelScreen(at+ahead);}};};
  const settle=async()=>{await mount();await advance(3000);await advance(400);};
  it('answers the /model picker with the arrows and Enter a person presses, once, to the pane the report names and never through tmux',async()=>{
    const host=zellij({state:'done'});picker(host,5);
    await settle();
    expect(within(dialog()).getByRole('heading',{name:'Select model'})).toBeTruthy();
    await act(async()=>{fireEvent.click(within(dialog()).getByRole('button',{name:/^Fable/}));await vi.advanceTimersByTimeAsync(3000);});
    expect(keys()).toEqual([{kind:'pick',rows:-2,enter:false},{kind:'pick',rows:0,enter:true}]);
    expect(calls('zellij_agent_input')[0]).toMatchObject({sessionId:'ssh',target:target('claude')});
    expect(calls('zellij_agent_screen')[0]).toEqual({sessionId:'ssh',target:target('claude')});
    expect(screen.queryByRole('region',{name:'Dialog in the terminal'})).toBeNull();
    expect(calls('tmux_chat')).toEqual([]);
  });
  it('answers a Codex approval prompt through the same card, to the Codex pane', async()=>{
    const host=zellij({agent:'Codex',state:'done'});
    host.screen=onTmux(dialogScreen('codex-approval'));
    host.press=input=>{if(input.enter)host.screen=onTmux([]);};
    await settle();
    expect(within(dialog()).getByRole('heading',{name:'Would you like to run the following command?'})).toBeTruthy();
    await act(async()=>{fireEvent.click(within(dialog()).getByRole('button',{name:/^Yes, proceed/}));await vi.advanceTimersByTimeAsync(3000);});
    expect(keys()).toEqual([{kind:'pick',rows:0,enter:true}]);
    expect(calls('zellij_agent_input')[0]).toMatchObject({target:target('codex')});
  });
  it('does not read the pane while the agent is working, and reads it when it stops',async()=>{
    const host=zellij({state:'working',screen:modelScreen(5)});
    await settle();
    expect(calls('zellij_agent_screen')).toEqual([]);expect(screen.queryByRole('region',{name:'Dialog in the terminal'})).toBeNull();
    host.state='done';await advance(5000);await advance(3000);
    expect(within(dialog()).getByRole('heading',{name:'Select model'})).toBeTruthy();
  });
  it('says the agent waits in the terminal for a dialog it cannot read exactly, and sends no key',async()=>{
    zellij({state:'done',screen:dialogScreen('permissions-tabs')});
    await settle();
    expect(within(dialog()).getByRole('status').textContent).toBe('The agent is waiting for you in the terminal.');
    expect(keys()).toEqual([]);
  });
  it('sends nothing when the report no longer names this pane, though the screen still shows the dialog',async()=>{
    const host=zellij({state:'done',screen:modelScreen(5)});
    await settle();
    host.paneId='zellij:work:9';
    await act(async()=>{fireEvent.click(within(dialog()).getByRole('button',{name:/^Fable/}));await vi.advanceTimersByTimeAsync(3000);});
    expect(keys()).toEqual([]);
  });
});

describe('the open question of the agent followed in Zellij',()=>{
  const card=()=>screen.getByRole('region',{name:'Question'});
  const click=async(name:string)=>{await act(async()=>{fireEvent.click(within(card()).getByRole('button',{name}));await vi.advanceTimersByTimeAsync(0);});};
  it('sends the digit of the chosen option once through Zellij\'s own pane input',async()=>{
    zellij({messages:ask([color])});
    await mount();await advance(400);
    await click('Blue');await click('Blue');
    expect(keys()).toEqual([{kind:'select',option:2,of:2}]);
    expect(calls('zellij_agent_input')[0]).toMatchObject({target:target('claude')});
    expect(calls('tmux_chat')).toEqual([]);
    expect(within(card()).getByRole('status').textContent).toContain('Sent to the terminal');
  });
  it('types a free-text answer as one line and its Enter after picking the free-text row',async()=>{
    zellij({messages:ask([color])});
    await mount();await advance(400);
    await typeOwnAnswer(card(),'Green',click);
    expect(keys()).toEqual([{kind:'select',option:3,of:3},{kind:'type',text:'Green'}]);
  });
  it('sends nothing when the report says the agent no longer waits',async()=>{
    const host=zellij({messages:ask([color])});
    await mount();await advance(400);
    host.state='working';await click('Red');
    expect(keys()).toEqual([]);expect(within(card()).getByRole('alert').textContent).toContain('not sent');
  });
});

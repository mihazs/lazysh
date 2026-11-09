// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AgentView from './AgentView';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {tmuxChatReply} from './test/tmuxChat';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

const row=(agent:string,paneId:string|null,state='working')=>({sessionId:`${agent}-session`,agent,project:'/work',state,updatedAt:new Date().toISOString(),summary:'Working',paneId,eventCount:3});
const turn=(prompt:string,answer:string)=>[
  {id:`${prompt}-prompt`,role:'user',blocks:[{type:'text',text:prompt}]},
  {id:`${prompt}-tool`,role:'assistant',blocks:[{type:'tool_use',name:'Bash',text:'ls'}]},
  {id:`${prompt}-result`,role:'tool',blocks:[{type:'tool_result',text:'README.md'}]},
  {id:`${prompt}-answer`,role:'assistant',blocks:[{type:'text',text:answer}]},
];
const page=(agent:string,messages:unknown[])=>({schemaVersion:1,agent,view:'active_branch',messages,nextOffset:0,hasMore:false});
function host(agent:string,rows:unknown[],history:'available'|'missing',pages:unknown[][]) {
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='tmux_chat')return tmuxChatReply(command,args);
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:rows};
    if(command==='agent_reported_history'){const id=(args as {agentSessionId:string}).agentSessionId;return history==='available'?{schemaVersion:1,sessionId:id,status:'available',path:`/home/owner/${agent} 世界.jsonl`,reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'}:{schemaVersion:1,sessionId:id,status:'missing'};}
    if(command==='agent_transcript')return page(agent,pages.length>1?pages.shift()!:pages[0]);
    throw new Error(`Unexpected ${command}`);
  });
}
const calls=(name:string)=>vi.mocked(invoke).mock.calls.filter(([command])=>command===name).map(([,args])=>args);
const advance=async(ms:number)=>{await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});};
beforeEach(()=>{vi.useFakeTimers();vi.mocked(invoke).mockReset();access();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});});
afterEach(()=>{cleanup();vi.useRealTimers();});

describe.each([['Claude Code','claude'],['Codex','codex']] as const)('%s pane',(label,agent)=>{
  it('binds from the hook report of this pane and follows new turns typed in the terminal',async()=>{
    host(agent,[row('Other',null),row(label,'%3')],'available',[turn('First prompt','First answer'),[...turn('First prompt','First answer'),...turn('Typed in the terminal','Second answer')]]);
    render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
    await advance(0);
    const header=screen.getByRole('region',{name:'Agent view'}).querySelector('header')!;
    expect(within(header).getByText(label)).toBeTruthy();expect(within(header).getByText('Working')).toBeTruthy();
    expect(calls('agent_transcript')).toEqual([{sessionId:'ssh',agent,path:`/home/owner/${agent} 世界.jsonl`,view:'conversation',offset:0}]);
    const turns=screen.getAllByRole('region',{name:'Turn'});
    expect(turns).toHaveLength(1);
    expect(within(turns[0]).getByText('First prompt')).toBeTruthy();expect(within(turns[0]).getByText('First answer')).toBeTruthy();
    // Tool work folds into one activity row between prompt and answer.
    const activity=turns[0].querySelector('details.agent-turn-activity')!;
    expect(activity.hasAttribute('open')).toBe(false);expect(activity.querySelector('summary')!.textContent).toBe('Activity (2)');
    expect(screen.queryByLabelText('Transcript path')).toBeNull();
    await advance(2000);
    expect(screen.getAllByRole('region',{name:'Turn'})).toHaveLength(2);
    expect(screen.getByText('Typed in the terminal')).toBeTruthy();expect(screen.getByText('Second answer')).toBeTruthy();
    expect(calls('tmux_chat')).toEqual(expect.arrayContaining([expect.objectContaining({action:{kind:'snapshot'}})]));
    expect(calls('tmux_chat').every(args=>(args as {action:{kind:string}}).action.kind==='snapshot')).toBe(true);
  });
});

it('shows the fallback with Show terminal and Choose transcript when no hook report names this pane',async()=>{
  host('codex',[row('Codex','%9')],'available',[[]]);
  const showTerminal=vi.fn();
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={showTerminal}/>);
  await advance(0);
  expect(screen.getByText('No agent conversation for this terminal.')).toBeTruthy();
  expect(calls('agent_reported_history')).toEqual([]);expect(calls('agent_transcript')).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Show terminal'}));expect(showTerminal).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Choose transcript'}));
  expect(screen.getByLabelText('Transcript path')).toBeTruthy();
  expect(screen.getByText('You chose this transcript. It is not proven to belong to the agent in this terminal.')).toBeTruthy();
});

it('labels a detected agent without a reported conversation as partial and never reads a transcript',async()=>{
  host('codex',[row('Codex','%3','needs_attention')],'missing',[[]]);
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/^Codex reports its state here, but its conversation is not available/)).toBeTruthy();
  expect(screen.getByText('Attention')).toBeTruthy();
  expect(calls('agent_transcript')).toEqual([]);
});

it('offers only the fallback for terminals without pane identity and reads nothing while hidden',async()=>{
  host('codex',[row('Codex','%3')],'available',[[]]);
  const view=render(<AgentView sessionId="ssh" shown={false} tmux onShowTerminal={()=>{}}/>);
  await advance(10_000);expect(invoke).not.toHaveBeenCalled();
  view.rerender(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText('No agent conversation for this terminal.')).toBeTruthy();
  expect(invoke).not.toHaveBeenCalled();
});

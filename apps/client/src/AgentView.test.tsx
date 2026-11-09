// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AgentView from './AgentView';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {tmuxChatReply} from './test/tmuxChat';
vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

const row=(agent:string,paneId:string|null,state='working')=>({sessionId:`${agent}-session`,agent,project:'/work',state,updatedAt:new Date().toISOString(),summary:'Working',paneId,eventCount:3});
// Each turn starts 72 s before its answer and does one command, one edit and one failed tool call.
const turn=(prompt:string,answer:string,start=Date.now()-72_000)=>[
  {id:`${prompt}-prompt`,role:'user',timestamp:new Date(start).toISOString(),blocks:[{type:'text',text:prompt}]},
  {id:`${prompt}-tool`,role:'assistant',blocks:[{type:'tool_use',id:'a',name:'Bash',text:'ls'},{type:'tool_use',id:'b',name:'Edit',text:'README.md'},{type:'tool_use',id:'c',name:'WebFetch',text:'https://example.invalid'}]},
  {id:`${prompt}-result`,role:'tool',blocks:[{type:'tool_result',id:'a',text:'README.md'},{type:'tool_result',id:'c',isError:true,text:'offline'}]},
  {id:`${prompt}-answer`,role:'assistant',timestamp:new Date(start+72_000).toISOString(),blocks:[{type:'text',text:answer}]},
];
const page=(agent:string,messages:unknown[])=>({schemaVersion:1,agent,view:'active_branch',messages,nextOffset:0,hasMore:false});
function host(agent:string,rows:unknown[],history:'available'|'missing'|('available'|'missing')[],pages:unknown[][]) {
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='tmux_chat')return tmuxChatReply(command,args);
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:rows};
    if(command==='agent_reported_history'){const id=(args as {agentSessionId:string}).agentSessionId;return (Array.isArray(history)?history.length>1?history.shift():history[0]:history)==='available'?{schemaVersion:1,sessionId:id,status:'available',path:`/home/owner/${agent} 世界.jsonl`,reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'}:{schemaVersion:1,sessionId:id,status:'missing'};}
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
    render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
    await advance(0);
    const header=screen.getByRole('region',{name:'Agent view'}).querySelector('header')!;
    expect(within(header).getByText(label)).toBeTruthy();expect(within(header).getByText('Working')).toBeTruthy();
    expect(calls('agent_transcript')).toEqual([{sessionId:'ssh',agent,path:`/home/owner/${agent} 世界.jsonl`,view:'conversation',offset:0}]);
    const turns=screen.getAllByRole('region',{name:'Turn'});
    expect(turns).toHaveLength(1);
    // Prompt and answer are bubbles named by role, without the recorded reader's role headings or follow controls.
    expect(within(within(turns[0]).getByRole('article',{name:'user'})).getByText('First prompt')).toBeTruthy();
    expect(within(within(turns[0]).getAllByRole('article',{name:'assistant'}).at(-1)!).getByText('First answer')).toBeTruthy();
    expect(screen.queryByRole('heading',{name:'user'})).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();
    // Tool work folds into one activity row that says what the agent did and how long the turn took.
    const activity=turns[0].querySelector('details.agent-turn-activity')!;
    expect(activity.hasAttribute('open')).toBe(false);expect(activity.querySelector('summary')!.textContent).toBe('Ran 1 command · Made 1 edit · Used 1 other tool · 1 failed · 1:12');
    expect(screen.queryByLabelText('Transcript path')).toBeNull();
    // The header counts the running turn from its prompt.
    expect(within(header).getByTitle('Time since this turn started').textContent).toMatch(/^1:1\d$/);
    // The composer starts as one line; the confirmed-input disclaimer waits behind the info button.
    expect(screen.getByRole('textbox',{name:'Draft for this terminal'}).getAttribute('rows')).toBe('1');
    const input=screen.getByRole('region',{name:'Terminal input'});
    expect(within(input).getByRole('button',{name:'Choose terminal destination'})).toBeTruthy();
    expect(within(input).queryByRole('heading')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'How staging works'}));
    expect(within(input).getByRole('heading',{name:'Terminal input'})).toBeTruthy();
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

it('binds on the next poll once a conversation missing at first is reported',async()=>{
  host('codex',[row('Codex','%3')],['missing','available'],[turn('First prompt','First answer')]);
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/^Codex reports its state here, but its conversation is not available/)).toBeTruthy();
  await advance(5000);await advance(0);
  expect(screen.queryByText(/^Codex reports its state here/)).toBeNull();
  expect(within(screen.getByRole('region',{name:'Turn'})).getByText('First answer')).toBeTruthy();
  expect(calls('agent_reported_history')).toHaveLength(2);
  // An available conversation is not asked for again.
  await advance(5000);
  expect(calls('agent_reported_history')).toHaveLength(2);
});

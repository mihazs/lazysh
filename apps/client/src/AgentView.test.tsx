// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AgentView from './AgentView';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {tmuxChatReply,tmuxChatSnapshot} from './test/tmuxChat';
import {herdrNavigationTree} from './test/herdrNavigation';
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
    expect(within(header).getByText(label)).toBeTruthy();expect(within(header).getByText('Last reported: Working')).toBeTruthy();
    const sessions=within(header).getByRole('button',{name:'Last-reported agent sessions'});
    expect(sessions.getAttribute('aria-expanded')).toBe('false');fireEvent.click(sessions);
    expect(screen.getByRole('region',{name:'Last-reported agent sessions'})).toBeTruthy();fireEvent.click(sessions);
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
    // A persisted report does not establish a currently running turn.
    expect(within(header).queryByTitle('Time since this turn started')).toBeNull();
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

it('shows the fallback without a transcript picker when no hook report names this pane',async()=>{
  host('codex',[row('Codex','%9')],'available',[[]]);
  const showTerminal=vi.fn();
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={showTerminal}/>);
  await advance(0);
  expect(screen.getByText('No agent conversation for this terminal.')).toBeTruthy();
  expect(calls('agent_reported_history')).toEqual([]);expect(calls('agent_transcript')).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Show terminal'}));expect(showTerminal).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button',{name:'Choose transcript'})).toBeNull();
});

it('labels a detected agent without a reported conversation as partial and never reads a transcript',async()=>{
  host('codex',[row('Codex','%3','needs_attention')],'missing',[[]]);
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/^The last Codex report names this pane, but its conversation is unavailable/)).toBeTruthy();
  expect(screen.getByText('Last reported: Attention')).toBeTruthy();
  expect(calls('agent_transcript')).toEqual([]);
});

it('keeps a detected tmux agent visible when its history lookup fails',async()=>{
  host('codex',[row('Codex','%3')],'missing',[[]]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='agent_reported_history'?Promise.reject(new Error('unavailable')):fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/^The last Codex report names this pane, but its conversation is unavailable/)).toBeTruthy();
});

it('does not bind history reported for another tmux pane',async()=>{
  host('codex',[row('Codex','%3')],'missing',[[]]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='agent_reported_history'?Promise.resolve({schemaVersion:1,sessionId:'Codex-session',status:'available',path:'/private/history',reportedAt:'2026-11-09T10:00:00Z',paneId:'%4'}):fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/^The last Codex report names this pane, but its conversation is unavailable/)).toBeTruthy();
  expect(calls('agent_transcript')).toEqual([]);
});

it('enters the exact selected Herdr pane without reading a conversation',async()=>{
  const first={...herdrNavigationTree.agents[0],agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'shared'}};
  const other={...first,agent:'claude',name:'other',pane_id:'w2E:pA',terminal_id:'term-two'};
  const duplicate={...first,name:'duplicate',pane_id:'w2E:pB',terminal_id:'term-three'};
  const tree={...herdrNavigationTree,agents:[first,other,duplicate],panes:[...herdrNavigationTree.panes,{...herdrNavigationTree.panes[0],pane_id:other.pane_id,terminal_id:other.terminal_id},{...herdrNavigationTree.panes[0],pane_id:duplicate.pane_id,terminal_id:duplicate.terminal_id}]};
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='multiplexer_sessions')return [{name:'owned'}];
    if(command==='herdr_tree')return tree;
    throw new Error('Companion unavailable');
  });
  const enter=vi.fn(async()=>{});
  const view=render(<AgentView sessionId="ssh" shown={false} tmux={false} herdrSession="owned" onEnterHerdr={enter} onShowTerminal={()=>{}}/>);
  await advance(5000);expect(invoke).not.toHaveBeenCalled();
  view.rerender(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onEnterHerdr={enter} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText('builder')).toBeTruthy();expect(screen.getByText('other')).toBeTruthy();
  expect(screen.getByLabelText('Herdr server')).toHaveProperty('disabled',true);
  expect(screen.queryByText('No agent conversation for this terminal.')).toBeNull();
  expect(calls('agent_reported_history')).toEqual([]);expect(calls('agent_transcript')).toEqual([]);
  expect(screen.queryByRole('button',{name:'Open conversation'})).toBeNull();
  fireEvent.click(within(screen.getByText('builder').closest('article')!).getByRole('button',{name:'Enter session'}));
  expect(enter).toHaveBeenCalledExactlyOnceWith('owned',{kind:'pane',workspace:'w2E',tab:'w2E:tC',pane:'w2E:pF',terminal:'term-one'},expect.anything(),expect.any(Function));
  expect(calls('agent_transcript')).toEqual([]);
});

it('opens a unique Herdr session through the revalidated host resolver without input authority',async()=>{
  const first={...herdrNavigationTree.agents[0],agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'session-one'}};
  let available=true;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='multiplexer_sessions')return [{name:'owned'}];
    if(command==='herdr_tree')return {...herdrNavigationTree,agents:[first]};
    if(command==='agent_herdr_conversation'){if(!available)throw new Error('Session unavailable');return page('codex',turn('Prompt','Verified answer'));}
    throw new Error('unavailable');
  });
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" terminalInput={{backend:'herdr',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(calls('agent_herdr_conversation')).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:'Open conversation'}));await advance(0);
  expect(screen.getByText('Herdr reports this session. Its association with this pane is unverified.')).toBeTruthy();
  expect(screen.getByText('Verified answer')).toBeTruthy();
  expect(calls('agent_herdr_conversation')).toEqual([{sessionId:'ssh',agent:'codex',agentSessionId:'session-one',herdrSession:'owned',paneId:'w2E:pF',terminalId:'term-one'}]);
  expect(calls('agent_transcript')).toEqual([]);expect(screen.queryByRole('region',{name:'Terminal input'})).toBeNull();
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  const draft=screen.getByRole('textbox',{name:'Draft for this terminal'});fireEvent.change(draft,{target:{value:'No target'}});
  expect(screen.queryByRole('button',{name:'Stage in terminal'})).toBeNull();fireEvent.keyDown(draft,{key:'Enter',metaKey:true});fireEvent.submit(draft.closest('form')!);
  expect(staged).not.toHaveBeenCalled();window.removeEventListener('lazysh-prompt-draft',staged);
  available=false;await advance(2000);expect(calls('agent_herdr_conversation')).toHaveLength(2);
  expect(screen.getByRole('alert').textContent).toContain('Session unavailable');
  expect(calls('agent_transcript')).toEqual([]);
});

it('hides Herdr metadata and prevents selection when access is revoked',async()=>{
  vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_sessions'?[{name:'owned'}]:herdrNavigationTree);
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onEnterHerdr={vi.fn()} onShowTerminal={()=>{}}/>);
  await advance(0);expect(screen.getByText('builder')).toBeTruthy();
  act(()=>access(true));
  expect(screen.queryByText('builder')).toBeNull();
  await advance(5000);
  expect(calls('agent_transcript')).toEqual([]);
});

it('lists reported sessions without pane identity and reads nothing while hidden',async()=>{
  host('codex',[row('Codex','%3')],'available',[[]]);
  const view=render(<AgentView sessionId="ssh" shown={false} tmux onShowTerminal={()=>{}}/>);
  await advance(10_000);expect(invoke).not.toHaveBeenCalled();
  view.rerender(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText('No agent conversation for this terminal.')).toBeTruthy();
  expect(calls('agent_snapshot')).toHaveLength(1);
  expect(calls('agent_transcript')).toEqual([]);
});

it('opens only the explicitly selected uniquely reported session and gives it no input authority',async()=>{
  host('codex',[row('Codex',null)],'available',[turn('First prompt','First answer')]);
  render(<AgentView sessionId="ssh" shown tmux={false} terminalInput={{backend:'herdr',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(calls('agent_transcript')).toEqual([]);
  fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));await advance(0);
  expect(screen.getByText('First answer')).toBeTruthy();
  expect(screen.queryByLabelText('Transcript path')).toBeNull();
  expect(screen.queryByRole('region',{name:'Terminal input'})).toBeNull();
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  const draft=screen.getByRole('textbox',{name:'Draft for this terminal'});
  fireEvent.change(draft,{target:{value:'Do not send to another pane'}});
  expect(screen.queryByRole('button',{name:'Stage in terminal'})).toBeNull();
  fireEvent.keyDown(draft,{key:'Enter',ctrlKey:true});fireEvent.submit(draft.closest('form')!);
  expect(staged).not.toHaveBeenCalled();window.removeEventListener('lazysh-prompt-draft',staged);
});

it('keeps a turn-completed reported session selectable and readable',async()=>{
  const rows=[row('Codex',null,'done')];host('codex',rows,'available',[turn('Idle prompt','Idle answer')]);
  render(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);expect(screen.getByText(/Last reported: Done/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));await advance(0);
  expect(screen.getByText('Idle answer')).toBeTruthy();
});

it('continues following a selected session after its turn reports done',async()=>{
  const rows=[row('Codex',null)];host('codex',rows,'available',[turn('First prompt','First answer'),turn('Next prompt','Next answer')]);
  render(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));await advance(0);
  rows[0].state='done';rows[0].summary='Turn finished';await advance(2000);
  expect(screen.getByText('Next answer')).toBeTruthy();
});

it.each(['gone','changed'] as const)('suspends a selected report when it is %s and keeps its draft',async change=>{
  const rows=[row('Codex',null)];
  host('codex',rows,'available',[turn('First prompt','First answer'),turn('Stale prompt','Stale answer')]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  let changed=false;
  vi.mocked(invoke).mockImplementation((command,args,options)=>changed && change==='changed' && command==='agent_reported_history'
    ? Promise.resolve({schemaVersion:1,sessionId:'Codex-session',status:'available',path:'/different',reportedAt:'2026-11-09T10:00:00Z',paneId:null}) : fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));await advance(0);
  fireEvent.change(screen.getByRole('textbox',{name:'Draft for this terminal'}),{target:{value:'Keep this draft'}});
  changed=true;if(change==='gone')rows.splice(0);
  await advance(2000);
  expect(calls('agent_transcript')).toHaveLength(1);expect(screen.queryByText('Stale answer')).toBeNull();
  expect(screen.getByRole('textbox',{name:'Draft for this terminal'})).toHaveProperty('value','Keep this draft');
  expect(screen.queryByRole('region',{name:'Terminal input'})).toBeNull();
});

it('discards a selected transcript response if its report disappears during the read',async()=>{
  const rows=[row('Codex',null)];host('codex',rows,'available',[[]]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;let finish!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='agent_transcript'
    ? new Promise(resolve=>{finish=resolve;}) : fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));await advance(0);
  rows.splice(0);await act(async()=>finish(page('codex',turn('Late prompt','Late answer'))));
  expect(screen.queryByText('Late answer')).toBeNull();expect(screen.queryByRole('region',{name:'Terminal input'})).toBeNull();
});

it('does not open a session with ambiguous IDs or missing history',async()=>{
  host('codex',[row('Codex',null),{...row('Claude Code',null),sessionId:'Codex-session'}],'available',[[]]);
  const view=render(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);expect(screen.queryByRole('region',{name:'Last-reported agent sessions'})).toBeNull();
  host('codex',[row('Codex',null)],'missing',[[]]);
  view.rerender(<AgentView key="other" sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));await advance(0);
  expect(screen.getByText(/This session's conversation is unavailable/)).toBeTruthy();
  expect(calls('agent_transcript')).toEqual([]);expect(screen.queryByLabelText('Transcript path')).toBeNull();
});

it('drops a pending session choice when the view is hidden',async()=>{
  host('codex',[row('Codex',null)],'available',[[]]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  let resolve!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='agent_reported_history'?new Promise(done=>{resolve=done;}):fallback(command,args,options));
  const props={sessionId:'ssh',tmux:false,onShowTerminal:()=>{}};
  const view=render(<AgentView {...props} shown/>);await advance(0);
  fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));
  view.rerender(<AgentView {...props} shown={false}/>);
  await act(async()=>resolve({schemaVersion:1,sessionId:'Codex-session',status:'available',path:'/private/history',reportedAt:'2026-11-09T10:00:00Z',paneId:null}));
  expect(calls('agent_transcript')).toEqual([]);
  view.rerender(<AgentView {...props} shown/>);await advance(0);
  expect(screen.getByRole('button',{name:/Codex · \/work/})).toHaveProperty('disabled',false);
});

it('does not let a late reported-history lookup replace a newer Herdr choice',async()=>{
  const first={...herdrNavigationTree.agents[0],agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'session-one'}};
  let resolve!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='agent_snapshot')return {schemaVersion:1,sessions:[row('Codex',null)]};
    if(command==='agent_reported_history')return new Promise(done=>{resolve=done;});
    if(command==='multiplexer_sessions')return [{name:'owned'}];
    if(command==='herdr_tree')return {...herdrNavigationTree,agents:[first]};
    if(command==='agent_herdr_conversation')return page('codex',turn('Prompt','Herdr answer'));
    throw new Error('Unexpected command');
  });
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onShowTerminal={()=>{}}/>);await advance(0);
  fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));
  fireEvent.click(screen.getByRole('button',{name:'Open conversation'}));await advance(0);
  await act(async()=>resolve({schemaVersion:1,sessionId:'Codex-session',status:'available',path:'/private/history',reportedAt:'2026-11-09T10:00:00Z',paneId:null}));
  expect(screen.getByText('Herdr answer')).toBeTruthy();expect(calls('agent_transcript')).toEqual([]);
});

it('binds on the next poll once a conversation missing at first is reported',async()=>{
  host('codex',[row('Codex','%3')],['missing','available'],[turn('First prompt','First answer')]);
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/^The last Codex report names this pane, but its conversation is unavailable/)).toBeTruthy();
  await advance(5000);await advance(0);
  expect(screen.queryByText(/^The last Codex report names this pane/)).toBeNull();
  expect(within(screen.getByRole('region',{name:'Turn'})).getByText('First answer')).toBeTruthy();
  const before=calls('agent_reported_history').length;
  // An available report is checked again because it can expire.
  await advance(5000);
  expect(calls('agent_reported_history').length).toBeGreaterThan(before);
});

it('suspends a stale tmux binding and restores its draft when history returns',async()=>{
  const next='/home/owner/new.jsonl';
  host('codex',[row('Codex','%3')],'available',[turn('First prompt','First answer')]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  let phase:'initial'|'missing'|'returned'='initial',reads=0;
  let finishOld!:(value:unknown)=>void;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='agent_transcript' && ++reads===2)return new Promise(resolve=>{finishOld=resolve;});
    if(command!=='agent_reported_history')return fallback(command,args,options);
    return Promise.resolve(phase==='missing'?{schemaVersion:1,sessionId:'Codex-session',status:'missing'}:
      {schemaVersion:1,sessionId:'Codex-session',status:'available',path:phase==='initial'?'/home/owner/codex 世界.jsonl':next,reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'});
  });
  render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);fireEvent.change(screen.getByRole('textbox',{name:'Draft for this terminal'}),{target:{value:'Keep this draft'}});
  await advance(2000);phase='missing';await advance(3000);
  expect(screen.getByText(/^The last Codex report names this pane, but its conversation is unavailable/)).toBeTruthy();
  expect(screen.queryByRole('region',{name:'Terminal input'})).toBeNull();
  await act(async()=>finishOld(page('codex',turn('Stale prompt','Stale answer'))));
  const count=calls('agent_transcript').length;await advance(2000);expect(calls('agent_transcript')).toHaveLength(count);
  phase='returned';await advance(3000);await advance(0);
  expect(screen.getByRole('textbox',{name:'Draft for this terminal'})).toHaveProperty('value','Keep this draft');
  expect(screen.queryByText('Stale answer')).toBeNull();
  expect(calls('agent_transcript').at(-1)).toMatchObject({sessionId:'ssh',agent:'codex',path:next});
  expect(calls('tmux_chat').every(args=>(args as {action:{kind:string}}).action.kind==='snapshot')).toBe(true);
});

it('suspends tmux input if the pane snapshot fails after binding',async()=>{
  host('codex',[row('Codex','%3')],'available',[turn('First prompt','First answer')]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  let offline=false;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='tmux_chat' && offline?Promise.reject(new Error('offline')):fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);expect(screen.getByRole('region',{name:'Terminal input'})).toBeTruthy();
  offline=true;await advance(5000);expect(screen.queryByRole('region',{name:'Terminal input'})).toBeNull();
  const count=calls('agent_transcript').length;await advance(2000);expect(calls('agent_transcript')).toHaveLength(count);
});


it.each(['pane','report','history'] as const)('discards a tmux transcript if its %s changes before the reply',async change=>{
  const rows=[row('Codex','%3')];host('codex',rows,'available',[[]]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;let finish!:(value:unknown)=>void,pane='%3',changed=false;
  vi.mocked(invoke).mockImplementation((command,args,options)=>{
    if(command==='agent_transcript')return new Promise(resolve=>{finish=resolve;});
    if(command==='tmux_chat' && (args as {action:{kind:string}}).action.kind==='snapshot')return Promise.resolve({...tmuxChatSnapshot,destination:{...tmuxChatSnapshot.destination,paneId:pane}});
    if(command==='agent_reported_history' && changed && change==='history')return Promise.resolve({schemaVersion:1,sessionId:'Codex-session',status:'available',path:'/different',reportedAt:'2026-11-09T10:00:00Z',paneId:'%3'});
    return fallback(command,args,options);
  });
  render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);changed=true;if(change==='pane')pane='%4';if(change==='report')rows.splice(0);
  await act(async()=>finish(page('codex',turn('Stale prompt','Stale answer'))));
  expect(screen.queryByText('Stale answer')).toBeNull();expect(screen.queryByRole('region',{name:'Terminal input'})).toBeNull();
});

// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {invoke} from '@tauri-apps/api/core';
import AgentView from './AgentView';
import {chatFollowAccess as access} from './test/chatFollowAccess';
import {tmuxChatReply,tmuxChatSnapshot} from './test/tmuxChat';
import {herdrNavigationTree} from './test/herdrNavigation';
import {herdrBound,herdrChatReply,herdrPrepared,herdrTarget} from './test/herdrChat';
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
const options=()=>{const button=screen.getByRole('button',{name:'Agent view options'});if(button.getAttribute('aria-expanded')!=='true')fireEvent.click(button);return screen.getByRole('group',{name:'Agent view options'});};
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
    // One compact row: agent, folder, state. A report is not a live reading, so that stays in the state's tooltip.
    expect(within(header).getByText(`${label} · work`)).toBeTruthy();expect(within(header).getByText('Working').getAttribute('title')).toBe('Last reported: Working');
    const sessions=within(options()).getByRole('button',{name:'Last-reported agent sessions'});
    expect(sessions.getAttribute('aria-expanded')).toBe('false');fireEvent.click(sessions);
    expect(screen.getByRole('region',{name:'Last-reported agent sessions'})).toBeTruthy();fireEvent.click(options().querySelector('button')!);
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
    // The composer is always there, one line, and bound to this pane without a confirmation step.
    expect(screen.getByRole('textbox',{name:'Draft for this terminal'}).getAttribute('rows')).toBe('1');
    expect(screen.queryByRole('button',{name:'Choose terminal destination'})).toBeNull();expect(screen.queryByRole('button',{name:'Confirm this destination'})).toBeNull();
    expect(calls('tmux_chat').map(args=>(args as {action:{kind:string}}).action.kind)).toContain('bind');
    await advance(2000);
    expect(screen.getAllByRole('region',{name:'Turn'})).toHaveLength(2);
    expect(screen.getByText('Typed in the terminal')).toBeTruthy();expect(screen.getByText('Second answer')).toBeTruthy();
    // Binding is not sending: no input reaches the terminal until the person sends.
    expect(calls('tmux_chat').some(args=>(args as {action:{kind:string}}).action.kind==='input')).toBe(false);
  });
});

it('shows what the harness wrote as compact events and keeps token counters out of the message flow',async()=>{
  host('claude',[row('Claude Code','%3')],'available',[[
    {id:'p',role:'user',blocks:[{type:'text',text:'Explain the build'}]},
    {id:'a',role:'assistant',blocks:[{type:'text',text:'The build uses Vite.'}],usage:{inputTokens:2,outputTokens:51,cacheReadTokens:157518,cacheWriteTokens:1790}},
    {id:'n',role:'user',blocks:[{type:'text',text:'<task-notification>\n<task-id>bl44ejerw</task-id>\n<summary>Monitor event: "Version PRs"</summary>\n<event>version PR #624 checks green</event>\n</task-notification>'}]},
    {id:'r',role:'user',blocks:[{type:'text',text:'<system-reminder>Context for the model.</system-reminder>'}]},
    {id:'t',role:'assistant',blocks:[{type:'thinking',text:''},{type:'tool_use',id:'c',name:'Bash',text:'gh pr list'}]},
    {id:'a2',role:'assistant',blocks:[{type:'text',text:'The version PR is green.'}],usage:{inputTokens:2,outputTokens:114,cacheReadTokens:153532,cacheWriteTokens:472}},
    {id:'o',role:'user',blocks:[{type:'text',text:'<local-command-stdout>Set model to Sonnet</local-command-stdout>'}]},
  ]]);
  render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);
  const flow=screen.getByRole('region',{name:'Conversation messages'});
  expect(flow.textContent).not.toMatch(/<\/?(task-notification|system-reminder|local-command-stdout)|Context for the model|Tokens:|inputTokens|cacheReadTokens/);
  // Only what the person typed is a bubble; the harness records are one muted line each.
  expect(within(flow).getAllByRole('article',{name:'user'}).map(article=>article.textContent)).toEqual(['Explain the build']);
  expect(within(flow).getByText(/^Task notification/).textContent).toBe('Task notification · version PR #624 checks green');
  expect(within(flow).getByText(/^Command output/).textContent).toBe('Command output · Set model to Sonnet');
  expect(within(flow).getAllByRole('region',{name:'Turn'})).toHaveLength(3);
  expect(within(flow).getByText('The version PR is green.')).toBeTruthy();
  // The latest response's counters stay available behind the options button.
  expect(within(options()).getByText('Last response: 2 input, 114 output, 153,532 cache read, 472 cache write tokens')).toBeTruthy();
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
  // No agent in this pane: starting one stages its command in the terminal composer for review; nothing is sent from here.
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  fireEvent.click(screen.getByRole('button',{name:'Start Claude Code'}));
  expect(staged).toHaveBeenCalledTimes(1);expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'ssh',text:'claude'});
  window.removeEventListener('lazysh-prompt-draft',staged);
  expect(calls('tmux_chat').every(args=>(args as {action:{kind:string}}).action.kind==='snapshot')).toBe(true);
});

it('labels a detected agent without a reported conversation as partial and never reads a transcript',async()=>{
  host('codex',[{...row('Codex','%3','needs_attention'),summary:'Turn failed'}],'missing',[[]]);
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/^The last Codex report names this pane, but its conversation is unavailable/)).toBeTruthy();
  expect(screen.getByText('Attention').getAttribute('title')).toBe('Last reported: Attention');
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

it('opens the conversation of the focused Herdr pane by itself through the revalidated host resolver and binds the composer to that pane only',async()=>{
  const first={...herdrNavigationTree.agents[0],agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'session-one'}};
  let available=true,guardPane='w2E:pF';
  // The guarded Herdr terminal is the focused pane here; a second case below attaches it to another pane.
  const guard=()=>({...herdrTarget,pane:guardPane,terminal:'term-one'});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'owned'}];
    if(command==='herdr_tree')return {...herdrNavigationTree,agents:[first]};
    if(command==='herdr_chat'){
      const reply=await herdrChatReply(command,args) as {kind:string};
      return reply.kind==='prepared'?{...herdrPrepared,destination:guard()}:reply.kind==='bound'?{...herdrBound,destination:guard()}:reply;
    }
    if(command==='agent_herdr_conversation'){if(!available)throw new Error('Session unavailable');return page('codex',turn('Prompt','Verified answer'));}
    throw new Error('unavailable');
  });
  const view=render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" terminalInput={{backend:'herdr',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);
  // No click: the agent of the focused pane is the conversation, and no list is in the way.
  expect(screen.queryByRole('button',{name:/Open conversation/})).toBeNull();expect(screen.queryByRole('region',{name:'Live Herdr agents'})).toBeNull();
  // The standing notices are not in the message flow; the caveat stays one tap away and the conversation grants no input.
  expect(screen.queryByText(/not verified as belonging|association with this pane is unverified/)).toBeNull();
  expect(within(options()).getByText(/^Herdr links this conversation to the focused pane of this terminal: Work · Code\./)).toBeTruthy();
  expect(screen.getByText('Verified answer')).toBeTruthy();
  expect(calls('agent_herdr_conversation')).toEqual([{sessionId:'ssh',target:{agent:'codex',agentSessionId:'session-one',herdrSession:'owned',paneId:'w2E:pF',terminalId:'term-one'}}]);
  expect(calls('agent_transcript')).toEqual([]);
  // The guarded terminal is the pane Herdr links the conversation to, so no destination step is shown and nothing is sent until Send.
  const guarded=()=>calls('herdr_chat').map(args=>(args as {action:{kind:string}}).action.kind);
  expect(guarded()).toEqual(['status','prepare','confirm']);
  expect(screen.queryByRole('button',{name:'Choose terminal destination'})).toBeNull();
  fireEvent.change(screen.getByRole('textbox',{name:'Draft for this terminal'}),{target:{value:'Run the tests'}});
  fireEvent.click(screen.getByRole('button',{name:'Send to the agent'}));await advance(0);
  expect(calls('herdr_chat').at(-1)).toMatchObject({action:{kind:'input',input:{kind:'send',text:'Run the tests'},source:{agent:'codex',path:'session-one',view:'conversation',inlineImages:false}}});
  // The same conversation with the guarded terminal on another pane sends nothing and says why; Stage stays the way out.
  view.unmount();guardPane='other-pane';vi.mocked(invoke).mockClear();
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" terminalInput={{backend:'herdr',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText(/does not run in this terminal pane/)).toBeTruthy();
  expect(guarded()).toEqual(['status','prepare']);
  const staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  fireEvent.change(screen.getByRole('textbox',{name:'Draft for this terminal'}),{target:{value:'Run the tests'}});fireEvent.click(screen.getByRole('button',{name:'Stage in terminal'}));
  expect(staged).toHaveBeenCalledTimes(1);window.removeEventListener('lazysh-prompt-draft',staged);
  available=false;await advance(2000);expect(calls('agent_herdr_conversation')).toHaveLength(2);
  expect(screen.getAllByRole('alert').map(alert=>alert.textContent).join(' ')).toContain('Session unavailable');
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
  expect(screen.queryByRole('textbox',{name:'Draft for this terminal'})).toBeNull();expect(screen.queryByRole('button',{name:'Stage in terminal'})).toBeNull();
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

it.each(['gone','changed'] as const)('suspends a selected report when it is %s',async change=>{
  const rows=[row('Codex',null)];
  host('codex',rows,'available',[turn('First prompt','First answer'),turn('Stale prompt','Stale answer')]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  let changed=false;
  vi.mocked(invoke).mockImplementation((command,args,options)=>changed && change==='changed' && command==='agent_reported_history'
    ? Promise.resolve({schemaVersion:1,sessionId:'Codex-session',status:'available',path:'/different',reportedAt:'2026-11-09T10:00:00Z',paneId:null}) : fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux={false} onShowTerminal={()=>{}}/>);
  await advance(0);fireEvent.click(screen.getByRole('button',{name:/Codex · \/work/}));await advance(0);
  changed=true;if(change==='gone')rows.splice(0);
  await advance(2000);
  expect(calls('agent_transcript')).toHaveLength(1);expect(screen.queryByText('Stale answer')).toBeNull();
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
  expect(within(screen.getByRole('region',{name:'Last-reported agent sessions'})).getByRole('alert').textContent).toMatch(/This session's conversation is unavailable/);
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

const claude={...herdrNavigationTree.agents[0],agent:'claude',name:null,agent_session:{source:'herdr:claude',agent:'claude',kind:'id',value:'session-one'}};
/** The agent's pane is not the focused one: a shell pane next to it is, so the agent is a list row to pick. */
const shell={...herdrNavigationTree.panes[0],pane_id:'w2E:pS',terminal_id:'term-shell',cwd:'/work/shell',focused:true,agent_status:'idle'};
const away={...herdrNavigationTree,panes:[{...herdrNavigationTree.panes[0],focused:false},shell]};
const stock=(...agents:unknown[])=>vi.mocked(invoke).mockImplementation(async command=>{
  if(command==='multiplexer_sessions')return [{name:'owned'}];
  if(command==='herdr_tree')return {...away,agents};
  if(command==='agent_snapshot')return {schemaVersion:1,sessions:[row('Claude Code',null),row('Codex',null,'done')]};
  throw new Error('unavailable');
});

it('lists only the live Herdr agents, never the last-reported sessions of the host',async()=>{
  stock(claude);
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onEnterHerdr={vi.fn()} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByRole('region',{name:'Live Herdr agents'})).toBeTruthy();
  expect(screen.queryByRole('region',{name:'Last-reported agent sessions'})).toBeNull();
  expect(screen.queryByText(/Claude Code-session|Codex-session/)).toBeNull();
  expect(calls('agent_snapshot')).toEqual([]);expect(calls('agent_reported_history')).toEqual([]);
  // The row says what it is: agent kind, folder, status, workspace and tab by name.
  const card=screen.getByText('/work/codex').closest('article')!;
  expect(within(card).getByText('claude')).toBeTruthy();expect(within(card).getByText('Working')).toBeTruthy();
  expect(within(card).getByText('owned · Work · Code')).toBeTruthy();
});

it('opens the agent chat when its row is clicked anywhere and still offers the exact pane',async()=>{
  stock(claude);
  vi.mocked(invoke).mockImplementation(async(command)=>command==='agent_herdr_conversation'?page('claude',turn('Prompt','Native answer')):command==='multiplexer_sessions'?[{name:'owned'}]:{...away,agents:[claude]});
  const enter=vi.fn(async()=>{});
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onEnterHerdr={enter} onShowTerminal={()=>{}}/>);
  await advance(0);
  fireEvent.click(screen.getByText('/work/codex'));await advance(0);
  const header=screen.getByRole('region',{name:'Agent view'}).querySelector('header')!;
  expect(within(header).getByText('Claude Code · codex')).toBeTruthy();expect(within(header).getByText('Working')).toBeTruthy();
  // A hand-picked agent of another pane says so, and says it again in the caveat.
  expect(within(header).getByText('Not this pane')).toBeTruthy();
  expect(screen.getByText('Native answer')).toBeTruthy();
  expect(within(screen.getByRole('region',{name:'Turn'})).getByRole('article',{name:'user'})).toBeTruthy();
  // Back and Enter wait behind the options button instead of taking a row of their own.
  expect(screen.queryByRole('button',{name:'Enter session'})).toBeNull();expect(screen.queryByRole('button',{name:'Back to sessions'})).toBeNull();
  fireEvent.click(within(options()).getByRole('button',{name:'Enter session'}));
  expect(enter).toHaveBeenCalledExactlyOnceWith('owned',{kind:'pane',workspace:'w2E',tab:'w2E:tC',pane:'w2E:pF',terminal:'term-one'},expect.anything(),expect.any(Function));
});

/** A host companion that predates `herdr-conversation`: reading any conversation fails with the update requirement. */
function oldCompanion() {
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args,options)=>{
    if(command==='agent_herdr_conversation')throw {kind:'herdr_conversation_companion_required',message:'Update the companion'};
    return fallback(command,args,options);
  });
}
it('tells the user to update an old companion and still lets them enter the pane',async()=>{
  stock(claude);
  oldCompanion();
  const enter=vi.fn(async()=>{throw new Error('Pane is gone');});const setup=vi.fn();
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onEnterHerdr={enter} onOpenCompanion={setup} onShowTerminal={()=>{}}/>);
  await advance(0);
  fireEvent.click(screen.getByRole('button',{name:/Open conversation/}));await advance(0);
  expect(screen.getByRole('alert').textContent).toMatch(/companion on this host is too old to read agent conversations/);
  fireEvent.click(screen.getByRole('button',{name:'Host companion installation'}));expect(setup).toHaveBeenCalledTimes(1);
  fireEvent.click(within(options()).getByRole('button',{name:'Enter session'}));await advance(0);
  expect(enter).toHaveBeenCalledTimes(1);expect(screen.getAllByRole('alert').map(alert=>alert.textContent)).toContain('Pane is gone');
  // Going back returns to the live list instead of leaving a dead view.
  fireEvent.click(within(options()).getByRole('button',{name:'Back to sessions'}));await advance(0);
  expect(screen.queryByRole('group',{name:'Agent view options'})).toBeNull();
  expect(screen.getByText('/work/codex')).toBeTruthy();
});

it('explains a row without one reported conversation instead of hiding its action',async()=>{
  const shared={...claude,agent_session:{...claude.agent_session}};
  stock(shared,{...shared,pane_id:'w2E:pG',terminal_id:'term-two'},{...herdrNavigationTree.agents[0],agent:'codex',name:null,pane_id:'w2E:pH',terminal_id:'term-three'});
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args,options)=>command==='herdr_tree'?{...herdrNavigationTree,agents:[shared,{...shared,pane_id:'w2E:pG',terminal_id:'term-two'},{...herdrNavigationTree.agents[0],agent:'codex',name:null,pane_id:'w2E:pH',terminal_id:'term-three'}],panes:[...herdrNavigationTree.panes,{...herdrNavigationTree.panes[0],pane_id:'w2E:pG',terminal_id:'term-two'},{...herdrNavigationTree.panes[0],pane_id:'w2E:pH',terminal_id:'term-three'}]}:fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onEnterHerdr={vi.fn()} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getAllByText(/^No single conversation is reported for this agent/)).toHaveLength(3);
  expect(screen.queryByRole('button',{name:/Open conversation/})).toBeNull();
  expect(screen.getAllByRole('button',{name:'Enter session'})).toHaveLength(3);
});

/** A Herdr server with a Claude Code pane `w2E:p1` in `/work/one`, a Codex pane `w2E:p2` in `/work/two` and a shell pane `w2E:p3`; `focus` is the focused pane. */
function server(state:{focus:string;agents?:string[]}) {
  const place=(id:string,cwd:string)=>({...herdrNavigationTree.panes[0],pane_id:id,terminal_id:`term-${id}`,cwd,focused:state.focus===id});
  const live=(id:string,agent:'claude'|'codex',session:string)=>({...herdrNavigationTree.agents[0],agent,name:null,pane_id:id,terminal_id:`term-${id}`,agent_session:{source:`herdr:${agent}`,agent,kind:'id',value:session}});
  const agents=[live('w2E:p1','claude','session-one'),live('w2E:p2','codex','session-two')].filter(agent=>(state.agents??['w2E:p1','w2E:p2']).includes(agent.pane_id));
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'owned'}];
    if(command==='herdr_tree')return {...herdrNavigationTree,panes:[place('w2E:p1','/work/one'),place('w2E:p2','/work/two'),place('w2E:p3','/work/shell')].filter(pane=>pane.pane_id!=='w2E:p3' || true),agents};
    if(command==='agent_herdr_conversation'){const target=(args as {target:{agent:'claude'|'codex';agentSessionId:string}}).target;return page(target.agent,turn('Prompt',`Answer of ${target.agentSessionId}`));}
    throw new Error(`Unexpected ${command}`);
  });
}
const view=(extra:Partial<Parameters<typeof AgentView>[0]>={})=><AgentView sessionId="ssh" shown tmux={false} herdrSession="owned" onEnterHerdr={vi.fn()} onShowTerminal={()=>{}} {...extra}/>;

it('shows the agent of the focused Herdr pane without a pick, and follows focus, tab and agent changes',async()=>{
  const state={focus:'w2E:p1'};server(state);
  render(view());await advance(0);
  const header=()=>screen.getByRole('region',{name:'Agent view'}).querySelector('header')!;
  expect(within(header()).getByText('Claude Code · one')).toBeTruthy();expect(screen.getByText('Answer of session-one')).toBeTruthy();
  expect(screen.queryByRole('region',{name:'Live Herdr agents'})).toBeNull();
  expect(calls('agent_herdr_conversation')).toEqual([{sessionId:'ssh',target:{agent:'claude',agentSessionId:'session-one',herdrSession:'owned',paneId:'w2E:p1',terminalId:'term-w2E:p1'}}]);
  // Focus another pane: the other agent's conversation replaces it within one poll and the old one is gone.
  state.focus='w2E:p2';await advance(3000);await advance(0);
  expect(within(header()).getByText('Codex · two')).toBeTruthy();expect(screen.getByText('Answer of session-two')).toBeTruthy();expect(screen.queryByText('Answer of session-one')).toBeNull();
  expect(calls('agent_herdr_conversation').at(-1)).toMatchObject({target:{agent:'codex',agentSessionId:'session-two',paneId:'w2E:p2'}});
  // A pane without an agent while others run: the live list, never the previous pane's chat.
  state.focus='w2E:p3';await advance(3000);await advance(0);
  expect(screen.queryByText('Answer of session-two')).toBeNull();expect(screen.getByRole('region',{name:'Live Herdr agents'})).toBeTruthy();
  expect(screen.getByText('No agent runs in the focused pane. Choose a live agent.')).toBeTruthy();
  expect(screen.getAllByRole('button',{name:/Open conversation/})).toHaveLength(2);
});

it('lets the user look at another agent and come back to the pane\'s own, keeping its draft',async()=>{
  const state={focus:'w2E:p1'};server(state);
  render(view());await advance(0);
  fireEvent.change(screen.getByRole('textbox',{name:'Draft for this terminal'}),{target:{value:'Keep this draft'}});
  fireEvent.click(within(options()).getByRole('button',{name:'Choose another agent'}));await advance(0);
  expect(screen.getByRole('region',{name:'Live Herdr agents'})).toBeTruthy();
  fireEvent.click(within(options()).getByRole('button',{name:"This pane's agent"}));await advance(0);
  expect(screen.queryByRole('region',{name:'Live Herdr agents'})).toBeNull();
  expect(screen.getByText('Answer of session-one')).toBeTruthy();
  expect(screen.getByRole('textbox',{name:'Draft for this terminal'})).toHaveProperty('value','Keep this draft');
});

it('drops a hand-picked conversation when focus moves to another pane',async()=>{
  const state={focus:'w2E:p3'};server(state);
  render(view());await advance(0);
  fireEvent.click(within(screen.getByText('/work/two').closest('article')!).getByRole('button',{name:/Open conversation/}));await advance(0);
  expect(screen.getByText('Answer of session-two')).toBeTruthy();
  state.focus='w2E:p1';await advance(3000);await advance(0);
  expect(screen.queryByText('Answer of session-two')).toBeNull();expect(screen.getByText('Answer of session-one')).toBeTruthy();
  expect(screen.queryByText('Not this pane')).toBeNull();
});

it('offers to start an agent when none runs, staging the command for review instead of running it',async()=>{
  const state={focus:'w2E:p3',agents:[] as string[]};server(state);
  const shown=vi.fn(),staged=vi.fn();window.addEventListener('lazysh-prompt-draft',staged);
  render(view({herdrLaunch:true,onShowTerminal:shown}));await advance(0);
  expect(screen.getByText('No agent is running in this session.')).toBeTruthy();expect(screen.queryByRole('region',{name:'Live Herdr agents'})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Start Codex'}));
  expect(staged).toHaveBeenCalledTimes(1);expect((staged.mock.calls[0][0] as CustomEvent).detail).toEqual({sessionId:'ssh',text:'codex'});
  window.removeEventListener('lazysh-prompt-draft',staged);
  expect(calls('herdr_action')).toEqual([]);expect(calls('agent_herdr_conversation')).toEqual([]);
  // The launcher flow of the Herdr workspace dialog opens with "start an agent" already chosen.
  fireEvent.click(screen.getByRole('button',{name:'Start an agent'}));
  const dialog=screen.getByRole('dialog',{name:'New Herdr workspace'});
  expect((within(dialog).getByRole('radio',{name:'Yes, start an agent'}) as HTMLInputElement).checked).toBe(true);
  expect(within(screen.getByRole('region',{name:'Agent view'})).getByRole('button',{name:'Show terminal'})).toBeTruthy();
});

it('keeps the linked reader and its draft while the view is hidden, without showing it until the pane is read again',async()=>{
  const state={focus:'w2E:p1'};server(state);
  const rendered=render(view());await advance(0);
  fireEvent.change(screen.getByRole('textbox',{name:'Draft for this terminal'}),{target:{value:'Keep this draft'}});
  rendered.rerender(view({shown:false}));await advance(5000);
  rendered.rerender(view());
  // Until Herdr answers again nothing is known about the focused pane, so nothing of the old chat is shown.
  expect(document.querySelector('section.chat-panel')!.hasAttribute('hidden')).toBe(true);
  await advance(0);
  expect(screen.getByRole('textbox',{name:'Draft for this terminal'})).toHaveProperty('value','Keep this draft');
  expect(screen.getByText('Answer of session-one')).toBeTruthy();
  // The pane moved on while hidden: the draft goes with the old conversation and the new one shows.
  rendered.rerender(view({shown:false}));state.focus='w2E:p2';rendered.rerender(view());await advance(0);
  expect(screen.getByText('Answer of session-two')).toBeTruthy();expect(screen.queryByText('Answer of session-one')).toBeNull();
  expect(screen.getByRole('textbox',{name:'Draft for this terminal'})).toHaveProperty('value','');
});

it('keeps asking Herdr only while shown, every 3 seconds',async()=>{
  const state={focus:'w2E:p1'};server(state);
  const rerender=render(view({shown:false}));await advance(10_000);expect(invoke).not.toHaveBeenCalled();
  rerender.rerender(view());await advance(0);const first=calls('herdr_tree').length;expect(first).toBe(1);
  await advance(3000);expect(calls('herdr_tree')).toHaveLength(first+1);
  rerender.rerender(view({shown:false}));const idle=calls('herdr_tree').length;await advance(10_000);expect(calls('herdr_tree')).toHaveLength(idle);
});

it('keeps the update-your-companion message and button for the linked agent of an old companion',async()=>{
  const state={focus:'w2E:p1'};server(state);
  oldCompanion();
  const setup=vi.fn();
  render(view({onOpenCompanion:setup}));await advance(0);
  expect(screen.getByRole('alert').textContent).toMatch(/companion on this host is too old to read agent conversations/);
  fireEvent.click(screen.getByRole('button',{name:'Host companion installation'}));expect(setup).toHaveBeenCalledTimes(1);
});

it('says an agent without a readable conversation runs in the focused pane and lists the others',async()=>{
  const state={focus:'w2E:p1'};server(state);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation(async(command,args,options)=>{
    const tree=await fallback(command,args,options) as {agents?:{pane_id:string;agent_session?:unknown}[]};
    return command==='herdr_tree'?{...tree,agents:tree.agents!.map(agent=>agent.pane_id==='w2E:p1'?{...agent,agent_session:undefined}:agent)}:tree;
  });
  render(view());await advance(0);
  expect(screen.getByText(/^claude runs in the focused pane, but Herdr has not reported its conversation yet/)).toBeTruthy();
  expect(calls('agent_herdr_conversation')).toEqual([]);expect(screen.getByRole('region',{name:'Live Herdr agents'})).toBeTruthy();
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
  expect(calls('tmux_chat').some(args=>(args as {action:{kind:string}}).action.kind==='input')).toBe(false);
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

describe('waiting for the user',()=>{
  const reported=(summary:string,state:string,minutes:number,pane:string|null=null)=>({...row('Claude Code',pane,state),sessionId:`s-${summary}`,summary,updatedAt:new Date(Date.now()-minutes*60_000).toISOString()});
  const header=()=>screen.getByRole('region',{name:'Agent view'}).querySelector('header')!;
  it.each([
    ['Bash','Waiting for your approval'],['AskUserQuestion','Waiting for your answer'],['ExitPlanMode','Waiting for your plan decision'],['Agent needs attention','Waiting for you'],
  ])('names a %s report in the header with how long it waits',async(summary,label)=>{
    host('claude',[reported(summary,'needs_attention',5,'%3')],'available',[turn('Prompt','Answer')]);
    render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
    await advance(0);
    expect(header().textContent).toContain(`${label} · 5 min. ago`);
  });
  it('keeps the plain state for a failed turn',async()=>{
    host('claude',[reported('Turn failed','needs_attention',5,'%3')],'available',[turn('Prompt','Answer')]);
    render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
    await advance(0);
    expect(within(header()).getByText('Attention')).toBeTruthy();expect(header().textContent).not.toContain('Waiting');
  });
  it('counts the waiting sessions and lists the longest waiting first',async()=>{
    host('claude',[reported('Working','working',1),reported('Bash','needs_attention',3),reported('AskUserQuestion','needs_attention',9)],'available',[turn('Prompt','Answer')]);
    render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
    await advance(0);
    const list=screen.getByRole('region',{name:'Last-reported agent sessions'});
    expect(within(list).getByRole('status').textContent).toBe('2 waiting for you');
    const buttons=within(list).getAllByRole('button').map(button=>button.textContent);
    expect(buttons[0]).toContain('Waiting for your answer · 9 min. ago');expect(buttons[1]).toContain('Waiting for your approval · 3 min. ago');expect(buttons[2]).toContain('Last reported: Working');
  });
});

it('shows how long the agent has waited from the recorded start of the wait, not its last report',async()=>{
  const minutes=(count:number)=>new Date(Date.now()-count*60_000).toISOString();
  host('claude',[{...row('Claude Code','%3','needs_attention'),summary:'Agent needs attention',waiting:'question',waitingSince:minutes(12),updatedAt:minutes(1)}],'available',[turn('Prompt','Answer')]);
  render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByRole('region',{name:'Agent view'}).querySelector('header')!.textContent).toContain('Waiting for your answer · 12 min. ago');
});
describe('permission requests of the agent in this pane',()=>{
  const approval=(id:string,paneId:string,sessionId='Claude Code-session')=>({id,expectedHash:'a'.repeat(64),agent:'claude',sessionId,project:'/work',paneId,toolName:'Bash',toolInput:{command:`run ${id}`},createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300_000).toISOString()});
  function approvals(requests:unknown[],pane=()=>'%3') {
    host('claude',[row('Claude Code','%3','needs_attention')],'available',[turn('Prompt','Answer')]);
    const fallback=vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async(command,args,options)=>{
      if(command==='agent_approvals')return {schemaVersion:1,requests};
      if(command==='resolve_agent_approval')return {schemaVersion:1,accepted:true};
      if(command==='tmux_chat')return {...tmuxChatSnapshot,destination:{...tmuxChatSnapshot.destination,paneId:pane()}};
      return fallback(command,args,options);
    });
  }
  const mount=()=>render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  it('shows only this pane and session, ignores taps for 400 ms, then sends the hook decision once',async()=>{
    approvals([approval('11111111-1111-4111-8111-111111111111','%3'),approval('22222222-2222-4222-8222-222222222222','%9'),approval('33333333-3333-4333-8333-333333333333','%3','another-session')]);
    mount();await advance(0);
    const dock=screen.getByRole('region',{name:'Pending approvals'});
    expect(within(dock).getAllByRole('article')).toHaveLength(1);expect(dock.textContent).toContain('run 11111111-1111-4111-8111-111111111111');expect(dock.textContent).not.toContain('run 22222222');
    const deny=within(dock).getByRole('button',{name:'Deny request'});
    expect(deny.hasAttribute('disabled')).toBe(true);fireEvent.click(deny);expect(calls('resolve_agent_approval')).toEqual([]);
    await advance(400);expect(deny.hasAttribute('disabled')).toBe(false);
    await act(async()=>{fireEvent.click(deny);await vi.advanceTimersByTimeAsync(0);});
    expect(calls('resolve_agent_approval')).toEqual([{sessionId:'ssh',id:'11111111-1111-4111-8111-111111111111',expectedHash:'a'.repeat(64),agentSessionId:'Claude Code-session',paneId:'%3',decision:'deny'}]);
    // Nothing was typed into the terminal: the decision is the hook's, not a key. The composer binds the pane but sends no input.
    // Nothing was typed into the terminal: the decision is the hook's, not a key.
    expect(calls('tmux_chat').some(args=>(args as {action:{kind:string}}).action.kind==='input')).toBe(false);
    expect(screen.queryByRole('region',{name:'Pending approvals'})).toBeNull();
  });
  it('sends nothing when the pane no longer runs that agent session',async()=>{
    let pane='%3';
    approvals([approval('11111111-1111-4111-8111-111111111111','%3')],()=>pane);
    mount();await advance(0);await advance(400);
    pane='%4';
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Allow this request'}));await vi.advanceTimersByTimeAsync(0);});
    expect(calls('resolve_agent_approval')).toEqual([]);expect(within(screen.getByRole('region',{name:'Pending approvals'})).getByRole('alert')).toBeTruthy();
  });
});

describe('answering the open question of the agent',()=>{
  const question=(questions:object[],id='q1')=>[
    {id:'p',role:'user',blocks:[{type:'text',text:'Ask me'}]},
    {id:'a',role:'assistant',blocks:[{type:'tool_use',id,name:'AskUserQuestion',text:'{}',card:{kind:'question',questions}}]},
  ];
  const single={question:'Pick a color',header:'Color',multiple:false,options:[{label:'Red'},{label:'Blue'}]};
  const multi={question:'Pick fruits',multiple:true,options:[{label:'Apple'},{label:'Pear'},{label:'Plum'}]};
  async function open(messages:object[],state='needs_attention',agent='claude',label='Claude Code') {
    host(agent,[row(label,'%3',state)],'available',[[]]);
    const fallback=vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async(command,args,options)=>command==='agent_transcript'?{...page(agent,messages),activity:'waiting'}:fallback(command,args,options));
    render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
    await advance(0);
  }
  // The composer binds the pane the hook report names by itself; the dialog is answered through that same receipt.
  const bind=async()=>{await advance(0);await advance(0);};
  const sent=()=>calls('tmux_chat').map(args=>(args as {action:{kind:string;input?:object}}).action).filter(action=>action.kind==='input').map(action=>action.input);
  const card=()=>screen.getByRole('region',{name:'Question'});
  const click=async(name:string|RegExp)=>{await act(async()=>{fireEvent.click(within(card()).getByRole('button',{name}));await vi.advanceTimersByTimeAsync(0);});};
  it('sends the digit of the chosen option exactly once, after 400 ms, with the pane re-checked first',async()=>{
    await open(question([single]));await bind();
    const blue=within(card()).getByRole('button',{name:'Blue'});
    expect(blue.hasAttribute('disabled')).toBe(true);await advance(400);
    await click('Blue');await click('Blue');
    expect(sent()).toEqual([{kind:'select',option:2,of:2}]);
    expect(within(card()).getByRole('status').textContent).toContain('Sent to the terminal');
    expect(calls('agent_snapshot').length).toBeGreaterThan(1);
  });
  it('toggles each fruit, confirms the list, then the review page',async()=>{
    await open(question([multi]));await bind();await advance(400);
    fireEvent.click(within(card()).getByLabelText('Plum'));fireEvent.click(within(card()).getByLabelText('Apple'));
    await act(async()=>{fireEvent.click(within(card()).getByRole('button',{name:'Send answer'}));await vi.advanceTimersByTimeAsync(800);});
    expect(sent()).toEqual([{kind:'select',option:1,of:3},{kind:'select',option:3,of:3},{kind:'submit',of:3},{kind:'select',option:1,of:2}]);
  });
  it('goes through several questions in order and ends on the review page',async()=>{
    await open(question([single,{...single,question:'Pick a size',options:[{label:'Small'},{label:'Large'}]}]));await bind();await advance(400);
    expect(within(card()).getByText(/1\/2/)).toBeTruthy();await click('Red');
    await advance(400);expect(within(card()).getByText(/2\/2/)).toBeTruthy();
    await act(async()=>{fireEvent.click(within(card()).getByRole('button',{name:'Large'}));await vi.advanceTimersByTimeAsync(800);});
    expect(sent()).toEqual([{kind:'select',option:1,of:2},{kind:'select',option:2,of:2},{kind:'select',option:1,of:2}]);
  });
  it('picks the free-text row and types the answer',async()=>{
    await open(question([single]));await bind();await advance(400);
    fireEvent.change(within(card()).getByLabelText('Or type your own answer'),{target:{value:'Green'}});
    await click('Send typed answer');
    expect(sent()).toEqual([{kind:'select',option:3,of:3},{kind:'send',text:'Green'}]);
  });
  it('sends nothing when the agent no longer waits, and says so',async()=>{
    await open(question([single]));await bind();await advance(400);
    const fallback=vi.mocked(invoke).getMockImplementation()!;
    vi.mocked(invoke).mockImplementation(async(command,args,options)=>command==='agent_snapshot'?{schemaVersion:1,sessions:[row('Claude Code','%3','working')]}:fallback(command,args,options));
    await click('Red');
    expect(sent()).toEqual([]);expect(within(card()).getByRole('alert').textContent).toContain('not sent');
  });
  it('keeps the question read-only while the pane is not bound and for agents without verified keys',async()=>{
    await open(question([single]));
    const bound=vi.mocked(invoke).getMockImplementation()!;
    cleanup();vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(async(command,args,options)=>command==='tmux_chat' && (args as {action:{kind:string}}).action.kind==='bind'?Promise.reject(new Error('refused')):bound(command,args,options));
    render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
    await advance(0);await advance(0);
    expect(within(card()).queryByRole('button',{name:'Red'})).toBeNull();expect(within(card()).getByText(/Answer in the terminal/)).toBeTruthy();
    cleanup();vi.mocked(invoke).mockReset();
    await open(question([single]),'needs_attention','codex','Codex');await bind();await advance(400);
    expect(within(card()).queryByRole('button',{name:'Red'})).toBeNull();expect(within(card()).getByText(/Answer in the terminal/)).toBeTruthy();
  });
  it('shows no answer controls for a question the agent already got an answer to',async()=>{
    await open([...question([single]),{id:'r',role:'tool',blocks:[{type:'tool_result',id:'q1',text:'answered'}]}]);await bind();await advance(400);
    expect(within(card()).queryByRole('button',{name:'Red'})).toBeNull();
  });
});

it('shows a message typed while the agent works as a queued card until the agent takes it, then once as the person\'s message',async()=>{
  const queued=[{text:'then run the tests',timestamp:new Date(Date.now()-90_000).toISOString()},{text:'and update the docs'}];
  const first={...page('claude',turn('First prompt','First answer')),queued};
  const taken={...page('claude',[...turn('First prompt','First answer'),...turn('then run the tests','Tests pass')]),queued:[queued[1]]};
  host('claude',[row('Claude Code','%3')],'available',[[]]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  let reply:unknown=first;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='agent_transcript'?Promise.resolve(reply):fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux terminalInput={{backend:'tmux',hostLabel:'host',terminalLabel:'work'}} onShowTerminal={()=>{}}/>);
  await advance(0);
  const cards=screen.getByRole('region',{name:'Queued messages'});
  expect(within(cards).getAllByRole('article').map(card=>card.textContent)).toEqual(['Queued · 1 min. agothen run the tests','Queuedand update the docs']);
  // Queued text is not a turn: the conversation still has the one prompt it had.
  expect(screen.getAllByRole('region',{name:'Turn'})).toHaveLength(1);
  reply=taken;await advance(2500);
  expect(within(screen.getByRole('region',{name:'Queued messages'})).getAllByRole('article').map(card=>card.textContent)).toEqual(['Queuedand update the docs']);
  expect(screen.getAllByText('then run the tests')).toHaveLength(1);
  expect(screen.getAllByRole('region',{name:'Turn'})).toHaveLength(2);
  reply={...taken,queued:undefined};await advance(2500);
  expect(screen.queryByRole('region',{name:'Queued messages'})).toBeNull();
});

it('ignores a malformed queue from the companion and shows no card',async()=>{
  const reply={...page('claude',turn('First prompt','First answer')),queued:[null,{text:''},{text:5},{text:'x'.repeat(5000)},'text']};
  host('claude',[row('Claude Code','%3')],'available',[[]]);
  const fallback=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='agent_transcript'?Promise.resolve(reply):fallback(command,args,options));
  render(<AgentView sessionId="ssh" shown tmux onShowTerminal={()=>{}}/>);
  await advance(0);
  expect(screen.getByText('First answer')).toBeTruthy();expect(screen.queryByRole('region',{name:'Queued messages'})).toBeNull();
});

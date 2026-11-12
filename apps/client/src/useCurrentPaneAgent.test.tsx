// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {applyAccessStatus} from './access';
import {useCurrentPaneAgent} from './useCurrentPaneAgent';
import {tmuxChatSnapshot} from './test/tmuxChat';
import type {HerdrTree} from './useHerdrNavigation';

vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));
let revision=0;
beforeEach(()=>{vi.useFakeTimers();applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(++revision),nonce:'b'.repeat(64)});});
afterEach(()=>{cleanup();vi.clearAllMocks();vi.useRealTimers();});

const pane=(id:string,focused:boolean)=>({workspace_id:'w1',tab_id:'w1:t1',pane_id:id,terminal_id:`term-${id}`,cwd:'/work',focused,agent_status:'idle' as const});
const agent=(id:string,name:string|null)=>({terminal_id:`term-${id}`,workspace_id:'w1',tab_id:'w1:t1',pane_id:id,agent_status:'idle' as const,agent:name,name:null});
function herdrTree(focus:string,agents:[string,string|null][]):HerdrTree {
  return {workspaces:[{workspace_id:'w1',label:'work',focused:true,agent_status:'idle'}],tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'1',number:1,focused:true,agent_status:'idle'}],
    panes:['p1','p2','p3'].map(id=>pane(id,id===focus)),agents:agents.map(([id,name])=>agent(id,name))};
}
function Probe({attached,enabled=true}:{attached:{kind:string;name:string}|undefined;enabled?:boolean}) {
  const agent=useCurrentPaneAgent('ssh1',attached,enabled);
  return <output>{agent===undefined?'unknown':agent===null?'none':agent}</output>;
}
const settle=()=>act(async()=>{await vi.advanceTimersByTimeAsync(0);});
const tick=()=>act(async()=>{await vi.advanceTimersByTimeAsync(5000);});

it('follows the focused Herdr pane and its agent, and reports none for a pane without one',async()=>{
  let focus='p1';
  vi.mocked(invoke).mockImplementation(async command=>command==='multiplexer_sessions'?[{name:'main'}]:command==='herdr_tree'?herdrTree(focus,[['p1','claude'],['p2','codex']]):undefined);
  render(<Probe attached={{kind:'herdr',name:'main'}}/>);
  expect(screen.getByRole('status').textContent).toBe('unknown');
  await settle();expect(screen.getByRole('status').textContent).toBe('claude');
  focus='p2';await tick();expect(screen.getByRole('status').textContent).toBe('codex');
  focus='p3';await tick();expect(screen.getByRole('status').textContent).toBe('none');
});
it('reads nothing while the usage item is not on screen',async()=>{
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(<Probe attached={{kind:'herdr',name:'main'}} enabled={false}/>);await tick();await tick();
  expect(invoke).not.toHaveBeenCalled();
  cleanup();render(<Probe attached={{kind:'tmux',name:'work'}} enabled={false}/>);await tick();expect(invoke).not.toHaveBeenCalled();
});
it('reports no agent when Herdr cannot be read',async()=>{
  vi.mocked(invoke).mockRejectedValue({kind:'ssh',message:'down'});
  render(<Probe attached={{kind:'herdr',name:'main'}}/>);await settle();expect(screen.getByRole('status').textContent).toBe('none');
});
const report=(agent:string,paneId:string|null,summary='Turn finished',updatedAt='2026-11-11T10:00:00.000000Z')=>({sessionId:`${agent}-${paneId}`,agent,project:'/work',state:'done',updatedAt,summary,paneId,eventCount:2});
it('finds the agent of the attached tmux pane from the companion report and re-links when it changes',async()=>{
  let sessions=[report('Codex','%9'),report('Claude Code','%3')];
  vi.mocked(invoke).mockImplementation(async command=>command==='agent_snapshot'?{schemaVersion:1,sessions}:command==='tmux_chat'?tmuxChatSnapshot:undefined);
  render(<Probe attached={{kind:'tmux',name:'work'}}/>);await settle();
  expect(screen.getByRole('status').textContent).toBe('Claude Code');
  sessions=[report('Codex','%3','Bash'),...sessions];await tick();expect(screen.getByRole('status').textContent).toBe('Codex');
  sessions=[report('Codex','%3','Session ended'),report('Codex','%9')];await tick();expect(screen.getByRole('status').textContent).toBe('none');
});
it('shows no agent for tmux when the companion is too old to report',async()=>{
  vi.mocked(invoke).mockRejectedValue({kind:'companion_required',message:'old'});
  render(<Probe attached={{kind:'tmux',name:'work'}}/>);await settle();expect(screen.getByRole('status').textContent).toBe('none');
});
it('has no agent for terminals without pane identity',async()=>{
  render(<Probe attached={undefined}/>);await tick();expect(screen.getByRole('status').textContent).toBe('none');
  cleanup();render(<Probe attached={{kind:'zellij',name:'z'}}/>);await tick();expect(screen.getByRole('status').textContent).toBe('none');
  expect(invoke).not.toHaveBeenCalled();
});

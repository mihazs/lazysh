// @vitest-environment jsdom
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {applyAccessStatus} from './access';
import HerdrNavigation from './HerdrNavigation';
import type {HerdrTree} from './useHerdrNavigation';

vi.mock('@tauri-apps/api/core',async original=>({...await original<typeof import('@tauri-apps/api/core')>(),invoke:vi.fn()}));

// Herdr's snapshot flags are the server's shared focus: another connection left it on `alpha`.
// The guarded client attached through this terminal shows `beta`.
const tree:HerdrTree={
  workspaces:[
    {workspace_id:'w1',label:'alpha',focused:true,agent_status:'idle'},
    {workspace_id:'w2',label:'beta',focused:false,agent_status:'idle'},
  ],
  tabs:[
    {workspace_id:'w1',tab_id:'w1:t1',label:'one',number:1,focused:true,agent_status:'idle'},
    {workspace_id:'w2',tab_id:'w2:t2',label:'two',number:1,focused:false,agent_status:'idle'},
  ],
  panes:[
    {workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',terminal_id:'term1',cwd:'/a',focused:true,agent_status:'idle'},
    {workspace_id:'w2',tab_id:'w2:t2',pane_id:'w2:p2',terminal_id:'term2',cwd:'/b',focused:false,agent_status:'idle'},
  ],
  agents:[],
};
const observed=(server='default',pane='w2:p2')=>({kind:'observed',server,destination:{workspace:'w2',tab:'w2:t2',pane,terminal:'term2',runtimeGeneration:'1',viewport:{x:0,y:0,width:80,height:24}}});
const shared=['alpha','one','w1:p1'];
const client=['beta','two','w2:p2'];
const current=()=>[...document.querySelectorAll('.herdr-navigation-row[data-current]')].map(row=>row.querySelector('strong')?.textContent);

async function host(chat:()=>unknown) {
  const {invoke}=await import('@tauri-apps/api/core');
  vi.mocked(invoke).mockImplementation(async command=>{
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_chat')return chat();
    return tree;
  });
  return invoke;
}
const props={sessionId:'host',hostLabel:'Owned host',visible:true,mode:'spaces' as const,onNavigate:vi.fn(),onAttach:vi.fn(),onClose:vi.fn()};

beforeEach(()=>{applyAccessStatus({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:'1',nonce:'b'.repeat(64)});});
afterEach(()=>{cleanup();vi.clearAllMocks();});

describe('Herdr Spaces current marker',()=>{
  it('shows the location the guarded client reports instead of the shared focus',async()=>{
    const invoke=await host(()=>observed());
    render(<HerdrNavigation {...props}/>);
    await waitFor(()=>expect(current()).toEqual(client));
    expect(invoke).toHaveBeenCalledWith('herdr_chat',{sessionId:'host',action:{kind:'observe'}},expect.anything());
  });
  it.each([
    ['stock Herdr, which has no guard',()=>{throw {kind:'herdr_chat_unavailable'};}],
    ['another server',()=>observed('other')],
    ['a destination that is not in the tree',()=>({...observed(),destination:{...observed().destination,pane:''}})],
    ['an unexpected reply',()=>({kind:'status',available:true})],
  ])('keeps the shared focus for %s',async(_name,chat)=>{
    await host(chat);
    render(<HerdrNavigation {...props}/>);
    await waitFor(()=>expect(current()).toEqual(shared));
  });
  it('holds the last reading while a Chat turn is busy, then drops it when the guard is gone',async()=>{
    let reply:()=>unknown=()=>observed();
    await host(()=>reply());
    render(<HerdrNavigation {...props}/>);
    await waitFor(()=>expect(current()).toEqual(client));
    const {invoke}=await import('@tauri-apps/api/core');
    const reads=()=>vi.mocked(invoke).mock.calls.filter(([command])=>command==='herdr_chat').length;
    const refresh=async(settled:string[])=>{
      const button=screen.getByRole('button',{name:'Refresh Herdr tree'}) as HTMLButtonElement;
      await waitFor(()=>expect(button.disabled).toBe(false));
      const before=reads();
      fireEvent.click(button);
      // Assert only once the new read has finished, so a held reading cannot pass by never being replaced.
      await waitFor(()=>{expect(reads()).toBe(before+1);expect(button.disabled).toBe(false);});
      expect(current()).toEqual(settled);
    };
    reply=()=>{throw {kind:'herdr_chat_busy'};};
    await refresh(client);
    reply=()=>{throw {kind:'herdr_chat_unavailable'};};
    await refresh(shared);
  });
});

// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {accessSnapshot,applyAccessStatus} from './access';
import MultiplexerTabStrip from './MultiplexerTabStrip';
import {useMultiplexerStrip} from './useMultiplexerStrip';
import type {SessionAttachment} from './workspace';

vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn(),isTauri:()=>true}));
const headers={headers:{'X-Lazysh-Access':'c'.repeat(64)}};
const calls=()=>vi.mocked(invoke).mock.calls.map(([command,args])=>[command,args]);
const sent=(...commands:string[])=>calls().filter(([command])=>commands.includes(command as string));
beforeEach(()=>applyAccessStatus({initialized:true,supported:true,enabled:true,locked:false,generation:String(BigInt(accessSnapshot().status?.generation??'0')+1n),reason:'Synthetic tab strip authority',nonce:'c'.repeat(64)}));
afterEach(()=>{cleanup();vi.resetAllMocks();});

function Strip({attached,enabled=true,onError=vi.fn()}:{attached:SessionAttachment;enabled?:boolean;onError?:(cause:unknown)=>void}) {
  const {strip,select}=useMultiplexerStrip({sessionId:'ssh:1',attached,enabled,onError});
  return strip?<MultiplexerTabStrip strip={strip} onSelect={select}/>:<p>no strip</p>;
}
const herdrTree=(focused:string)=>({workspaces:[{workspace_id:'w1',label:'Dev',focused:true,agent_status:'idle'}],
  tabs:['t1','t2'].map((tab,index)=>({workspace_id:'w1',tab_id:tab,label:`tab ${index+1}`,number:index+1,focused:tab===focused,agent_status:'idle'})),panes:[],agents:[]});

it('focuses a Herdr tab through a fresh tree and the guarded action, then shows the new focus without a reload',async()=>{
  let focused='t1';
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_tree')return herdrTree(focused);
    if(command==='herdr_action'){focused=(args as {action:{target:string}}).action.target;return;}
  });
  render(<Strip attached={{kind:'herdr',name:'default'}}/>);
  const second=await screen.findByRole('button',{name:/^tab 2/});
  expect(screen.getByRole('button',{name:/^tab 1/}).getAttribute('aria-current')).toBe('true');
  fireEvent.click(second);
  await waitFor(()=>expect(screen.getByRole('button',{name:/^tab 2/}).getAttribute('aria-current')).toBe('true'));
  expect(sent('herdr_action')).toEqual([['herdr_action',{sessionId:'ssh:1',name:'default',action:{type:'focusTab',target:'t2'}}]]);
  // The focus command is typed and never raw input.
  expect(sent('write_stdin','local_write')).toEqual([]);
  expect(vi.mocked(invoke).mock.calls.find(([command])=>command==='herdr_action')?.[2]).toEqual(headers);
});
it('refuses a Herdr tab that is gone from the fresh tree and reports it without focusing anything',async()=>{
  const onError=vi.fn();
  vi.mocked(invoke).mockImplementation(async(command)=>command==='multiplexer_sessions'?[{name:'default'}]:herdrTree('t1'));
  const view=render(<Strip attached={{kind:'herdr',name:'default'}} onError={onError}/>);
  const second=await screen.findByRole('button',{name:/^tab 2/});
  vi.mocked(invoke).mockImplementation(async(command)=>command==='multiplexer_sessions'?[{name:'default'}]:{...herdrTree('t1'),tabs:herdrTree('t1').tabs.slice(0,1)});
  fireEvent.click(second);
  await waitFor(()=>expect(onError).toHaveBeenCalledOnce());
  expect(sent('herdr_action')).toEqual([]);
  view.unmount();
});
it('lists Zellij tabs and goes to one by its 1-based position through the existing action',async()=>{
  vi.mocked(invoke).mockImplementation(async(command)=>command==='zellij_tabs'?[{position:0,name:'shell',active:true},{position:1,name:'logs',active:false}]:undefined);
  render(<Strip attached={{kind:'zellij',name:"my 'session"}}/>);
  fireEvent.click(await screen.findByRole('button',{name:/^logs/}));
  await waitFor(()=>expect(sent('zellij_action')).toHaveLength(1));
  expect(sent('zellij_tabs')[0]).toEqual(['zellij_tabs',{sessionId:'ssh:1',name:"my 'session"}]);
  expect(sent('zellij_action')[0]).toEqual(['zellij_action',{sessionId:'ssh:1',name:"my 'session",action:{type:'goToTab',index:2}}]);
});
it('selects a tmux window with the snapshot generation of the list the chip was drawn from',async()=>{
  const generation='a'.repeat(36);
  const snapshot=(windowId:string)=>({generation,current:{sessionId:'$1',windowId},sessions:[{id:'$1',name:'work',restoreName:null,windows:[{id:'@1',index:0,name:'zsh'},{id:'@2',index:1,name:'vim'}]}]});
  vi.mocked(invoke).mockImplementation(async(command,args)=>command==='tmux_jump_snapshot'?snapshot('@1'):command==='tmux_jump'?snapshot((args as {windowId:string}).windowId):undefined);
  render(<Strip attached={{kind:'tmux',name:'work'}}/>);
  fireEvent.click(await screen.findByRole('button',{name:/^vim/}));
  await waitFor(()=>expect(sent('tmux_jump')).toHaveLength(1));
  expect(sent('tmux_jump')[0]).toEqual(['tmux_jump',{sessionId:'ssh:1',generation,targetSessionId:'$1',windowId:'@2'}]);
});
it('reads nothing while disabled and shows no strip when the multiplexer cannot list its tabs',async()=>{
  vi.mocked(invoke).mockRejectedValue(new Error('zellij too old'));
  const view=render(<Strip attached={{kind:'zellij',name:'old'}} enabled={false}/>);
  await act(async()=>{await Promise.resolve();});
  expect(calls()).toEqual([]);
  view.rerender(<Strip attached={{kind:'zellij',name:'old'}}/>);
  await waitFor(()=>expect(sent('zellij_tabs')).toHaveLength(1));
  expect(screen.getByText('no strip')).toBeTruthy();
});

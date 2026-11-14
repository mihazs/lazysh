// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
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
  const {strip,select,edit}=useMultiplexerStrip({sessionId:'ssh:1',attached,enabled,onError});
  return strip?<MultiplexerTabStrip strip={strip} onSelect={select} onEdit={edit}/>:<p>no strip</p>;
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

const ask=async(chip:HTMLElement|string,name:string,directory?:string)=>{
  if(typeof chip==='string')fireEvent.click(screen.getByRole('button',{name:chip}));
  else {
    // A chip with both Rename and Close opens a menu; one with only Rename goes straight to its prompt.
    fireEvent.contextMenu(chip);
    const rename=screen.queryByRole('button',{name:'Rename'});
    if(rename)fireEvent.click(rename);
  }
  const form=screen.getByRole('form');
  fireEvent.change(within(form).getByLabelText('Name'),{target:{value:name}});
  if(directory!==undefined)fireEvent.change(within(form).getByLabelText('Directory'),{target:{value:directory}});
  await act(async()=>{fireEvent.submit(form);});
};
it('renames a Herdr tab through a fresh tree and the typed action, and shows the new name without a reload',async()=>{
  let label='tab 2';
  const tree=()=>({...herdrTree('t1'),tabs:herdrTree('t1').tabs.map(tab=>tab.tab_id==='t2'?{...tab,label}:tab)});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_tree')return tree();
    if(command==='herdr_action'){label=(args as {action:{label:string}}).action.label;return;}
  });
  render(<Strip attached={{kind:'herdr',name:'default'}}/>);
  await ask(await screen.findByRole('button',{name:/^tab 2/}),'api');
  await screen.findByRole('button',{name:/^api/});
  expect(sent('herdr_action')).toEqual([['herdr_action',{sessionId:'ssh:1',name:'default',action:{type:'renameTab',target:'t2',label:'api'}}]]);
  expect(screen.queryByRole('form')).toBeNull();
  expect(sent('write_stdin','local_write')).toEqual([]);
});
// Renders the strip, then drops the second tab from what the multiplexer reports before `act` runs on it: a tab that went since the strip last read.
const actOnGoneSecondTab=async(act:(chip:HTMLElement)=>Promise<void>)=>{
  const onError=vi.fn();
  vi.mocked(invoke).mockImplementation(async(command)=>command==='multiplexer_sessions'?[{name:'default'}]:herdrTree('t1'));
  render(<Strip attached={{kind:'herdr',name:'default'}} onError={onError}/>);
  const second=await screen.findByRole('button',{name:/^tab 2/});
  vi.mocked(invoke).mockImplementation(async(command)=>command==='multiplexer_sessions'?[{name:'default'}]:{...herdrTree('t1'),tabs:herdrTree('t1').tabs.slice(0,1)});
  await act(second);
  expect(onError).toHaveBeenCalledOnce();
};
it('refuses to rename a Herdr tab that is gone, reports it, and keeps the prompt for another try',async()=>{
  await actOnGoneSecondTab(chip=>ask(chip,'api'));
  expect(sent('herdr_action')).toEqual([]);
  expect(screen.getByRole('form')).toBeTruthy();
});
it('creates a Herdr tab in the focused workspace and then focuses the tab that appeared',async()=>{
  let created=false;
  const tree=()=>{const base=herdrTree('t1');return {...base,tabs:[...base.tabs,...(created?[{workspace_id:'w1',tab_id:'t3',label:'build',number:3,focused:false,agent_status:'idle'}]:[])],
    panes:[{workspace_id:'w1',tab_id:'t1',pane_id:'p1',cwd:'/srv/app',focused:true,agent_status:'idle'}]};};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_tree')return tree();
    if(command==='herdr_action' && (args as {action:{type:string}}).action.type==='createTab')created=true;
  });
  render(<Strip attached={{kind:'herdr',name:'default'}}/>);
  await screen.findByRole('button',{name:/^tab 2/});
  await ask('New tab','build','/srv/app');
  await waitFor(()=>expect(sent('herdr_action')).toHaveLength(2));
  expect(sent('herdr_action').map(([,args])=>(args as {action:unknown}).action)).toEqual([{type:'createTab',workspace:'w1',label:'build',directory:'/srv/app'},{type:'focusTab',target:'t3'}]);
});
it('creates a Zellij tab with its own new-tab action',async()=>{
  vi.mocked(invoke).mockImplementation(async(command)=>command==='zellij_tabs'?[{position:0,name:'shell',active:true}]:undefined);
  render(<Strip attached={{kind:'zellij',name:'build'}}/>);
  await screen.findByRole('button',{name:/^shell/});
  await ask('New tab','logs','/srv/app');
  expect(sent('zellij_action')).toEqual([['zellij_action',{sessionId:'ssh:1',name:'build',action:{type:'newTab',name:'logs',directory:'/srv/app'}}]]);
});
it('renames and creates tmux windows in the attached tmux server, then switches to the new window with the fresh generation',async()=>{
  const first='a'.repeat(36),second='b'.repeat(36);
  let windows=[{id:'@1',index:0,name:'zsh'}],generation=first;
  const snapshot=()=>({generation,current:{sessionId:'$1',windowId:'@1'},sessions:[{id:'$1',name:'work',restoreName:null,windows}]});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='tmux_jump_snapshot')return snapshot();
    if(command==='tmux_action'){
      const {action}=args as {action:{type:string;name:string}};
      windows=action.type==='renameWindow'?windows.map(window=>({...window,name:action.name})):[...windows,{id:'@2',index:1,name:action.name}];generation=second;
    }
  });
  render(<Strip attached={{kind:'tmux',name:'work',tmuxServer:'ops'}}/>);
  await ask(await screen.findByRole('button',{name:/^zsh/}),'shell');
  await screen.findByRole('button',{name:/^shell/});
  await ask('New tab','vim','/srv/app');
  await waitFor(()=>expect(sent('tmux_jump')).toHaveLength(1));
  expect(sent('tmux_action')).toEqual([
    ['tmux_action',{sessionId:'ssh:1',tmuxServer:'ops',action:{type:'renameWindow',target:'@1',name:'shell'}}],
    ['tmux_action',{sessionId:'ssh:1',tmuxServer:'ops',action:{type:'createWindow',target:'$1',name:'vim',directory:'/srv/app'}}]]);
  expect(sent('tmux_jump')[0]).toEqual(['tmux_jump',{sessionId:'ssh:1',generation:second,targetSessionId:'$1',windowId:'@2'}]);
});
it('does not report a created tab as failed when only the switch to it fails, so the prompt cannot create a duplicate',async()=>{
  let created=false;
  const onError=vi.fn();
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_tree')return created?{...herdrTree('t1'),tabs:[...herdrTree('t1').tabs,{workspace_id:'w1',tab_id:'t3',label:'build',number:3,focused:false,agent_status:'idle'}]}:herdrTree('t1');
    if(command==='herdr_action'){
      if((args as {action:{type:string}}).action.type==='focusTab')throw new Error('focus refused');
      created=true;
    }
  });
  render(<Strip attached={{kind:'herdr',name:'default'}} onError={onError}/>);
  await screen.findByRole('button',{name:/^tab 2/});
  await ask('New tab','build','/srv/app');
  expect(sent('herdr_action').map(([,args])=>(args as {action:{type:string}}).action.type)).toEqual(['createTab','focusTab']);
  expect(onError).not.toHaveBeenCalled();
  expect(screen.queryByRole('form')).toBeNull();
  await screen.findByRole('button',{name:/^build/});
});

const closeTab=async(chip:HTMLElement)=>{
  fireEvent.contextMenu(chip);
  fireEvent.click(screen.getByRole('button',{name:'Close'}));
  await act(async()=>{fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'Close'}));});
};
it('closes a Herdr tab through a fresh tree and the typed action, and drops it from the strip without a reload',async()=>{
  let closed=false;
  const tree=()=>({...herdrTree('t1'),tabs:herdrTree('t1').tabs.filter(tab=>!closed || tab.tab_id!=='t2')});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='multiplexer_sessions')return [{name:'default'}];
    if(command==='herdr_tree')return tree();
    if(command==='herdr_action'){closed=(args as {action:{type:string}}).action.type==='closeTab';return;}
  });
  render(<Strip attached={{kind:'herdr',name:'default'}}/>);
  await closeTab(await screen.findByRole('button',{name:/^tab 2/}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:/^tab 2/})).toBeNull());
  expect(sent('herdr_action')).toEqual([['herdr_action',{sessionId:'ssh:1',name:'default',action:{type:'closeTab',target:'t2'}}]]);
  expect(sent('write_stdin','local_write')).toEqual([]);
  // Only one tab is left: it is never offered for closing.
  fireEvent.contextMenu(screen.getByRole('button',{name:/^tab 1/}));
  expect(screen.queryByRole('button',{name:'Close'})).toBeNull();
});
it('refuses to close a Herdr tab that is gone, reports it, and sends nothing',async()=>{
  await actOnGoneSecondTab(closeTab);
  expect(sent('herdr_action')).toEqual([]);
  expect(screen.getByRole('alertdialog')).toBeTruthy();
});
it('renames and closes a Zellij tab by its stable id, never by its position',async()=>{
  let rows=[{position:0,name:'shell',active:true,id:4},{position:1,name:'logs',active:false,id:9}];
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='zellij_tabs')return rows;
    if(command==='zellij_action'){
      const {action}=args as {action:{type:string;id:number;name?:string}};
      rows=action.type==='closeTab'?rows.filter(row=>row.id!==action.id):rows.map(row=>row.id===action.id?{...row,name:action.name!}:row);
    }
  });
  render(<Strip attached={{kind:'zellij',name:'build'}}/>);
  await ask(await screen.findByRole('button',{name:/^logs/}),'api');
  await screen.findByRole('button',{name:/^api/});
  await closeTab(screen.getByRole('button',{name:/^api/}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:/^api/})).toBeNull());
  expect(sent('zellij_action').map(([,args])=>(args as {action:unknown}).action)).toEqual([{type:'renameTab',id:9,name:'api'},{type:'closeTab',id:9}]);
});
it('closes a tmux window in the attached tmux server and shows the remaining windows',async()=>{
  let windows=[{id:'@1',index:0,name:'zsh'},{id:'@2',index:1,name:'vim'}];
  const snapshot=()=>({generation:'a'.repeat(36),current:{sessionId:'$1',windowId:'@1'},sessions:[{id:'$1',name:'work',restoreName:null,windows}]});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='tmux_jump_snapshot')return snapshot();
    if(command==='tmux_action')windows=windows.filter(window=>window.id!==(args as {action:{target:string}}).action.target);
  });
  render(<Strip attached={{kind:'tmux',name:'work',tmuxServer:'ops'}}/>);
  await closeTab(await screen.findByRole('button',{name:/^vim/}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:/^vim/})).toBeNull());
  expect(sent('tmux_action')).toEqual([['tmux_action',{sessionId:'ssh:1',tmuxServer:'ops',action:{type:'closeWindow',target:'@2'}}]]);
  expect(sent('tmux_jump')).toEqual([]);
});

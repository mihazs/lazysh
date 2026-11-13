import {expect,it} from 'vitest';
import type {TmuxJumpSnapshot} from './bridge';
import {herdrFocusAction,herdrStrip,muxEditAction,tmuxStrip,zellijStrip} from './multiplexerTabs';
import type {HerdrTree} from './useHerdrNavigation';

const tree:HerdrTree={
  workspaces:[{workspace_id:'w1',label:'Dev',focused:false,agent_status:'idle'},{workspace_id:'w2',label:'Ops',focused:true,agent_status:'working'},{workspace_id:'w3',label:'Docs',focused:false,agent_status:'blocked'}],
  tabs:[{workspace_id:'w2',tab_id:'w2:t2',label:'logs',number:2,focused:false,agent_status:'blocked'},{workspace_id:'w1',tab_id:'w1:t1',label:'editor',number:1,focused:true,agent_status:'idle'},{workspace_id:'w2',tab_id:'w2:t1',label:'deploy',number:1,focused:true,agent_status:'working'}],
  panes:[{workspace_id:'w2',tab_id:'w2:t1',pane_id:'w2:p1',terminal_id:'term-1',focused:true,agent_status:'working'}],
};

it('maps the focused Herdr workspace to its ordered tabs, agent states and the workspaces to switch to',()=>{
  const strip=herdrStrip(tree)!;
  expect(strip.group).toMatchObject({title:'Ops',state:'working',attention:true});
  expect(strip.group.choices.map(item=>[item.title,item.active,item.attention])).toEqual([['Dev',false,false],['Ops',true,false],['Docs',false,true]]);
  expect(strip.tabs.map(tab=>[tab.title,tab.active,tab.attention,tab.state])).toEqual([['deploy',true,false,'working'],['logs',false,true,'blocked']]);
  expect(strip.tabs[1].ref).toEqual({kind:'herdr',target:{kind:'tab',workspace:'w2',tab:'w2:t2'}});
});
it('shows no attention on the workspace chip for the workspace the user is already in, and falls back to the first workspace',()=>{
  const here=herdrStrip({...tree,workspaces:tree.workspaces.map(item=>({...item,focused:item.workspace_id==='w3'}))})!;
  expect(here.group).toMatchObject({title:'Docs',attention:false});
  expect(herdrStrip({...tree,workspaces:tree.workspaces.map(item=>({...item,focused:false}))})!.group.title).toBe('Dev');
  expect(herdrStrip({...tree,workspaces:[]})).toBeUndefined();
});
it('maps Zellij tabs to 1-based go-to-tab indices in position order and names an unnamed tab by its number',()=>{
  const strip=zellijStrip('build',[{position:2,name:'',active:false},{position:0,name:'shell',active:true}]);
  expect(strip.group).toEqual({title:'build',attention:false,choices:[]});
  expect(strip.tabs.map(tab=>[tab.title,tab.active,tab.ref])).toEqual([['shell',true,{kind:'zellij',index:1}],['3',false,{kind:'zellij',index:3}]]);
});
it('maps the windows of the attached tmux session and carries the snapshot generation that guards the jump',()=>{
  const snapshot:TmuxJumpSnapshot={generation:'g'.repeat(36),current:{sessionId:'$2',windowId:'@5'},sessions:[
    {id:'$1',name:'other',restoreName:null,windows:[{id:'@1',index:0,name:'x'}]},
    {id:'$2',name:'work',restoreName:null,windows:[{id:'@5',index:1,name:'vim'},{id:'@4',index:0,name:'zsh'}]}]};
  const strip=tmuxStrip(snapshot)!;
  expect(strip.group.title).toBe('work');
  expect(strip.tabs.map(tab=>[tab.title,tab.active])).toEqual([['zsh',false],['vim',true]]);
  expect(strip.tabs[0].ref).toEqual({kind:'tmux',session:'$2',window:'@4',generation:'g'.repeat(36)});
  expect(tmuxStrip({...snapshot,current:{sessionId:'$9',windowId:'@9'}})).toBeUndefined();
});
it('builds the Herdr focus command only for a workspace, tab or pane that still exists',()=>{
  expect(herdrFocusAction(tree,{kind:'workspace',workspace:'w3'})).toEqual({type:'focusWorkspace',target:'w3'});
  expect(herdrFocusAction(tree,{kind:'tab',workspace:'w2',tab:'w2:t2'})).toEqual({type:'focusTab',target:'w2:t2'});
  expect(herdrFocusAction(tree,{kind:'pane',workspace:'w2',tab:'w2:t1',pane:'w2:p1',terminal:'term-1'})).toEqual({type:'focusPane',target:'w2:p1'});
  for(const gone of [{kind:'workspace',workspace:'w9'},{kind:'tab',workspace:'w2',tab:'w1:t1'},{kind:'pane',workspace:'w2',tab:'w2:t1',pane:'w2:p1',terminal:'other'}] as const)
    expect(()=>herdrFocusAction(tree,gone)).toThrow();
});
it('offers a rename and a new tab only where the multiplexer layer has the typed command, and starts a Herdr tab where its workspace is working',()=>{
  const herdr=herdrStrip({...tree,panes:[{...tree.panes[0],cwd:'/srv/app'}]})!;
  expect(herdr.tabs.map(tab=>tab.rename)).toEqual([{kind:'herdr',type:'renameTab',target:'w2:t1'},{kind:'herdr',type:'renameTab',target:'w2:t2'}]);
  expect(herdr.group.choices.map(item=>item.rename)).toEqual(['w1','w2','w3'].map(target=>({kind:'herdr',type:'renameWorkspace',target})));
  expect(herdr.create).toEqual({edit:{kind:'herdr',type:'createTab',workspace:'w2'},directory:'/srv/app'});
  expect(herdrStrip(tree)!.create?.directory).toBe('.');
  // Zellij has no rename-tab command: a long press there would have nothing to ask for.
  const zellij=zellijStrip('build',[{position:0,name:'shell',active:true}]);
  expect(zellij.tabs[0].rename).toBeUndefined();
  expect(zellij.create).toEqual({edit:{kind:'zellij',type:'newTab'},directory:'.'});
  const snapshot:TmuxJumpSnapshot={generation:'g'.repeat(36),current:{sessionId:'$2',windowId:'@5'},sessions:[{id:'$2',name:'work',restoreName:null,windows:[{id:'@5',index:0,name:'vim'}]}]};
  expect(tmuxStrip(snapshot)!.tabs[0].rename).toEqual({kind:'tmux',type:'renameWindow',target:'@5'});
  expect(tmuxStrip(snapshot)!.create).toEqual({edit:{kind:'tmux',type:'createWindow',target:'$2'},directory:'.'});
});
it("builds each multiplexer's own typed action from a name, and refuses a Herdr workspace or tab that has gone",()=>{
  expect(muxEditAction({kind:'herdr',type:'renameTab',target:'w2:t2'},'api',"/ignored",tree)).toEqual({type:'renameTab',target:'w2:t2',label:'api'});
  expect(muxEditAction({kind:'herdr',type:'renameWorkspace',target:'w3'},'docs',"/ignored",tree)).toEqual({type:'renameWorkspace',target:'w3',label:'docs'});
  expect(muxEditAction({kind:'herdr',type:'createTab',workspace:'w1'},'build','/srv/app',tree)).toEqual({type:'createTab',workspace:'w1',label:'build',directory:'/srv/app'});
  expect(muxEditAction({kind:'zellij',type:'newTab'},'logs','/srv/app')).toEqual({type:'newTab',name:'logs',directory:'/srv/app'});
  expect(muxEditAction({kind:'tmux',type:'renameWindow',target:'@5'},'edit','/ignored')).toEqual({type:'renameWindow',target:'@5',name:'edit'});
  expect(muxEditAction({kind:'tmux',type:'createWindow',target:'$2'},'edit','/srv/app')).toEqual({type:'createWindow',target:'$2',name:'edit',directory:'/srv/app'});
  for(const gone of [{kind:'herdr',type:'renameTab',target:'w9:t9'},{kind:'herdr',type:'renameWorkspace',target:'w9'},{kind:'herdr',type:'createTab',workspace:'w9'}] as const)
    expect(()=>muxEditAction(gone,'x','.',tree)).toThrow();
});

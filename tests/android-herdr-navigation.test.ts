import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ownedHerdrContext} from './support/androidHerdr';

async function oracle(name:'ownedVisibleHerdr'|'ownedLiveHerdrNavigation'='ownedVisibleHerdr') {
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-visible-herdr.js'),'utf8');
  return new Function('getComputedStyle',`${source};return ${name};`)((node:{display:string})=>({display:node.display,visibility:'visible'}));
}
function fixture() {
  const labels=['source','source / owned-guard','source / owned-guard / owned-guard'];
  const tabs=labels.map((textContent,index)=>({textContent,querySelector:():object|null=>null,getAttribute:()=>index===2?'true':'false'}));
  const screen=(textContent:string,display='flex')=>({textContent,display,getClientRects:()=>display==='none'?[]:[{}],getBoundingClientRect:()=>({width:100,height:100})});
  const pane=(text:string,display='flex')=>({...screen('',display),querySelectorAll:()=>[screen(text)]});
  const panes=[pane('source','none'),pane('target','none'),pane('target')];
  const document={querySelectorAll:(selector:string)=>selector==='.terminal-pane'?panes:tabs};
  return {document,labels,tabs,panes,pane};
}
test('native two-display oracle requires exactly the selected live connection and its sole visible terminal',async()=>{
  const observe=await oracle(),f=fixture();
  expect(observe(f.document,f.labels,2,'target',['source'])).toBe(true);
  expect(observe(f.document,f.labels,1,'target',['source'])).toBe(false);
  f.tabs[1].querySelector=()=>({});
  expect(observe(f.document,f.labels,2,'target',['source'])).toBe(false);
});
test('inactive canvases, duplicate visible panes, extra children and mixed markers cannot satisfy navigation evidence',async()=>{
  const observe=await oracle();
  for(const change of ['hiddenOnly','multipleVisible','extraChild','mixedMarkers'] as const){
    const f=fixture();
    if(change==='hiddenOnly')f.panes[2]=f.pane('other');
    if(change==='multipleVisible')f.panes[1]=f.pane('target');
    if(change==='extraChild')f.tabs.push({...f.tabs[0]});
    if(change==='mixedMarkers')f.panes[2]=f.pane('target source');
    expect(observe(f.document,f.labels,2,'target',['source']),change).toBe(false);
  }
});


test('shipping live Herdr oracle requires the selected server and exact host snapshot context, never legacy cards',async()=>{
  const observe=await oracle('ownedLiveHerdrNavigation');
  const context='owned-workspace / owned-tab / /owned/cwd';
  const row={querySelector:(selector:string)=>selector==='strong'?{textContent:'codex'}:selector===':scope > small'?{textContent:'Unknown status'}:selector==='span > small'?{textContent:context}:null};
  const panel={getClientRects:()=>[{}],querySelector:(selector:string)=>selector==='select'?{value:'owned-guard'}:selector==='h3'?{textContent:'Live Herdr agents'}:null,querySelectorAll:(selector:string)=>selector==='.herdr-navigation-row'?[row]:[{textContent:'Shared focus changes focus for other connections to this server.'}]};
  let panels=[panel];
  const document={querySelectorAll:(selector:string)=>selector==='.herdr-navigation:not([hidden])'?panels:[{textContent:'legacy codex card'}]};
  expect(observe(document,'owned-guard',context)).toBe(true);
  expect(observe(document,'different-server',context)).toBe(false);
  expect(observe(document,'owned-guard','other-workspace / other-tab / /other/cwd')).toBe(false);
  panels=[];expect(observe(document,'owned-guard',context)).toBe(false);
  panels=[panel,panel];expect(observe(document,'owned-guard',context)).toBe(false);
  panels=[{...panel,getClientRects:()=>[]}];expect(observe(document,'owned-guard',context)).toBe(false);
});

test('owned host context projects only unique validated label/cwd readback and omits private fields',()=>{
  const snapshot={workspaces:[{workspace_id:'w1',label:'owned-workspace',private:'not-exported'}],tabs:[{workspace_id:'w1',tab_id:'w1:t2',label:'owned-tab',private:'not-exported'}],private:'not-exported'};
  const agent={workspaceId:'w1',tabId:'w1:t2',paneId:'w1:p3',terminalId:'owned-terminal'};
  const context=ownedHerdrContext(snapshot,agent,'/owned/cwd','/owned/cwd');
  expect(context).toBe('owned-workspace / owned-tab / /owned/cwd');
  expect(context).not.toContain('not-exported');
  for(const invalid of [{...snapshot,workspaces:[...snapshot.workspaces,...snapshot.workspaces]},{...snapshot,tabs:[...snapshot.tabs,...snapshot.tabs]},{...snapshot,tabs:[{...snapshot.tabs[0],workspace_id:'w2'}]},{...snapshot,workspaces:[{...snapshot.workspaces[0],label:'private\ncontrol'}]}])
    expect(()=>ownedHerdrContext(invalid,agent,'/owned/cwd','/owned/cwd')).toThrow('Owned Herdr navigation context changed');
  expect(()=>ownedHerdrContext(snapshot,agent,'/other/cwd','/owned/cwd')).toThrow('Owned Herdr navigation context changed');
});

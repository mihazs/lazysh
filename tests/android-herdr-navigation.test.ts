import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';

async function oracle() {
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-visible-herdr.js'),'utf8');
  return new Function('getComputedStyle',`${source};return ownedVisibleHerdr;`)((node:{display:string})=>({display:node.display,visibility:'visible'}));
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

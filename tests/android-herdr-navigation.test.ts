import {expect,test} from 'bun:test';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {herdrHistoryFailureStage,HerdrFixture,ownedHerdrContext} from './support/androidHerdr';

async function oracle(name:'ownedVisibleHerdr'|'ownedLiveHerdrNavigation'|'ownedHerdrSwipeGeometry'|'ownedHerdrObserveFinger'|'ownedHerdrFailureMarkers'='ownedVisibleHerdr') {
  const source=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/'+(name.startsWith('ownedHerdr')?'owned-herdr-finger.js':'owned-visible-herdr.js')),'utf8');
  return new Function('getComputedStyle',`${source};return ${name};`)((node:{display:string;visibility?:string})=>({display:node.display,visibility:node.visibility??'visible'}));
}
test('history failure marker projection separates clipped rows and other descendants without retaining text',async()=>{
  const observe=await oracle('ownedHerdrFailureMarkers');
  const rect=(top:number,bottom:number)=>({left:0,right:100,top,bottom});
  const row=(textContent:string,top:number,bottom:number)=>({textContent,getBoundingClientRect:()=>rect(top,bottom)});
  const bounds={getBoundingClientRect:()=>rect(0,100)};
  const screen={...bounds,closest:()=>bounds,parentElement:{querySelector:()=>bounds},
    querySelectorAll:()=>[row('OLD500 private',0,20),row('NEW512 private',100,120)],
    children:[{classList:{contains:()=>true},textContent:'OLD500 NEW512'},
      {classList:{contains:()=>false},textContent:'NEW512 secret'}]};
  const viewport={offsetLeft:0,offsetTop:0,width:100,height:100};
  expect(observe([screen],viewport)).toEqual({screens:'one',state:'observed',
    old:{rows:'intersecting',other:false},newest:{rows:'clipped',other:true}});
  expect(observe([],viewport)).toEqual({screens:'zero'});
  expect(observe([screen,screen],viewport)).toEqual({screens:'many'});
  expect(observe([screen],null)).toEqual({screens:'one',state:'unavailable'});
});
function fixture() {
  const labels=['source','source / owned-guard','source / owned-guard / owned-guard'];
  const tabs=labels.map((textContent,index)=>({textContent,querySelector:():object|null=>null,getAttribute:()=>index===2?'true':'false'}));
  const screen=(textContent:string,display='flex')=>({textContent,display,getClientRects:()=>display==='none'?[]:[{}],getBoundingClientRect:()=>({width:100,height:100})});
  const pane=(text:string,display='flex')=>({...screen('',display),querySelectorAll:()=>[screen(text)]});
  const panes=[pane('source','none'),pane('target','none'),pane('target')];
  const blockers:ReturnType<typeof screen>[]=[];
  const document={querySelectorAll:(selector:string)=>selector==='.terminal-pane'?panes:selector==='[role=dialog], main[inert]'?blockers:tabs};
  return {document,labels,tabs,panes,pane,blockers,screen};
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


test('a modal or inert foreground cannot qualify a covered terminal marker',async()=>{
  const observe=await oracle(),f=fixture();
  f.blockers.push(f.screen('owned workspace tools'));
  expect(observe(f.document,f.labels,2,'target',['source'])).toBe(false);
  f.blockers[0]=f.screen('closed dialog','none');
  expect(observe(f.document,f.labels,2,'target',['source'])).toBe(true);
  f.blockers[0]=f.screen('inert workspace');
  expect(observe(f.document,f.labels,2,'target',['source'])).toBe(false);
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

test('CI actually invokes the stock two-display native case through its own uncached task',async()=>{
  const root=join(import.meta.dir,'..');
  const workflow=Bun.YAML.parse(await readFile(join(root,'.github/workflows/checks.yml'),'utf8')) as any;
  const client=JSON.parse(await readFile(join(root,'apps/client/package.json'),'utf8'));
  const turbo=JSON.parse(await readFile(join(root,'turbo.json'),'utf8'));
  const source=await readFile(join(root,'tests/android-ssh-host.test.ts'),'utf8');
  const names=[...source.matchAll(/\('([^']*actual Android two-display stock Herdr navigation[^']*)',async/g)];
  expect(names).toHaveLength(1);
  const name=names[0][1];
  const script=client.scripts['test:android-herdr-navigation'];
  expect(script).toBeDefined();
  expect(script).toStartWith('LAZYSH_ANDROID_UI_HERDR_NAVIGATION=1 bun test ');
  expect(script).toContain(`--test-name-pattern '^${name}$'`);
  expect(script).not.toContain('--pass-with-no-tests');
  const task=turbo.tasks['test:android-herdr-navigation'];
  expect(task.cache).toBe(false);expect(task.dependsOn).toEqual(['build:android:emulator']);
  expect(task.passThroughEnv).not.toContain('LAZYSH_ANDROID_UI_HERDR');
  const job=workflow.jobs['native-android-herdr-navigation'];
  expect(job.needs).toEqual(['changes','herdr-native']);expect(job['timeout-minutes']).toBe(30);
  expect(job.env.LAZYSH_ANDROID_RUNTIME_OWNER).toBe('herdr-navigation');
  const download=job.steps.find((step:any)=>step.uses==='actions/download-artifact@v4');
  expect(download.with['artifact-ids']).toBe('${{ needs.herdr-native.outputs.stock-id }}');
  const emulator=job.steps.find((step:any)=>step.uses?.startsWith('mihazs/lazysh-android-emulator-runner@'));
  expect(emulator.with.script).toContain('bun run test:android-herdr-navigation');
  expect(emulator.with.script).toContain('Unknown Android runtime owner');
  expect(job.steps.find((step:any)=>step.name==='Verify same-run stock Herdr').env.STOCK_HERDR_SHA256).toBe('${{ needs.herdr-native.outputs.stock-sha256 }}');
});

test('the shared emulator wrapper rejects unknown owners and all exact command bodies parse without execution',async()=>{
  const workflow=Bun.YAML.parse(await readFile(join(import.meta.dir,'../.github/workflows/checks.yml'),'utf8')) as any;
  const guarded=workflow.jobs['native-android-runtime'],stock=workflow.jobs['native-android-herdr-navigation'];
  expect(guarded.env.LAZYSH_ANDROID_RUNTIME_OWNER).toBe('guarded');
  const action=(job:any)=>job.steps.find((step:any)=>step.uses?.startsWith('mihazs/lazysh-android-emulator-runner@'));
  const script=action(stock).with.script;
  expect(script).toBe(action(guarded).with.script);
  const auxiliary=workflow.jobs['native-android-auxiliary'];
  expect(auxiliary.env.LAZYSH_ANDROID_RUNTIME_OWNER).toBe('auxiliary');
  expect(script).toBe(action(auxiliary).with.script);
  expect(script).toContain('mosh) bun run test:android-mosh; exit $? ;;');
  expect(script).toContain('guarded) bun run test:android-ssh; exit $? ;;');
  expect(script).toContain('bun run test:android-fdroid;');
  const body=script.slice("bash -c '".length,-1);
  const syntax=Bun.spawn(['bash','-n'],{stdin:Buffer.from(body),stdout:'pipe',stderr:'pipe'});
  expect(await syntax.exited).toBe(0);
  const selector=/case "\$LAZYSH_ANDROID_RUNTIME_OWNER" in[\s\S]*?esac;/.exec(body)?.[0];
  expect(selector).toBeDefined();
  for(const owner of ['unknown','']){
    const child=Bun.spawn(['bash','-c',selector!],{env:{...process.env,LAZYSH_ANDROID_RUNTIME_OWNER:owner},stdout:'pipe',stderr:'pipe'});
    expect(await child.exited).toBe(1);
    expect(await new Response(child.stderr).text()).toBe('Unknown Android runtime owner\n');
  }
});

function swipeGeometryFixture(){
  const rect={left:10,top:20,right:200,bottom:300,width:190,height:280};
  const rowState={height:'20px',lineHeight:'20px',count:14,connected:true,foreign:false,throws:false};
  const canvas={isConnected:true,get ownerDocument(){return document;},getBoundingClientRect:()=>rect};
  const surface={getClientRects:()=>[{}],getBoundingClientRect:()=>rect,scrollTop:0,scrollHeight:432,clientHeight:432};
  const terminal={classList:{contains:()=>true},parentElement:canvas,querySelectorAll:()=>[surface],querySelector:()=>surface};
  let rows:ReturnType<typeof createRow>[]=[];
  function createRow(index:number){return {
    get isConnected(){return rowState.connected;},get ownerDocument(){return rowState.foreign?{}:document;},closest:()=>screen,
    style:{get height(){if(rowState.throws)throw Error('private row failure');return rowState.height;},get lineHeight(){return rowState.lineHeight;}},
    getBoundingClientRect:()=>{const height=parseFloat(rowState.height),top=rect.top+index*height;return {...rect,top,bottom:top+height,height};},
  };}
  const screen={parentElement:terminal,closest:()=>canvas,isConnected:true,get ownerDocument(){return document;},textContent:'OLD500',
    getBoundingClientRect:()=>rect,contains:(node:unknown)=>node===screen||rows.includes(node as never),
    querySelectorAll:()=>{rows=Array.from({length:rowState.count},(_,index)=>createRow(index));return rows;}};
  const document={elementFromPoint:()=>screen};
  const viewport={offsetLeft:0,offsetTop:0,width:411,height:800,scale:1};
  return {rect,rowState,canvas,surface,terminal,screen,viewport,document};
}
test('native swipe geometry exposes the finite first unavailable stage instead of conflating empty hit results',async()=>{
  const geometry=await oracle('ownedHerdrSwipeGeometry'),f=swipeGeometryFixture();
  expect(geometry([],f.viewport,2.625,f.document).diagnostic).toMatchObject({stage:'screen-count',screenCount:0});
  expect(geometry([f.screen],null,2.625,f.document).diagnostic).toMatchObject({stage:'viewport',screenCount:1,hasViewport:false});
  expect(geometry([f.screen],{...f.viewport,scale:2},2.625,f.document).diagnostic).toMatchObject({stage:'scale',scale:2});
  expect(geometry([f.screen],f.viewport,2.625,f.document).diagnostic.stage).toBe('ready');
});

test('native geometry identifies structure, surface, bounds and hit failures without exporting DOM data',async()=>{
  const geometry=await oracle('ownedHerdrSwipeGeometry');
  const run=(change:(f:ReturnType<typeof swipeGeometryFixture>)=>void)=>{const f=swipeGeometryFixture();change(f);return geometry([f.screen],f.viewport,2.625,f.document);};
  expect(run(f=>{f.screen.parentElement=null as never;}).diagnostic.stage).toBe('structure');
  expect(run(f=>{f.terminal.querySelectorAll=()=>[];}).diagnostic.stage).toBe('surface-count');
  expect(run(f=>{f.terminal.querySelectorAll=()=>Array(20).fill(f.surface);}).diagnostic.surfaceCount).toBe(8);
  expect(run(f=>{f.surface.getClientRects=()=>[];}).diagnostic.stage).toBe('surface-hidden');
  const bounds=run(f=>{f.rect.right=Infinity;});
  expect(bounds.ready).toBe(false);expect(bounds.diagnostic.stage).toBe('bounds');
  expect(bounds.diagnostic.screenRect[2]).toBe(-1);
  const hit=run(f=>{f.document.elementFromPoint=()=>({textContent:'private output',id:'secret'} as never);});
  expect(hit.diagnostic.stage).toBe('hits');expect(hit.diagnostic.hits).toEqual(['other','other','other']);
  expect(JSON.stringify(hit.diagnostic)).not.toMatch(/private|secret|textContent/);
});

test('gesture qualification uses current public cells after bootstrap expansion, never cached row ratios',async()=>{
  const geometry=await oracle('ownedHerdrSwipeGeometry'),f=swipeGeometryFixture();
  Object.assign(f.rect,{height:144,bottom:164});Object.assign(f.rowState,{height:'24px',lineHeight:'24px',count:6});
  const bootstrap=geometry([f.screen],f.viewport,2.625,f.document);
  expect(bootstrap.ready).toBe(true);
  // Surface bootstrap remains possible while its quarter-point is still header chrome.
  expect(geometry([f.screen],f.viewport,2.625,f.document,true).ready).toBe(false);
  Object.assign(f.rect,{height:432,bottom:452});f.rowState.count=18;
  const current=geometry([f.screen],f.viewport,2.625,f.document,true);
  expect(current).toMatchObject({ready:true,rowHeight:24,rowCount:18,originRow:4});
  expect(bootstrap.rect[1]+(bootstrap.rect[3]-bootstrap.rect[1])/4).toBe(56);
  expect(current.rect[1]+(current.rect[3]-current.rect[1])/4).toBe(128);
  expect(current.rect).not.toEqual(bootstrap.rect);
});

test.each(['missing','unitless','nonfinite','oversized','line-height','foreign','disconnected','throwing','origin-beyond-rows'] as const)('gesture qualification fails closed on %s public rows',async invalid=>{
  const geometry=await oracle('ownedHerdrSwipeGeometry'),f=swipeGeometryFixture();
  if(invalid==='missing')f.rowState.count=0;
  if(invalid==='unitless')f.rowState.height='20';
  if(invalid==='nonfinite')f.rowState.height='NaNpx';
  if(invalid==='oversized')f.rowState.height=f.rowState.lineHeight='33px';
  if(invalid==='line-height')f.rowState.lineHeight='21px';
  if(invalid==='foreign')f.rowState.foreign=true;
  if(invalid==='disconnected')f.rowState.connected=false;
  if(invalid==='throwing')f.rowState.throws=true;
  // Valid 1px cells put the quarter-point (70px into a 280px screen) at row 70, beyond the 14 rendered rows.
  if(invalid==='origin-beyond-rows')f.rowState.height=f.rowState.lineHeight='1px';
  const result=geometry([f.screen],f.viewport,2.625,f.document,true);
  expect(result.ready).toBe(false);
  expect(result.diagnostic.stage).toBe(invalid==='origin-beyond-rows'?'row-origin':'row-metrics');expect(JSON.stringify(result)).not.toMatch(/private|NaNpx/);
});

test.each(['unchanged','changed','metrics','row-count','foreign','disconnected','unavailable'] as const)('calibrated first DOWN keeps its original geometry or retires on %s landing',async state=>{
  const f=swipeGeometryFixture();
  const asset=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/assets/owned-herdr-finger.js'),'utf8');
  const kotlin=await readFile(join(import.meta.dir,'../apps/client/src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt'),'utf8');
  const wrapper=kotlin.match(/val fingerObservation = """([\s\S]*?)"""\.trimIndent\(\)/)![1].replaceAll('$fingerScript',asset).replaceAll('$screens','[screen]').replaceAll('$fingerKey',JSON.stringify('bound'));
  const hooks=new Map<string,(event:any)=>void>(),globalHooks=new Map<string,(event:any)=>void>();
  Object.assign(f.canvas,{contains:(node:unknown)=>node===f.screen||node===f.surface,
    addEventListener:(name:string,callback:(event:any)=>void)=>hooks.set(name,callback),removeEventListener:(name:string)=>hooks.delete(name)});
  const window:Record<string,any>={addEventListener:(name:string,callback:(event:any)=>void)=>globalHooks.set(name,callback),removeEventListener:(name:string)=>globalHooks.delete(name)};
  window.visualViewport=f.viewport;
  const installation=new Function('window','document','devicePixelRatio','screen','getComputedStyle',`return (${wrapper})`)(window,f.document,2.625,f.screen,()=>({visibility:'visible'}));
  expect(installation).toMatchObject({installed:true,geometry:{ready:true,rowHeight:20,rowCount:14,originRow:3}});
  if(state==='changed'){f.rect.height+=20;f.rect.bottom+=20;}
  if(state==='metrics')f.rowState.height=f.rowState.lineHeight='24px';
  if(state==='row-count')f.rowState.count=15;
  if(state==='foreign')f.document.elementFromPoint=()=>({} as never);
  if(state==='disconnected')f.screen.isConnected=false;
  if(state==='unavailable')f.screen.getBoundingClientRect=()=>{throw Error('private layout failure');};
  globalHooks.get('pointerdown')!({type:'pointerdown',isTrusted:true,eventPhase:1,target:f.screen,pointerId:7,clientX:105,clientY:90});
  hooks.get('touchstart')!({type:'touchstart',isTrusted:true,target:f.screen,touches:[{identifier:7}]});
  const sample=window.bound.sample();
  expect(sample.active).toBe(state==='unchanged');expect(sample.bindingRejected).toBe(state!=='unchanged');
  expect(JSON.stringify(sample)).not.toContain('private');
  window.bound.dispose();expect(hooks.size).toBe(0);expect(globalHooks.size).toBe(0);
});

test('passive finger observer keeps exact touch identity while bounding wheel observations and removing every listener',async()=>{
  const observe=await oracle('ownedHerdrObserveFinger');
  const listeners=new Map<string,(event:any)=>void>(),options:unknown[]=[];
  const canvas={contains:()=>true,addEventListener:(type:string,handler:(event:any)=>void,option:unknown)=>{listeners.set(type,handler);options.push(option);},
    removeEventListener:(type:string,handler:unknown,capture:boolean)=>{expect(listeners.get(type)).toBe(handler);expect(capture).toBe(true);listeners.delete(type);}};
  const globalListeners=new Map<string,(event:any)=>void>();
  const surface={scrollTop:0,scrollHeight:432,clientHeight:432},textarea={},terminal={classList:{contains:()=>true},querySelector:(selector:string)=>selector==='.xterm-viewport'?surface:textarea};
  const screen={closest:()=>canvas,parentElement:terminal,textContent:'OLD500',isConnected:true,
    querySelectorAll:()=>({length:24}),getBoundingClientRect:()=>({height:432})},window:Record<string,any>={
    addEventListener:(type:string,handler:(event:any)=>void,option:unknown)=>{expect(option).toEqual({capture:true,passive:true});globalListeners.set(type,handler);},
    removeEventListener:(type:string,handler:unknown,capture:boolean)=>{expect(globalListeners.get(type)).toBe(handler);expect(capture).toBe(true);globalListeners.delete(type);}};
  expect(observe(window,'owned',[screen])).toBe(true);
  expect(observe(window,'owned',[screen])).toBe(false);
  expect(options).toEqual(Array(5).fill({capture:true,passive:true}));
  const globalEvent=(type:string,extra:Record<string,unknown>={})=>globalListeners.get(type)!({type,isTrusted:true,eventPhase:1,target:screen,pointerId:9,clientX:50,clientY:100,getCoalescedEvents:()=>[],...extra});
  globalEvent('pointerdown');globalEvent('pointermove',{cancelable:true,defaultPrevented:true,getCoalescedEvents:()=>Array(40).fill({})});
  // Global delivery alone cannot satisfy the unchanged canvas touch/MOVE oracle.
  expect(window.owned.sample()).toMatchObject({moves:0,active:true,held:false});
  const touch=(type:string,identifier=7)=>listeners.get(type)!({type,isTrusted:true,target:screen,touches:[{identifier}]});
  touch('touchstart');touch('touchmove');touch('touchmove');
  listeners.get('wheel')!({deltaMode:1,deltaY:-5,clientX:199,clientY:206});
  listeners.get('wheel')!({deltaMode:99,deltaY:-1e20,clientX:Infinity,clientY:-1e20});
  for(let i=0;i<80;i++)listeners.get('wheel')!({deltaMode:0,deltaY:-165});
  listeners.get('wheel')!({deltaY:165});listeners.get('wheel')!({deltaY:0});listeners.get('wheel')!({deltaY:NaN});
  expect(window.owned.sample()).toMatchObject({row:500,newest:false,active:true,held:true,moves:2,wheels:64,wheelUp:64,wheelDown:1,wheelZero:1,wheelInvalid:1});
  expect(window.owned.sample().global).toMatchObject({state:'observed',overflow:false});
  touch('touchmove',8);expect(window.owned.sample().active).toBe(false);
  screen.textContent='OLD999 NEW512';expect(window.owned.sample()).toMatchObject({row:999,newest:true});
  expect(window.owned.sample().baseline).toEqual({row:500,newest:false,visual:{state:'observed',mouseTrackingMode:'unknown',activeBuffer:'unknown',
    mouseCaptureClass:true,renderedRows:24,rowsClamped:false,screenHeight:432,viewport:{top:0,height:432,client:432}}});
  expect(window.owned.sample().wheelRecords).toHaveLength(8);
  expect(window.owned.sample().wheelRecordsOverflow).toBe(true);
  expect(window.owned.sample().wheelRecords.slice(0,2)).toEqual([
    {mode:1,deltaY:-5,point:[199,206]},{mode:'unavailable',deltaY:-65535,point:[null,-65535]},
  ]);
  surface.scrollTop=NaN;
  expect(window.owned.sample().visual).toEqual({state:'unavailable',mouseTrackingMode:'unknown',activeBuffer:'unknown'});
  expect(window.owned.sample().baseline.visual.state).toBe('observed');
  const before=window.owned.sample();globalEvent('touchmove',{changedTouches:[{identifier:4,clientX:NaN,clientY:Infinity}]});
  expect(window.owned.sample().moves).toBe(before.moves);
  expect(window.owned.sample().global.events[1]).toMatchObject({type:'pointermove',target:'screen',trusted:true,cancelable:true,defaultPrevented:true,phase:1,identityMatches:true,coalescedCount:8,point:[50,100]});
  expect(window.owned.sample().global.events[2]).toMatchObject({point:[null,null],identityMatches:false});
  expect(window.owned.sample().global.events[0]).toMatchObject({cancelable:false,defaultPrevented:false});
  globalEvent('lostpointercapture',{target:{id:'private-session-id',textContent:'private terminal output'},clientX:1e9,clientY:-1e9,eventPhase:99});
  expect(window.owned.sample().global.events[3]).toMatchObject({target:'other',point:[65535,-65535],phase:-1});
  expect(JSON.stringify(window.owned.sample().global)).not.toMatch(/private|session-id|terminal output/);
  for(const [target,kind] of [[canvas,'canvas'],[terminal,'terminal'],[surface,'viewport'],[textarea,'textarea'],[null,'none']] as const){
    globalEvent('pointercancel',{target});expect(window.owned.sample().global.events.at(-1).target).toBe(kind);
  }
  globalEvent('pointermove',{getCoalescedEvents:()=>{throw new Error('private observer failure');}});
  expect(window.owned.sample().global.state).toBe('unavailable');expect(window.owned.sample().moves).toBe(before.moves);
  for(let i=0;i<30;i++)globalEvent('pointermove');
  expect(window.owned.sample().global.events).toHaveLength(24);expect(window.owned.sample().global.overflow).toBe(true);
  window.owned.dispose();expect(listeners.size).toBe(0);expect(globalListeners.size).toBe(0);
});

test('failure history projects only bounded owned readback and focus booleans and redacts observation errors',async()=>{
  const fixture=Object.create(HerdrFixture.prototype) as HerdrFixture;
  Object.assign(fixture,{historyPane:{paneId:'owned-history'},agent:{paneId:'owned-original'},
    history:async(...args:unknown[])=>{expect(args).toEqual([]);return {offset:1,max:512,rows:30,oldRows:29,newTail:false,text:'private output'};},
    run:async(args:string[])=>{expect(args).toEqual(['api','snapshot']);return JSON.stringify({result:{snapshot:{focused_pane_id:'owned-history',private:'secret'}}});}});
  expect(await fixture.historyDiagnostic()).toEqual({scope:'post-instrumentation-pre-host-stop',state:'available',offset:1,max:512,rows:30,oldRows:29,newTail:false,focusHistory:true,focusOriginal:false});
  Object.assign(fixture,{history:async()=>{throw new Error('private host/path/output');}});
  expect(await fixture.historyDiagnostic()).toEqual({scope:'post-instrumentation-pre-host-stop',state:'unavailable',stage:'unknown'});
  const errors=[['Owned history unavailable','server-or-history-identity'],['Owned history request invalid','history-identity'],
    ['Owned history socket identity invalid','socket-identity'],['Owned history socket unavailable','socket-unavailable'],
    ['Owned history API failed','history-reply'],['Owned history observation invalid','history-validation'],
    ['Owned receiver output missing','receiver-output'],['Owned receiver bytes differ','receiver-bytes'],
    ['Owned receiver identity changed','receiver-identity']] as const;
  for(const [message,stage] of errors){
    expect(herdrHistoryFailureStage(new Error(message))).toBe(stage);
    Object.assign(fixture,{history:async()=>{throw new Error(message);}});
    expect(await fixture.historyDiagnostic()).toEqual({scope:'post-instrumentation-pre-host-stop',state:'unavailable',stage});
  }
  for(const value of [{message:'Owned history unavailable'},new Proxy(new Error(),{get(){throw new Error('private');}})])
    expect(herdrHistoryFailureStage(value)).toBe('unknown');
  Object.assign(fixture,{history:async()=>({offset:8,max:512,rows:23,oldRows:23,newTail:false})});
  for(const focused of [null,'','private\ntext','x'.repeat(129)]){
    Object.assign(fixture,{run:async()=>JSON.stringify({result:{snapshot:{focused_pane_id:focused}}})});
    expect(await fixture.historyDiagnostic()).toEqual({scope:'post-instrumentation-pre-host-stop',state:'unavailable',stage:'focus-read'});
  }
  Object.assign(fixture,{run:async()=>{throw new Error('private focus error');}});
  expect(await fixture.historyDiagnostic()).toEqual({scope:'post-instrumentation-pre-host-stop',state:'unavailable',stage:'focus-read'});
});


test('actual owned mouse recognizer accepts only six exact chunked controls and discards private frames',async()=>{
  const source=await readFile(join(import.meta.dir,'android-ssh-host.test.ts'),'utf8');
  const block=source.split('// Begin closed capture recognizer:')[1]?.split('// End closed capture recognizer.')[0];
  expect(block).toBeDefined();
  const compiled=new Bun.Transpiler({loader:'ts'}).transformSync(block!.slice(block!.indexOf('const capture=')));
  const setup=()=>new Function('Buffer',`${compiled};return capture;`)(Buffer);
  const empty={state:'unknown',normal:null,drag:null,motion:null};
  for(const [mode,index] of [[1000,'normal'],[1002,'drag'],[1003,'motion']] as const){
    for(const enabled of [true,false]){
      const value=`\x1b[?${mode}${enabled?'h':'l'}`;
      for(let cut=0;cut<=value.length;cut++){
        const capture=setup();capture.write(Buffer.from(value.slice(0,cut)));capture.write(Buffer.from(value.slice(cut)));
        expect(capture.sample()).toEqual({...empty,state:'observed',[index]:enabled});
        expect(capture.enabled()).toBe(enabled);
      }
    }
  }
  const capture=setup();
  capture.write(Buffer.from('\x1eLAZYSH-GUARD-1:00000080:'+JSON.stringify({boot:'private-boot',ticket:'private-ticket'})+'\x1f'));
  capture.write(Buffer.from('\x1b[?1000X\x1b[?9999h\x1b[?1000;1002h'));
  expect(capture.sample()).toEqual(empty);expect(capture.enabled()).toBe(false);
  capture.write(Buffer.from('\x1b[?100'));capture.write(Buffer.from('private-reset'));capture.write(Buffer.from('0h'));
  expect(capture.sample()).toEqual(empty);
  for(const byte of Buffer.from('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1000l\x1b[?1002l\x1b[?1003l'))capture.write(Buffer.from([byte]));
  expect(capture.sample()).toEqual({state:'observed',normal:false,drag:false,motion:false});expect(capture.enabled()).toBe(false);
  expect(JSON.stringify(capture.sample())).not.toMatch(/private|ticket|boot/);
  capture.write('unexpected-string-chunk');
  expect(capture.sample().state).toBe('unavailable');expect(capture.enabled()).toBe(false);
});

function landingFixture() {
  const global=new Map<string,(event:any)=>void>();let hit:unknown,reads=0;
  const rect={left:2,top:98,right:397,bottom:243,height:145};
  const canvas={isConnected:true,contains:(node:unknown)=>node===screen||node===canvas,addEventListener:()=>{},removeEventListener:()=>{},getBoundingClientRect:()=>rect};
  const document={elementFromPoint:(x:number,y:number)=>{expect([x,y]).toEqual([199,134]);reads++;return hit;}};
  const screen={isConnected:true,closest:()=>canvas,textContent:'OLD496 NEW512',ownerDocument:document,getBoundingClientRect:()=>rect};
  hit=screen;
  const window:Record<string,any>={addEventListener:(name:string,callback:any)=>global.set(name,callback),removeEventListener:(name:string)=>global.delete(name)};
  const event=(type:string,target:unknown=screen,isTrusted=true)=>global.get(type)!({type,target,isTrusted,clientX:199,clientY:134,pointerId:0,eventPhase:1,changedTouches:[{identifier:0,clientX:199,clientY:134}],touches:[{identifier:0,clientX:199,clientY:134}],preventDefault:()=>{throw Error('observer must remain passive');}});
  return {global,rect,canvas,screen,document,window,event,setHit:(value:unknown)=>{hit=value;},reads:()=>reads};
}

test('first trusted finger landing observes current bounds and hit ownership once without admitting a gesture',async()=>{
  const observe=await oracle('ownedHerdrObserveFinger'),f=landingFixture();
  expect(observe(f.window,'owned',[f.screen])).toBe(true);
  f.event('pointerdown',f.screen,false);
  expect(f.window.owned.sample().global.landing).toBeNull();
  f.rect.top=300;f.rect.bottom=670;
  const other={textContent:'private terminal text',id:'private-id',className:'private-class'};
  f.setHit(other);f.event('pointerdown',other);
  const landing=f.window.owned.sample().global.landing;
  expect(landing).toEqual({state:'observed',screenConnected:true,canvasConnected:true,screenRect:[2,300,397,670],canvasRect:[2,300,397,670],point:[199,134],target:'other',targetOwned:false,hit:'other',hitOwned:false});
  for(const name of ['pointermove','touchstart','pointerdown'])f.event(name);
  expect(f.reads()).toBe(1);expect(f.window.owned.sample().global.landing).toEqual(landing);
  expect(f.window.owned.sample()).toMatchObject({moves:0,wheels:0,active:true,held:false});
  expect(JSON.stringify(landing)).not.toMatch(/private|textContent|className/);
  f.window.owned.dispose();expect(f.global.size).toBe(0);
});

test.each(['owned','fallback','no-hit','disconnected','missing','throwing','invalid','invalid-owner','clamped'])('finger landing keeps closed %s observations and never changes the canvas oracle',async mode=>{
  const observe=await oracle('ownedHerdrObserveFinger'),f=landingFixture();
  if(mode==='no-hit')f.setHit(null);
  if(mode==='disconnected'){f.screen.isConnected=false;f.canvas.isConnected=false;}
  if(mode==='missing')f.screen.ownerDocument=undefined as never;
  if(mode==='throwing')f.document.elementFromPoint=()=>{throw Error('private error URL/token');};
  if(mode==='invalid')f.rect.right=NaN;
  if(mode==='invalid-owner')f.canvas.contains=()=> 'private-owner-result' as never;
  if(mode==='clamped')f.rect.right=1e9;
  expect(observe(f.window,'owned',[f.screen])).toBe(true);f.event(mode==='fallback'?'touchstart':'pointerdown');
  const landing=f.window.owned.sample().global.landing;
  if(['missing','throwing','invalid','invalid-owner'].includes(mode))expect(landing).toEqual({state:'unavailable',screenConnected:null,canvasConnected:null,screenRect:null,canvasRect:null,point:null,target:'unknown',targetOwned:null,hit:'unknown',hitOwned:null});
  else expect(landing).toMatchObject({state:'observed',screenConnected:mode!=='disconnected',canvasConnected:mode!=='disconnected',target:'screen',targetOwned:true,hit:mode==='no-hit'?'none':'screen',hitOwned:mode!=='no-hit',screenRect:[2,98,mode==='clamped'?65535:397,243]});
  expect(JSON.stringify(landing)).not.toMatch(/private|URL|token/);
  expect(f.window.owned.sample()).toMatchObject({moves:0,wheels:0,held:false,active:mode!=='disconnected'});
  f.window.owned.dispose();expect(f.global.size).toBe(0);
});

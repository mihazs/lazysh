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
  expect(job.needs).toBe('herdr-native');expect(job['timeout-minutes']).toBe(30);
  expect(job.env.LAZYSH_ANDROID_RUNTIME_OWNER).toBe('herdr-navigation');
  const download=job.steps.find((step:any)=>step.uses==='actions/download-artifact@v4');
  expect(download.with.name).toBe('stock-herdr-${{ github.run_id }}-${{ github.run_attempt }}');
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
  expect(script).toContain('bun run test:android-mosh && bun run test:android-ssh;');
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

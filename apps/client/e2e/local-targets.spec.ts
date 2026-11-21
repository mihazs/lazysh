import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {workspaceControl} from './fixtures/workspaceControl';

declare global { interface Window { localConnects:Record<string,unknown>[] } }
const key='lazysh.workspace.v1';
const hostTools={files:true,repository:true};
// What a Windows desktop reports: the default shell, PowerShell, Git Bash and one WSL distribution.
const targets=[
  {id:'default',label:'cmd',kind:'windows',tools:hostTools},
  {id:'pwsh',label:'PowerShell',kind:'windows',tools:hostTools},
  {id:'gitbash',label:'Git Bash',kind:'windows',tools:hostTools},
  // Ubuntu has no git, so it reports no host tools; Debian starts git inside the distribution.
  {id:'wsl:Ubuntu',label:'Ubuntu (WSL)',kind:'wsl',tools:{files:false,repository:false}},
  {id:'wsl:Debian',label:'Debian (WSL)',kind:'wsl',tools:hostTools},
];

async function start(page:Page,saved?:unknown[],capabilityTargets=targets) {
  await installNativeBridge(page);
  await page.addInitScript(({targets,saved,key})=>{
    // Seed only the first launch; a reload keeps what the app itself saved.
    if(saved && !sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem(key,JSON.stringify(saved));}
    window.localConnects=[];
    const replies:Record<string,unknown>={
      list_hosts:[],
      local_capability:{available:true,reason:'Synthetic local fixture; no shell runs.',targets},
      account_usage:{schemaVersion:1,state:'unavailable',source:null,report:null},
      agent_snapshot:{schemaVersion:1,sessions:[]},
      apple_status_capability:{available:false,reason:'Synthetic local fixture'},
    };
    window.nativeFixtureInvoke=async(command,args={})=>{
      if(command==='local_connect'){window.localConnects.push(args);return {sessionId:`local:12345678-1234-4234-8234-12345678900${window.localConnects.length}`};}
      if(command in replies)return replies[command];
      if(command.startsWith('plugin:event|')||command.startsWith('local_'))return;
      throw new Error(`Unexpected local fixture command: ${command}`);
    };
  },{targets:capabilityTargets,saved,key});
  await page.goto('/');
  if(test.info().project.name==='phone' && !saved)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
}
const picker=(page:Page)=>page.getByRole('combobox',{name:'Local terminal target',exact:true});
// The event channel is the bridge's own object; the rest is what the renderer asked for.
const connects=(page:Page)=>page.evaluate(()=>window.localConnects.map(({events:_events,...request})=>request));
const saved=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)??'null'),key);
async function open(page:Page) {
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.getByText('Local PTY')).toBeVisible();
}

test('the picker offers every reported target and a chosen one is what the terminal opens',async({page})=>{
  await start(page);
  await expect(picker(page).getByRole('option')).toHaveText(['cmd','PowerShell','Git Bash','Ubuntu (WSL)','Debian (WSL)']);
  await expect(picker(page)).toHaveValue('default');
  await picker(page).selectOption('pwsh');
  await open(page);
  expect(await connects(page)).toEqual([{cols:100,rows:30,target:'pwsh'}]);
  await expect(page.getByText('This device · PowerShell',{exact:true}).first()).toBeAttached();
});

test('the default target opens as before, with no target in the request',async({page})=>{
  await start(page);
  await open(page);
  expect(await connects(page)).toEqual([{cols:100,rows:30}]);
  expect(await saved(page)).toEqual([{local:true}]);
});

test('a single reported target shows no picker',async({page})=>{
  await start(page,undefined,targets.slice(0,1));
  await expect(page.getByRole('button',{name:'Open local terminal',exact:true})).toBeVisible();
  await expect(picker(page)).toHaveCount(0);
});

test('a WSL distribution that reports no host tools hides Files and Diff',async({page})=>{
  await start(page);
  await picker(page).selectOption('wsl:Ubuntu');
  await open(page);
  // The workspace tools are shown (Dictate is a local tool); Files and Diff are not among them.
  await workspaceControl(page,'Dictate');
  for(const name of ['Files','Diff'])await expect(page.getByRole('button',{name,exact:true})).toHaveCount(0);
  expect(await connects(page)).toEqual([{cols:100,rows:30,target:'wsl:Ubuntu'}]);
});

test('a WSL distribution that reports files and repository shows Files and Diff',async({page})=>{
  await start(page);
  await picker(page).selectOption('wsl:Debian');
  await open(page);
  await workspaceControl(page,'Files');
  await workspaceControl(page,'Diff');
  expect(await connects(page)).toEqual([{cols:100,rows:30,target:'wsl:Debian'}]);
  await expect(page.getByText('This device · Debian (WSL)',{exact:true}).first()).toBeAttached();
});

test('a PowerShell session keeps Files and Diff',async({page})=>{
  await start(page);
  await picker(page).selectOption('pwsh');
  await open(page);
  await workspaceControl(page,'Files');
  await workspaceControl(page,'Diff');
});

test('each local session saves its own target and relaunch restores it',async({page})=>{
  await start(page,[{local:true,target:'wsl:Ubuntu'},{local:true},{local:true,target:'gitbash'}]);
  await page.getByRole('button',{name:'Restore previous workspace',exact:true}).first().click();
  await expect.poll(async()=>(await connects(page)).length).toBe(3);
  expect(await connects(page)).toEqual([{cols:100,rows:30,target:'wsl:Ubuntu'},{cols:100,rows:30},{cols:100,rows:30,target:'gitbash'}]);
  expect(await saved(page)).toEqual([{local:true,target:'wsl:Ubuntu'},{local:true},{local:true,target:'gitbash'}]);
});

test('a saved target that is not a target id is discarded instead of reaching the native side',async({page})=>{
  await start(page,[{local:true,target:'C:\\Windows\\System32\\cmd.exe'},{local:true,target:'wsl:-d'},{local:true,extra:1}]);
  expect(await connects(page)).toEqual([]);
  await expect(page.getByRole('button',{name:'Restore previous workspace',exact:true})).toHaveCount(0);
});

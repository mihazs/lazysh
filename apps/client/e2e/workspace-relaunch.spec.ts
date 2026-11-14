import { installNativeBridge } from './fixtures/nativeBridge';
import { expect, test, type Page } from '@playwright/test';

type Call = {command:string;args:Record<string,unknown>};
declare global { interface Window { relaunchCalls: Call[] } }

const key='lazysh.workspace.v1';
// Descriptors a previous app process saved: tmux on a named server, Herdr, Zellij and a plain shell.
const previous=[
  {hostId:'box',attached:{kind:'tmux',name:'agents',tmuxServer:'work'}},
  {hostId:'box',attached:{kind:'herdr',name:'fleet'}},
  {hostId:'box',attached:{kind:'zellij',name:'notes'}},
  {hostId:'box'},
];
const remote=['connect','attach_tmux','attach_multiplexer','connect_mosh','connect_et'];

test.beforeEach(async ({ page }) => {
  await installNativeBridge(page);
  await page.addInitScript(({key,previous,remote}) => {
    // Seed only the first launch; every reload keeps what the app itself saved.
    if(!sessionStorage.getItem('relaunch-seeded')){sessionStorage.setItem('relaunch-seeded','1');localStorage.setItem(key,JSON.stringify(previous));}
    window.relaunchCalls=[];
    let sessions=0;
    window.nativeFixtureInvoke=async(command,args={})=>{
      if(command.startsWith('plugin:event|'))return 1;
      if(command==='list_hosts')return [{id:'box',name:'Agent box',hostname:'box.invalid',port:22,username:'dev',fingerprint:'SHA256:fixture',credentialsStored:true}];
      if(command==='local_capability')return {available:false,reason:'Relaunch fixture'};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Relaunch fixture'};
      if(command==='multiplexer_tree')return {tools:[{kind:'herdr',version:'0.9.5',support:'full',missing:[]}],sessions:[]};
      window.relaunchCalls.push({command,args});
      if(remote.includes(command))return {sessionId:`native-${++sessions}`};
      if(['resize','ack_output','disconnect'].includes(command))return;
      throw new Error(`Relaunch fixture does not provide ${command}`);
    };
  },{key,previous,remote});
});

const remoteCalls=(page:Page)=>page.evaluate(remote=>window.relaunchCalls.filter(call=>remote.includes(call.command)),remote);
const saved=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key) ?? 'null'),key);
const restoreButton=(page:Page)=>page.locator('.workspace-restore').getByRole('button',{name:'Restore previous workspace',exact:true});

async function relaunchOffer(page:Page) {
  await expect(restoreButton(page)).toBeVisible();
  // The offer alone never connects, attaches or types.
  expect(await remoteCalls(page)).toEqual([]);
  expect(await page.evaluate(()=>window.relaunchCalls.filter(call=>call.command==='write_stdin'))).toEqual([]);
}

test('relaunch offers the previous workspace and reattaches tmux, Herdr and Zellij only after explicit restore',async({page})=>{
  await page.goto('/');
  await relaunchOffer(page);
  await expect(page.locator('.terminal-canvas')).toHaveCount(0);

  await restoreButton(page).click();
  await expect.poll(async()=>(await remoteCalls(page)).length).toBe(7);
  const calls=await remoteCalls(page);
  const connects=calls.filter(call=>call.command==='connect');
  expect(connects).toHaveLength(4);
  for(const {args} of connects) {
    expect(args).toMatchObject({hostId:'box',useSavedCredentials:true});
    // Restoration supplies no credential material of its own.
    expect(Object.keys(args).filter(name=>/password|privateKey|passphrase/i.test(name))).toEqual([]);
  }
  const tmux=calls.find(call=>call.command==='attach_tmux')!.args;
  expect({name:tmux.name,tmuxServer:tmux.tmuxServer}).toEqual({name:'agents',tmuxServer:'work'});
  const multiplexers=calls.filter(call=>call.command==='attach_multiplexer').map(({args})=>({kind:args.kind,name:args.name,createIfMissing:args.createIfMissing}));
  // Restore never creates: Zellij attaches to its existing session, and an unlisted one fails instead of starting empty.
  expect(multiplexers).toEqual([{kind:'herdr',name:'fleet',createIfMissing:false},{kind:'zellij',name:'notes',createIfMissing:false}]);
  expect(await page.evaluate(()=>window.relaunchCalls.filter(call=>call.command==='write_stdin'))).toEqual([]);

  await expect(page.getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('tab',{name:'Agent box / agents',exact:true})).toBeAttached();
  await expect(page.getByRole('tab',{name:'Agent box / fleet',exact:true})).toBeAttached();
  await expect(page.getByRole('tab',{name:'Agent box / notes',exact:true})).toBeAttached();
  // Restored sessions are saved again.
  expect(await saved(page)).toEqual(previous);
  // Everything restored, so nothing is left to offer until the next launch.
  await expect(restoreButton(page)).toHaveCount(0);
});

test('every relaunch waits for consent again and Dismiss forgets the descriptors',async({page})=>{
  await page.goto('/');
  await restoreButton(page).click();
  await expect.poll(async()=>(await remoteCalls(page)).length).toBe(7);

  await page.reload();
  await relaunchOffer(page);
  expect(await saved(page)).toEqual(previous);
  await page.locator('.workspace-restore').getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect(restoreButton(page)).toHaveCount(0);
  expect(await saved(page)).toEqual([]);

  await page.reload();
  await expect(page.getByRole('button',{name:'Connect to Agent box',exact:true}).first()).toBeAttached();
  await expect(page.getByRole('button',{name:'Restore previous workspace',exact:true})).toHaveCount(0);
  expect(await remoteCalls(page)).toEqual([]);
});

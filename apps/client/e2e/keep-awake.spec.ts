import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import type {mountAgentAwakeHarness} from './fixtures/AgentAwakeHarness';
declare global {interface Window {
  awakeHarness:ReturnType<typeof mountAgentAwakeHarness>;
  awakeFixture:{calls:string[];active:number|null;epoch:string;ticket:number;closed:number;available:boolean};
}}
async function fixture(page:Page) {
  await installNativeBridge(page,undefined,{nativeEvents:true});
  await page.addInitScript(()=>{
    const f=window.awakeFixture={calls:[] as string[],active:null as number|null,epoch:'0/11111111-1111-4111-8111-111111111111',ticket:0,closed:0,available:true};
    const status=(ticket:number)=>({epoch:f.epoch,ticket,available:f.available,active:f.active!==null,reason:'Synthetic native display ownership; no OS inhibitor is acquired.'});
    window.nativeFixtureInvoke=async(command,args)=>{
      f.calls.push(command);
      if(command==='list_hosts')return [];
      if(command==='local_capability')return {available:false,reason:'Synthetic board fixture.'};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
      if(command==='get_companion_settings')return {schemaVersion:1,revision:0,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
      if(command==='board_keep_awake_status')return status(++f.ticket);
      if(command==='board_keep_awake_acquire'){
        const owner=args.request as {epoch:string;ticket:number};
        if(owner.epoch!==f.epoch || owner.ticket<=f.closed)throw new Error('Expired display ticket');
        f.closed=owner.ticket;f.active=owner.ticket;return status(owner.ticket);
      }
      if(command==='board_keep_awake_release'){
        const owner=args.request as {epoch:string;ticket:number};
        f.closed=Math.max(f.closed,owner.ticket);if(f.active===owner.ticket)f.active=null;
        return status(owner.ticket);
      }
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected board fixture command: ${command}`);
    };
  });
  await page.goto('/');
  await page.evaluate(async()=>{
    const {mountAgentAwakeHarness}=await import('/e2e/fixtures/AgentAwakeHarness.tsx');
    window.awakeHarness=mountAgentAwakeHarness();
  });
}
test('visible agent board defaults off and leaving releases its exact native ownership',async({page})=>{
  await fixture(page);
  const checkbox=page.getByRole('checkbox',{name:'Keep display awake while this board is open'});
  await expect(checkbox).toBeEnabled();await expect(checkbox).not.toBeChecked();
  expect(await page.evaluate(()=>window.awakeFixture.calls.includes('board_keep_awake_acquire'))).toBe(false);
  await checkbox.check();await expect(page.getByText('This board owns an acknowledged idle-inhibition request.',{exact:true})).toBeVisible();
  const snapshotCalls=await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='agent_snapshot').length);
  await checkbox.uncheck();await expect.poll(()=>page.evaluate(()=>window.awakeFixture.active)).toBeNull();
  await checkbox.check();await expect(page.getByText('This board owns an acknowledged idle-inhibition request.',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='agent_snapshot').length)).toBe(snapshotCalls);
  await page.evaluate(()=>window.awakeHarness.close());await expect.poll(()=>page.evaluate(()=>window.awakeFixture.active)).toBeNull();
  expect(await page.evaluate(()=>window.awakeFixture.calls.some(name=>['connect','disconnect','write_stdin'].includes(name)))).toBe(false);
});
test('revoking and unlocking does not refresh an old mounted board lease',async({page})=>{
  await fixture(page);const checkbox=page.getByRole('checkbox',{name:'Keep display awake while this board is open'});
  await expect(checkbox).toBeEnabled();await checkbox.check();
  await expect(page.getByText('This board owns an acknowledged idle-inhibition request.',{exact:true})).toBeVisible();
  const acquisitions=await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='board_keep_awake_acquire').length);
  await page.evaluate(()=>window.awakeHarness.revoke());await expect.poll(()=>page.evaluate(()=>window.awakeFixture.active)).toBeNull();
  expect(await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='board_keep_awake_acquire').length)).toBe(acquisitions);
  await expect(page.getByText('This board owns an acknowledged idle-inhibition request.',{exact:true})).toHaveCount(0);
  await expect(checkbox).toBeDisabled();
  await page.evaluate(()=>window.awakeHarness.close());
});
test('native loss while focused clears only its original owner without automatic retry',async({page})=>{
  await fixture(page);const checkbox=page.getByRole('checkbox',{name:'Keep display awake while this board is open'});
  await expect(checkbox).toBeEnabled();await checkbox.check();
  const active=page.getByText('This board owns an acknowledged idle-inhibition request.',{exact:true});await expect(active).toBeVisible();
  const acquired=await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='board_keep_awake_acquire').length);
  await page.evaluate(()=>{
    const f=window.awakeFixture;window.nativeFixtureEmit('lazysh-board-keep-awake-lost',{available:true,active:false,epoch:`99/${f.epoch.split('/')[1]}`,ticket:f.active,reason:'Stale document event'});
  });
  await expect(active).toBeVisible();
  await page.evaluate(()=>{
    const f=window.awakeFixture;window.nativeFixtureEmit('lazysh-board-keep-awake-lost',{available:true,active:false,epoch:f.epoch,ticket:f.active,reason:'Owned portal connection closed.'});
  });
  await expect(active).toHaveCount(0);await expect(page.getByRole('alert')).toContainText('Owned portal connection closed.');
  await page.evaluate(()=>{window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));window.nativeFixtureEmit('tauri://focus',null);});
  expect(await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='board_keep_awake_acquire').length)).toBe(acquired);
  await expect(page.getByText('Turn this off and on to request ownership again.')).toBeVisible();
  await checkbox.uncheck();await checkbox.check();await expect(active).toBeVisible();
  await page.evaluate(()=>window.awakeHarness.close());
});

test('native main-window focus refreshes an unavailable resume observation without another DOM focus event',async({page})=>{
  await fixture(page);
  const checkbox=page.getByRole('checkbox',{name:'Keep display awake while this board is open'});
  const active=page.getByText('This board owns an acknowledged idle-inhibition request.',{exact:true});
  await expect(checkbox).toBeEnabled();await checkbox.check();await expect(active).toBeVisible();
  const acquisitions=await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='board_keep_awake_acquire').length);
  await page.evaluate(()=>{
    window.awakeFixture.available=false;window.awakeFixture.active=null;
    window.dispatchEvent(new Event('blur'));window.dispatchEvent(new Event('focus'));
  });
  await expect(page.getByText('Synthetic native display ownership; no OS inhibitor is acquired.',{exact:true})).toBeVisible();
  await expect(checkbox).toBeChecked();
  await page.evaluate(()=>{window.awakeFixture.available=true;window.nativeFixtureEmit('tauri://focus',null);});
  await expect(active).toBeVisible();
  expect(await page.evaluate(()=>window.awakeFixture.calls.filter(name=>name==='board_keep_awake_acquire').length)).toBe(acquisitions+1);
  expect(await page.evaluate(()=>window.awakeFixture.calls.some(name=>['connect','disconnect','write_stdin'].includes(name)))).toBe(false);
  await page.evaluate(()=>window.awakeHarness.close());
});

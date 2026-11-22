import { installNativeBridge } from './fixtures/nativeBridge';
import { expect, test, type Page } from '@playwright/test';

type Call = {command:string;args:Record<string,unknown>};
type Fixture = {calls: Call[]; refuse: number; hold?: Promise<void>; release?: () => void; channels: Record<string,{onmessage:(event:unknown)=>void}>};
declare global { interface Window { recovery: Fixture } }

const key='lazysh.workspace.v1';
const remote=['connect','attach_tmux','attach_multiplexer','connect_mosh','connect_et'];

async function open(page:Page, previous:unknown[], host:Record<string,unknown>={credentialsStored:true}) {
  await installNativeBridge(page);
  await page.addInitScript(({key,previous,remote,host}) => {
    localStorage.setItem(key,JSON.stringify(previous));
    window.recovery={calls:[],refuse:0,channels:{}};
    let sessions=0;
    window.nativeFixtureInvoke=async(command,args={})=>{
      if(command.startsWith('plugin:event|'))return 1;
      if(command==='list_hosts')return [{id:'box',name:'Agent box',hostname:'box.invalid',port:22,username:'dev',fingerprint:'SHA256:fixture',...host}];
      if(command==='local_capability')return {available:false,reason:'Recovery fixture'};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Recovery fixture'};
      window.recovery.calls.push({command,args});
      if(command==='connect' && window.recovery.hold)await window.recovery.hold;
      if(command==='connect' && window.recovery.refuse>0) {window.recovery.refuse--;throw {kind:'ssh_error',message:'Connection refused'};}
      if(remote.includes(command)) {
        const sessionId=`native-${++sessions}`;
        window.recovery.channels[sessionId]=args.events as Fixture['channels'][string];
        return {sessionId};
      }
      if(['resize','ack_output','disconnect','write_stdin','probe_connections','cancel_credential_auth'].includes(command))return;
      if(command==='has_credentials')return false;
      throw new Error(`Recovery fixture does not provide ${command}`);
    };
  },{key,previous,remote,host});
  await page.goto('/');
  await page.locator('.workspace-restore').getByRole('button',{name:'Restore previous workspace',exact:true}).click();
}

const calls=(page:Page,command:string)=>page.evaluate(command=>window.recovery.calls.filter(call=>call.command===command),command);
const close=(page:Page,sessionId:string,event:Record<string,unknown>)=>page.evaluate(({sessionId,event})=>window.recovery.channels[sessionId].onmessage({type:'closed',...event}),{sessionId,event});
// The operating system's signal as the WebView reports it; the dev server connection stays up.
const network=(page:Page,online:boolean)=>page.evaluate(online=>{
  Object.defineProperty(navigator,'onLine',{configurable:true,get:()=>online});
  window.dispatchEvent(new Event(online?'online':'offline'));
},online);
// Phones show one terminal at a time behind a session switcher instead of tabs.
const terminal=(page:Page,name:string)=>page.locator(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for ${name}`)}]`);
const lostBanner=(page:Page,name:string)=>page.getByRole('region',{name:`Connection lost for ${name}`,exact:true});
const banner=(page:Page)=>lostBanner(page,'Agent box / agents');
// Holds every connect open until the returned function runs.
const holdConnects=(page:Page)=>page.evaluate(()=>{window.recovery.hold=new Promise(resolve=>{window.recovery.release=()=>{window.recovery.hold=undefined;resolve();};});});
const releaseConnects=(page:Page)=>page.evaluate(()=>window.recovery.release?.());

test('a lost tmux session retries with backoff and reattaches the same tmux session',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents',tmuxServer:'work'}}]);
  await expect(terminal(page,'Agent box / agents')).toBeVisible();
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await page.evaluate(()=>{window.recovery.refuse=1;});

  await close(page,'native-2',{message:'Connection reset by peer',lost:true});
  await expect(banner(page)).toContainText('Connection lost.');
  await expect(banner(page)).toContainText(/Reconnecting in 1 s · attempt 1 of 10/);
  // The first scheduled attempt is refused; the next one waits about two seconds.
  await expect(banner(page)).toContainText(/Reconnecting in [12] s · attempt 2 of 10/,{timeout:5000});
  expect(await calls(page,'connect')).toHaveLength(2);

  await banner(page).getByRole('button',{name:'Retry now',exact:true}).click();
  await expect(banner(page)).toHaveCount(0);
  const connects=await calls(page,'connect');
  expect(connects).toHaveLength(3);
  // Reconnecting reuses the saved credentials and never carries credential material itself.
  expect(connects[2].args).toMatchObject({hostId:'box',useSavedCredentials:true});
  expect(Object.keys(connects[2].args).filter(name=>/password|privateKey|passphrase/i.test(name))).toEqual([]);
  const attaches=await calls(page,'attach_tmux');
  expect(attaches).toHaveLength(2);
  expect({sessionId:attaches[1].args.sessionId,name:attaches[1].args.name,tmuxServer:attaches[1].args.tmuxServer}).toEqual({sessionId:'native-3',name:'agents',tmuxServer:'work'});
  await expect(page.locator('.terminal-canvas')).toHaveCount(1);
  await expect(terminal(page,'Agent box / agents')).toBeVisible();
  await expect(page.getByText(/Session ended/)).toHaveCount(0);
});

test('a lost Zellij session reconnects by attaching the same session without creating it',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'zellij',name:'notes'}}]);
  await expect(terminal(page,'Agent box / notes')).toBeVisible();
  const first=await calls(page,'attach_multiplexer');
  expect(first.map(({args})=>({kind:args.kind,name:args.name,createIfMissing:args.createIfMissing}))).toEqual([{kind:'zellij',name:'notes',createIfMissing:false}]);

  await close(page,'native-2',{message:'Connection reset by peer',lost:true});
  const lost=lostBanner(page,'Agent box / notes');
  await expect(lost).toContainText('Connection lost.');
  // The first scheduled attempt reconnects on its own after about a second.
  await expect(lost).toHaveCount(0,{timeout:8000});
  const attaches=await calls(page,'attach_multiplexer');
  expect(attaches).toHaveLength(2);
  expect({sessionId:attaches[1].args.sessionId,kind:attaches[1].args.kind,name:attaches[1].args.name,createIfMissing:attaches[1].args.createIfMissing}).toEqual({sessionId:'native-3',kind:'zellij',name:'notes',createIfMissing:false});
  await expect(page.locator('.terminal-canvas')).toHaveCount(1);
});

test('Close on the lost-connection banner ends the session and stops retrying',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents'}}]);
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await page.evaluate(()=>{window.recovery.refuse=100;});
  await close(page,'native-2',{message:'Connection reset by peer',lost:true});
  await expect(banner(page)).toBeVisible();
  await banner(page).getByRole('button',{name:'Close Agent box / agents',exact:true}).click();
  await expect(page.locator('.terminal-canvas')).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
  expect((await calls(page,'disconnect')).map(call=>call.args.sessionId)).toContain('native-2');
  const attempts=(await calls(page,'connect')).length;
  await page.waitForTimeout(2500);
  expect(await calls(page,'connect')).toHaveLength(attempts);
  // The closed session is no longer offered for restoration.
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key) ?? 'null'),key)).toEqual([]);
});

test('retries wait while the device is offline and resume as soon as the network returns',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents'}}]);
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await network(page,false);
  await expect(page.getByRole('status').filter({hasText:'No network. This session reconnects automatically if the connection drops.'})).toBeVisible();
  await close(page,'native-2',{message:'Network is unreachable',lost:true});
  await expect(banner(page)).toContainText('Waiting for the network; reconnects as soon as it returns.');
  await page.waitForTimeout(2500);
  expect(await calls(page,'connect')).toHaveLength(1);
  await network(page,true);
  await expect(banner(page)).toHaveCount(0);
  expect(await calls(page,'connect')).toHaveLength(2);
  await expect(terminal(page,'Agent box / agents')).toBeVisible();
});

test('a remote exit ends the session without a reconnect banner',async({page})=>{
  await open(page,[{hostId:'box'}]);
  await expect(terminal(page,'Agent box')).toBeVisible();
  await close(page,'native-1',{message:'Session closed'});
  await expect(page.getByText('Session ended · Session closed. Close this tab or connect again from Hosts.')).toBeVisible();
  await expect(lostBanner(page,'Agent box')).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(await calls(page,'connect')).toHaveLength(1);
});

test('a host without saved credentials waits for sign-in, then signing in reattaches the lost tab in place',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents',tmuxServer:'work'}}],{credentialsStored:false});
  // Restoration itself used saved credentials; the fixture accepts them so a tab exists to lose.
  await expect(terminal(page,'Agent box / agents')).toBeVisible();
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await close(page,'native-2',{message:'Connection reset by peer',lost:true});
  await expect(banner(page)).toContainText('Credentials are not saved for this host. Sign in to reconnect.');
  await page.waitForTimeout(1500);
  expect(await calls(page,'connect')).toHaveLength(1);
  await banner(page).getByRole('button',{name:'Sign in',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Connect to Agent box',exact:true});
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Password',{exact:true}).fill('typed-after-loss');
  await dialog.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
  // The lost tab is replaced, not joined by a second plain shell.
  await expect(page.locator('.terminal-canvas')).toHaveCount(1);
  await expect(terminal(page,'Agent box / agents')).toBeVisible();
  const attaches=await calls(page,'attach_tmux');
  expect(attaches).toHaveLength(2);
  expect({sessionId:attaches[1].args.sessionId,name:attaches[1].args.name,tmuxServer:attaches[1].args.tmuxServer}).toEqual({sessionId:'native-3',name:'agents',tmuxServer:'work'});
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key) ?? 'null'),key)).toEqual([{hostId:'box',attached:{kind:'tmux',name:'agents',tmuxServer:'work'}}]);
});

test('a host with biometric unlock tries once per Retry now and never retries unattended',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents'}}],{credentialsStored:true,biometricUnlock:true});
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await page.evaluate(()=>{window.recovery.refuse=100;});
  await close(page,'native-2',{message:'Connection reset by peer',lost:true});
  await expect(banner(page)).toContainText('Saved credentials need your confirmation. Retry to unlock and reconnect.');
  await page.waitForTimeout(1500);
  expect(await calls(page,'connect')).toHaveLength(1);
  // Each connect on a device is a biometric prompt: one tap, one attempt.
  await banner(page).getByRole('button',{name:'Retry now',exact:true}).click();
  await expect(banner(page)).toContainText('Could not reconnect: Connection refused');
  expect(await calls(page,'connect')).toHaveLength(2);
  // Neither the backoff window nor the network returning may prompt again.
  await page.waitForTimeout(3500);
  await network(page,false);
  await network(page,true);
  await page.waitForTimeout(1000);
  expect(await calls(page,'connect')).toHaveLength(2);
  await expect(banner(page).getByRole('button',{name:'Retry now',exact:true})).toBeEnabled();
});

test('an attempt in flight shows its progress and disables Retry now until it settles',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents'}}]);
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await holdConnects(page);
  await close(page,'native-2',{message:'Connection reset by peer',lost:true});
  await expect(banner(page)).toContainText('Reconnecting… attempt 1 of 10',{timeout:5000});
  await expect(banner(page).getByRole('button',{name:'Retry now',exact:true})).toBeDisabled();
  // Screen readers hear the phase, not each second of the countdown.
  await expect(banner(page).getByRole('status')).toHaveText('Connection lost. Reconnecting.');
  await releaseConnects(page);
  await expect(banner(page)).toHaveCount(0);
  await expect(terminal(page,'Agent box / agents')).toBeVisible();
});

test('the network returning asks live SSH sessions to prove their route',async({page})=>{
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents'}}]);
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await network(page,false);
  await network(page,true);
  await expect.poll(async()=>(await calls(page,'probe_connections')).map(call=>call.args.sessionIds)).toEqual([['native-2']]);
  // A silent route answers by closing as lost, which starts the usual recovery.
  await close(page,'native-2',{message:'Connection to the server was lost',lost:true});
  await expect(banner(page)).toBeVisible();
  await expect(banner(page)).toHaveCount(0,{timeout:5000});
  expect(await calls(page,'connect')).toHaveLength(2);
});

test('retrying stops after the attempt cap until the person asks again',async({page})=>{
  await page.clock.install();
  await open(page,[{hostId:'box',attached:{kind:'tmux',name:'agents'}}]);
  await expect.poll(async()=>(await calls(page,'attach_tmux')).length).toBe(1);
  await page.evaluate(()=>{window.recovery.refuse=100;});
  await close(page,'native-2',{message:'Connection reset by peer',lost:true});
  await expect(banner(page)).toBeVisible();
  // The backoff reaches its 30 s cap by the sixth attempt; each step advances at least one pending retry.
  for(let step=0;step<40 && (await calls(page,'connect')).length<11;step++)await page.clock.runFor(16_000);
  await expect(banner(page)).toContainText('Could not reconnect: Connection refused');
  expect(await calls(page,'connect')).toHaveLength(11);
  await page.clock.runFor(120_000);
  expect(await calls(page,'connect')).toHaveLength(11);
  await expect(banner(page).getByRole('button',{name:'Retry now',exact:true})).toBeEnabled();
});

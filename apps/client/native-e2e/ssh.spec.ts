import {expect,it,vi} from 'vitest';
import {readFile,readlink,readdir,realpath,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {identity,descendants,type OwnedPid} from '../../../tests/support/ownedProcess';
import {OwnedSshRelay} from './sshRelay';
import * as socketOwners from './socketOwner';
import {NativeGui} from './fixture';
import {SshFixture,listening,sshCommand} from '../../../tests/support/sshFixture';
import {HerdrFixture,herdrTools} from '../../../tests/support/androidHerdr';
import {openOwnedSsh,challengeOwnedSsh,disconnectOwnedSsh,ownedSshGui,enterOwnedKey,openOwnedRememberedSsh} from './sshUi';

const fixture=ownedSshGui();

async function ownedMoshFixture() {
  const binary=await realpath(process.env.LAZYSH_NATIVE_MOSH_SERVER??(await sshCommand('locate owned Mosh server','sh',['-c','command -v mosh-server'])).trim());
  return fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,moshBinary:binary});
}

it('trusts the exact ephemeral server and types a non-echoable challenge through the bundled SSH terminal',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true});
  const control=await ssh.client();
  control.child.stdin!.end(`${ssh.challenge}\nexit\n`);
  const output=await control.finish('owned namespace SSH preflight',5000);
  expect(output.includes(ssh.prompt)).toBe(true);
  expect(output.includes(ssh.expected)).toBe(true);
  const gui=fixture.gui=await NativeGui.start();
  const {terminal,owner}=await openOwnedSsh(gui,ssh);
  fixture.captureSafe=true;
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  await disconnectOwnedSsh(gui,terminal);
});

it('saves credentials in a disposable Secret Service and reconnects only after explicit saved-host consent',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true});
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  await gui.assertDisposableCredential('empty');
  const {browser,terminal,owner}=await openOwnedRememberedSsh(gui,ssh);
  await challengeOwnedSsh(gui,ssh,terminal,owner);
  await gui.assertDisposableCredential('saved');
  let savedHostId:string|undefined;
  const catalogState=async(stored:boolean)=>{
    const path=join(gui.directory,'config','app.lazysh.client','hosts.json');
    if((await stat(path)).size>64*1024)throw new Error('Owned host catalog exceeds its bound');
    const text=await readFile(path,'utf8');let records:unknown;
    try{records=JSON.parse(text);}catch{throw new Error('Owned host catalog is invalid');}
    if(!Array.isArray(records))throw new Error('Owned host catalog is not a list');
    if(text.includes('PRIVATE KEY')||text.includes(JSON.stringify(ssh.privateKey).slice(1,-1))||/"(?:password|privateKey|private_key|passphrase)"\s*:/.test(text))throw new Error('Owned host catalog contains credential material');
    const hosts=records.filter((value:unknown)=>!!value&&typeof value==='object'&&'name' in value&&value.name==='Owned SSH GUI host');
    if(hosts.length!==1)return false;
    const host=hosts[0] as Record<string,unknown>;
    if(typeof host.id!=='string'||(savedHostId!==undefined&&host.id!==savedHostId))return false;
    savedHostId=host.id;
    return (stored?host.credentialsStored===true:host.credentialsStored===undefined||host.credentialsStored===false)&&host.hostname==='127.0.0.1'&&host.port===ssh.port&&host.username===ssh.username&&host.fingerprint===ssh.fingerprint;
  };
  expect(await catalogState(true)).toBe(true);
  await disconnectOwnedSsh(gui,terminal);
  gui.stage='owned saved-credential dialog';
  const reopen=async()=>{
    await (await browser.$('button[aria-label="Connect to Owned SSH GUI host"]')).click();
    const dialog=await browser.$('[role="dialog"][aria-label="Connect to Owned SSH GUI host"]');await dialog.waitForDisplayed();return dialog;
  };
  const dialog=await reopen();
  const saved=await (await dialog.$('label*=Use saved credentials')).$('input[type="checkbox"]');await saved.waitForExist();
  expect(await saved.isSelected()).toBe(true);
  expect(await dialog.$$('textarea,input[type="password"]')).toHaveLength(0);
  await (await dialog.$('button=Private key')).click();
  expect(await (await dialog.$('textarea')).getValue()==='').toBe(true);
  expect(await (await dialog.$('input[type="password"]')).getValue()==='').toBe(true);
  expect(await (await (await dialog.$('label*=Save credentials on this device')).$('input')).isSelected()).toBe(false);
  const savedAgain=await (await dialog.$('label*=Use saved credentials')).$('input[type="checkbox"]');
  await savedAgain.click();expect(await savedAgain.isSelected()).toBe(true);
  expect(await dialog.$$('textarea,input[type="password"]')).toHaveLength(0);
  let activeTerminal=false;
  for(const canvas of await browser.$$('.terminal-canvas .xterm-screen'))activeTerminal ||= await canvas.isDisplayed();
  expect(activeTerminal).toBe(false);
  await (await dialog.$('button=Connect')).click();
  const second=await browser.$('.terminal-canvas .xterm-screen');await second.waitForDisplayed({timeout:20_000});
  await challengeOwnedSsh(gui,ssh,second,owner,'AFTER_SAVED_RECONNECT');
  await gui.assertDisposableCredential('unchanged');
  await disconnectOwnedSsh(gui,second);
  gui.stage='owned saved-credential explicit forget';
  const forgotten=await reopen();
  await (await forgotten.$('button=Forget saved credentials')).waitForDisplayed();
  await (await forgotten.$('button=Forget saved credentials')).click();
  await (await forgotten.$('label*=Use saved credentials')).waitForExist({reverse:true});
  await gui.assertDisposableCredential('empty');
  expect(await catalogState(false)).toBe(true);
  await (await forgotten.$('button=Private key')).click();
  expect(await (await forgotten.$('textarea')).getValue()==='').toBe(true);
  expect(await (await forgotten.$('input[type="password"]')).getValue()==='').toBe(true);
  await (await forgotten.$('button=Cancel')).click();await forgotten.waitForDisplayed({reverse:true});
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
});

it('enters the saved Herdr default through Mosh in the actual GUI and queues only confirmed input to its original receiver',async()=>{
  fixture.captureSafe=false;
  const binary=process.env.LAZYSH_NATIVE_MOSH_SERVER;
  if(!binary)throw new Error('Explicit pinned Mosh binary required');
  const herdr=await HerdrFixture.start(herdrTools(),binary);
  fixture.ssh=herdr;
  const gui=fixture.gui=await NativeGui.start();
  const {browser,terminal,owner}=await openOwnedSsh(gui,herdr.ssh,'mosh',undefined,{kind:'herdr',name:herdr.name});
  expect(await (await browser.$('.workspace-footer')).getText()).toContain('Mosh');
  expect(await browser.$$('[role="tab"]')).toHaveLength(1);
  expect(await terminal.getText()).not.toMatch(/MOSH CONNECT |LAZYSH_ATTACH_|LAZYSH-GUARD-1:/);
  fixture.captureSafe=true;
  gui.stage='owned Mosh Herdr transcript';
  await (await browser.$('button=Transcript')).click();
  await (await browser.$('input[placeholder="Absolute host path to session.jsonl"]')).setValue(herdr.transcript);
  await (await browser.$('button=Open transcript')).click();
  const messages=await browser.$('.chat-messages');
  await browser.waitUntil(async()=>(await messages.getText()).includes(herdr.record),{timeout:20_000});
  // WebKit Send Keys treats raw TAB as navigation; paste literal control characters on the owned display.
  const draft='form.chat-composer textarea';
  const clipboardKey=`__lazyshOwnedDraftClipboard_${herdr.ssh.nonce}`;
  expect(await browser.execute(({selector,text,key})=>{
    const target=document.querySelector(selector);
    if(!(target instanceof HTMLTextAreaElement)||Object.hasOwn(window,key))return false;
    const state={phase:'waiting',dispose:()=>target.removeEventListener('click',copy)};
    const copy=()=>{
      if(!navigator.clipboard?.writeText){state.phase='unavailable';return;}
      try {void navigator.clipboard.writeText(text).then(()=>{state.phase='ready';},()=>{state.phase='unavailable';});}
      catch {state.phase='unavailable';}
    };
    Object.defineProperty(window,key,{value:state,configurable:true});
    target.addEventListener('click',copy,{once:true});return true;
  },{selector:draft,text:herdr.draft,key:clipboardKey})).toBe(true);
  let clipboardFailed=false;
  try {
    await (await browser.$(draft)).click();
    await browser.waitUntil(async()=>await browser.execute(key=>(window as unknown as Record<string,{phase:string}>)[key]?.phase,clipboardKey)==='ready',
      {timeout:3000,timeoutMsg:'Owned private clipboard write was not confirmed'});
    await browser.keys(['Control','v']);
  } catch(error) {
    clipboardFailed=true;throw error;
  } finally {
    try {
      await browser.execute(key=>{
        const owner=window as unknown as Record<string,{dispose:()=>void}>;
        owner[key]?.dispose();delete owner[key];
      },clipboardKey);
    } catch(error) {if(clipboardFailed)console.error('Owned draft clipboard cleanup also failed');else throw error;}
  }
  expect(await (await browser.$(draft)).getValue()).toBe(herdr.draft);
  await herdr.expectBytes(Buffer.alloc(0));
  gui.stage='owned Mosh Herdr explicit confirmation';
  await (await browser.$('button=Choose terminal destination')).click();
  const confirm=await browser.$('button=Confirm this destination');await confirm.waitForDisplayed();
  await confirm.click();
  const send=await browser.$('button=Send to terminal');await send.waitForDisplayed();
  await herdr.expectBytes(Buffer.alloc(0));
  await send.click();
  await browser.waitUntil(async()=>await (await browser.$(draft)).getValue()==='',{timeout:20_000});
  const stop=await browser.$('button=Request stop');await stop.click();
  await herdr.expectBytes(Buffer.from(herdr.draft+'\r\x1b'));
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
  expect(await readFile(join(herdr.ssh.directory,'mosh-bootstraps'),'utf8')).toBe('bootstrap\n');
  await disconnectOwnedSsh(gui,terminal,`Owned SSH GUI host / ${herdr.name}`);
});

it.each(['client','server'] as const)('keeps the owned Mosh UDP daemon alive after %s-attributed SSH closure and retires the entire namespace',async attribution=>{
  const ssh=await ownedMoshFixture();
  const relay=await OwnedSshRelay.start(ssh.port),relayPort=relay.port;
  let root:OwnedPid|undefined;
  let control:Awaited<ReturnType<typeof ssh.client>>|undefined;
  let observer:Awaited<ReturnType<typeof ssh.client>>|undefined;
  let members:OwnedPid[]=[];
  let udpPort:number|undefined;
  const udp=async()=> (await readFile('/proc/net/udp','utf8')).split('\n').some(row=>row.trim().split(/\s+/)[1]===`0100007F:${udpPort?.toString(16).toUpperCase().padStart(4,'0')}`);
  try {
    root=await ssh.daemon.liveIdentity();expect(root).toBeDefined();
    const bootstrap=await ssh.client(true,'mosh-server new -i 127.0.0.1 -- /bin/sh -c "sleep 90"',relayPort);
    const output=await bootstrap.finish('owned Mosh bootstrap',5000);
    const port=udpPort=Number(output.match(/MOSH CONNECT (\d+) [A-Za-z0-9+/=]+/)?.[1]);
    expect(port).toBeGreaterThan(0);expect(port).toBeLessThanOrEqual(65535);
    // The SSH exec has exited; the namespace must retain its daemon independently.
    expect(await udp()).toBe(true);
    members=await descendants(root!);
    const row=(await readFile('/proc/net/udp','utf8')).split('\n').map(line=>line.trim().split(/\s+/)).find(fields=>fields[1]===`0100007F:${port.toString(16).toUpperCase().padStart(4,'0')}`);
    const daemons=[];
    for(const member of members)if((await readlink(`/proc/${member.pid}/exe`).catch(()=>''))===`${ssh.directory}/bin/mosh-server`) {
      const files=await readdir(`/proc/${member.pid}/fd`).catch(()=>[]);expect(files.length).toBeLessThanOrEqual(256);
      for(const file of files)if(await readlink(`/proc/${member.pid}/fd/${file}`).catch(()=>'')===`socket:[${row?.[9]}]`){daemons.push(member);break;}
    }
    expect(daemons).toHaveLength(1);
    expect(await readlink(`/proc/${daemons[0].pid}/ns/pid`)).not.toBe(await readlink('/proc/self/ns/pid'));
    control=await ssh.client(true,undefined,relayPort);
    observer=await ssh.client(true,undefined,relayPort);
    await vi.waitFor(()=>{expect(control!.stdout).toContain(ssh.prompt);expect(observer!.stdout).toContain(ssh.prompt);expect(relay.active).toBe(2);},{timeout:3000,interval:10});
    const controlOwner=await control.liveIdentity();expect(controlOwner).toBeDefined();
    await expect(relay.closeOwned({...controlOwner!,start:'stale'})).rejects.toThrow('identity retired');
    expect(relay.active).toBe(2);
    if(attribution==='server') {
      await expect(relay.closeOwnedServer({...root!,start:'stale'})).rejects.toThrow('identity retired');
      await expect(relay.closeOwnedServer(root!)).rejects.toThrow('Exactly one live owned SSH server stream required');
      expect(relay.active).toBe(2);
      observer.child.stdin!.end(`${ssh.challenge}\nexit\n`);
      expect(await observer.finish('ambiguous SSH observer retires explicitly',3000)).toContain(ssh.expected);observer=undefined;
      await vi.waitFor(()=>expect(relay.active).toBe(1),{timeout:1000,interval:10});
      await expect(relay.closeOwnedServer(controlOwner!)).rejects.toThrow('Exactly one live owned SSH server stream required');
      const attribute=socketOwners.acceptedConnectionOwner;let checks=0,arrived=false;
      const recheck=vi.spyOn(socketOwners,'acceptedConnectionOwner').mockImplementation(async(...args)=>{
        const result=await attribute(...args);
        if(++checks===2) {
          observer=await ssh.client(true,undefined,relayPort);
          await vi.waitFor(()=>{expect(observer!.stdout).toContain(ssh.prompt);expect(relay.active).toBe(2);},{timeout:3000,interval:10});
          arrived=true;console.info('Owned second SSH stream arrived during selected-server recheck');
        }
        return result;
      });
      try {await expect(relay.closeOwnedServer(root!)).rejects.toThrow('Owned SSH server stream retired');}
      finally {recheck.mockRestore();}
      expect(arrived).toBe(true);expect(checks).toBe(2);expect(relay.active).toBe(2);
      expect(await control.liveIdentity()).toEqual(controlOwner);
      observer!.child.stdin!.end(`${ssh.challenge}\nexit\n`);
      expect(await observer!.finish('racing SSH observer retires explicitly',3000)).toContain(ssh.expected);observer=undefined;
      await vi.waitFor(()=>expect(relay.active).toBe(1),{timeout:1000,interval:10});
      await relay.closeOwnedServer(root!);
    } else await relay.closeOwned(controlOwner!);
    await expect(control.finish('selected SSH closure',3000)).rejects.toThrow('Owned fixture failed: selected SSH closure');control=undefined;
    expect(relay.active).toBe(attribution==='server'?0:1);expect(await listening(relayPort)).toBe(true);expect(await listening(ssh.port)).toBe(true);
    expect(await udp()).toBe(true);expect((await identity(daemons[0].pid))?.start).toBe(daemons[0].start);
    if(observer) {
      observer.child.stdin!.end(`${ssh.challenge}\nexit\n`);
      expect(await observer.finish('unselected SSH stream remains usable',3000)).toContain(ssh.expected);observer=undefined;
    }
    const fresh=await ssh.client(true,'printf RECOVERED',relayPort);
    expect(await fresh.finish('fresh owned SSH connection after closure',3000)).toBe('RECOVERED');
    expect(await udp()).toBe(true);
    members=await descendants(root!);
    console.info(`Owned Mosh lifecycle: ${attribution}-attributed SSH pair retired; fresh SSH usable; UDP daemon retained`);
  } finally {
    const failures:unknown[]=[];
    for(const step of [()=>control?.stop(),()=>observer?.stop(),()=>relay.stop(),()=>ssh.stop()])try{await step();}catch(error){failures.push(error);}
    for(const member of [...(root?[root]:[]),...members])try{expect((await identity(member.pid))?.start).not.toBe(member.start);}catch(error){failures.push(error);}
    try{expect(await listening(relayPort)).toBe(false);expect(await listening(ssh.port)).toBe(false);if(udpPort)expect(await udp()).toBe(false);await expect(stat(ssh.directory)).rejects.toMatchObject({code:'ENOENT'});}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Owned Mosh lifecycle cleanup failed');
    console.info('Owned Mosh cleanup: namespace identities retired; TCP/UDP listeners absent; private directory removed');
  }
},90_000);

it('manually reconnects attachment uploads in the same live Mosh terminal and never overwrites its remote file',async()=>{
  fixture.captureSafe=false;
  const ssh=await ownedMoshFixture();
  const relay=await OwnedSshRelay.start(ssh.port),relayPort=relay.port;
  let members:OwnedPid[]=[],root:OwnedPid|undefined;
  try {
    root=await ssh.daemon.liveIdentity();expect(root).toBeDefined();
    const gui=fixture.gui=await NativeGui.start();
    const {browser,terminal,owner}=await openOwnedSsh(gui,ssh,'mosh',relayPort);
    fixture.captureSafe=true;
    await challengeOwnedSsh(gui,ssh,terminal,owner);
    expect(await (await browser.$('.workspace-footer')).getText()).toContain('Mosh');
    const tab=await browser.$('[role="tab"][aria-selected="true"]'),tabId=tab.elementId,terminalId=terminal.elementId;
    gui.stage='owned Mosh SSH-only closure';
    const app=await identity(owner.pid);expect(app?.start).toBe(owner.start);
    await relay.closeOwned(app!);
    expect(await listening(relayPort)).toBe(true);expect(await listening(ssh.port)).toBe(true);
    await challengeOwnedSsh(gui,ssh,terminal,owner,'AFTER_CLOSURE');
    gui.stage='owned Mosh image selection and closed upload';
    await (await (await browser.$('.session-toolbar')).$('button=Attach')).click();
    const panel=await browser.$('.attachment-panel');await panel.waitForDisplayed();
    // Reuse the repository's authored JPEG; trailing padding models screenshot-sized bytes.
    const artwork=await readFile(new URL('../e2e/fixtures/recorded-images/regions-progressive.jpg',import.meta.url));
    const image=Buffer.alloc(462_702);artwork.copy(image);
    const name=`owned-recovery-${ssh.nonce}.jpg`,source=join(gui.directory,name),remote=join(ssh.directory,name);
    await writeFile(source,image,{mode:0o600,flag:'wx'});
    await (await panel.$('input[aria-label="Choose attachment"]')).setValue(source);
    const destination=await (await panel.$('label*=Destination path')).$('input');
    await browser.waitUntil(async()=>(await destination.getValue())===`./${name}`,{timeout:5000});
    await (await panel.$('button=Upload attachment')).click();
    const alert=await panel.$('[role="alert"]');await alert.waitForDisplayed({timeout:5000});
    expect(await alert.getText()).toContain('SSH file-transfer connection is closed');
    await expect(stat(remote)).rejects.toMatchObject({code:'ENOENT'});
    gui.stage='owned Mosh manual upload reauthentication';
    await (await panel.$('button=Reconnect uploads')).click();
    const reconnect=await browser.$('[role="dialog"][aria-label="Reconnect uploads to Owned SSH GUI host"]');await reconnect.waitForDisplayed();
    expect(await (await reconnect.$('select')).isExisting()).toBe(false);
    expect(await (await reconnect.$('input[type="password"]')).getValue()).toBe('');
    fixture.captureSafe=false;
    await enterOwnedKey(gui,ssh,reconnect,true);
    await reconnect.waitForDisplayed({reverse:true,timeout:15_000});fixture.captureSafe=true;
    expect(await (await panel.$('[role="status"]')).getText()).toBe('Uploads reconnected. Select Upload attachment to retry.');
    await expect(stat(remote)).rejects.toMatchObject({code:'ENOENT'});
    gui.stage='owned Mosh separate explicit upload';
    await (await panel.$('button=Upload attachment')).click();
    await browser.waitUntil(async()=>(await (await panel.$('[role="status"]')).getText()).startsWith('Uploaded to this host.'),{timeout:10_000});
    const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
    expect(await readFile(remote)).toEqual(image);expect(hash(await readFile(remote))).toBe(hash(image));
    const uploaded=await stat(remote);
    await (await panel.$('button=Upload attachment')).click();
    const conflict=await panel.$('[role="alert"]');await conflict.waitForDisplayed({timeout:5000});
    expect(await conflict.getText()).toMatch(/^Failure: /);
    expect(await (await panel.$('button=Reconnect uploads')).isExisting()).toBe(false);
    const retained=await stat(remote);
    expect([retained.ino,retained.size,retained.mtimeMs]).toEqual([uploaded.ino,uploaded.size,uploaded.mtimeMs]);
    expect(hash(await readFile(remote))).toBe(hash(image));
    gui.stage='owned Mosh original terminal after upload recovery';
    await (await (await browser.$('.session-toolbar')).$('button=Terminal')).click();
    expect((await browser.$('.terminal-canvas .xterm-screen')).elementId).toBe(terminalId);
    expect((await browser.$('[role="tab"][aria-selected="true"]')).elementId).toBe(tabId);
    await challengeOwnedSsh(gui,ssh,terminal,owner,'AFTER_RECOVERY');
    expect(await gui.appOwner()).toEqual(owner);
    await disconnectOwnedSsh(gui,terminal);
    members=await descendants(root!);
    console.info(`Owned Mosh attachment recovery: manual reauthentication then separate upload; bytes=${image.length}; sha256=${hash(image)}; exclusive-create conflict preserved file; original terminal and native identity retained`);
  } catch(error) {
    console.error(`Owned Mosh recovery failure stage: ${fixture.gui?.stage??'fixture startup'}`);
    throw error;
  } finally {
    const failures:unknown[]=[];
    try{if(root)members=await descendants(root);}catch(error){failures.push(error);}
    for(const step of [()=>relay.stop(),()=>fixture.gui?.stop(),()=>ssh.stop()])try{await step();}catch(error){failures.push(error);}
    fixture.gui=undefined;
    for(const member of [...(root?[root]:[]),...members])try{expect((await identity(member.pid))?.start).not.toBe(member.start);}catch(error){failures.push(error);}
    try{expect(await listening(relayPort)).toBe(false);expect(await listening(ssh.port)).toBe(false);}catch(error){failures.push(error);}
    if(failures.length)throw new AggregateError(failures,'Owned Mosh recovery UI cleanup failed');
    console.info('Owned Mosh recovery cleanup: namespace identities retired and SSH listeners absent');
  }
},90_000);

import {afterEach,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {chmod,mkdir,readFile,stat,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {identity,type OwnedPid} from '../../../tests/support/ownedProcess';

type Terminal=Awaited<ReturnType<NonNullable<NativeGui['browser']>['$']>>;
type Owner=Awaited<ReturnType<NativeGui['appOwner']>>;
type OwnedHostLabel='Owned SSH GUI host'|'Owned SSH GUI second host';

/** What the page shows right now: its dialogs, alerts and focused control, for a failure message that says what was on screen. */
export async function describeUi(gui:NativeGui) {
  try {
    return JSON.stringify(await gui.browser!.execute(()=>{
      const shown=(node:Element)=>(node as HTMLElement).getClientRects().length>0;
      const active=document.activeElement as HTMLElement|null;
      return {
        dialogs:Array.from(document.querySelectorAll('[role="dialog"]')).map(node=>({label:node.getAttribute('aria-label'),shown:shown(node),inert:(node as HTMLElement).inert})),
        alerts:Array.from(document.querySelectorAll('[role="alert"],[role="status"]')).filter(shown).map(node=>node.textContent?.trim().slice(0,200)),
        active:active&&{tag:active.tagName,label:active.getAttribute('aria-label')??active.textContent?.trim().slice(0,60)},
        busy:document.querySelectorAll('[aria-busy="true"]').length,
      };
    }));
  } catch(error) {return `unavailable (${error})`;}
}

/** Runs `step`; when it fails, its error also carries what the page and `extra` show. */
export async function withUiState<T>(gui:NativeGui,step:()=>Promise<T>,extra:()=>Promise<unknown>=async()=>undefined):Promise<T> {
  try {return await step();}
  catch(error) {
    const detail=await extra().catch(failure=>`unavailable (${failure})`);
    throw new Error(`${error instanceof Error?error.message:String(error)}; page ${await describeUi(gui)}${detail===undefined?'':`; ${JSON.stringify(detail)}`}`,{cause:error});
  }
}

/** Use the visible public workspace menu; never adopt a hidden header control. */
export async function workspaceAction(gui:NativeGui,name:string) {
  const browser=gui.browser!,opener=await browser.$('button[aria-label="Workspace tools"]');
  await opener.click();
  const menu=await browser.$('[role="dialog"][aria-label="Workspace tools"]');await menu.waitForDisplayed();
  // Tool groups are carousel pages; only the shown page takes clicks, so turn to the owner first.
  const owner=await browser.execute((name:string)=>Array.from(document.querySelectorAll('[role="dialog"][aria-label="Workspace tools"] .workspace-tools-page'))
    .find(page=>Array.from(page.querySelectorAll('button')).some(button=>button.textContent?.trim()===name))?.id??'',name);
  let scope:Terminal=menu;
  if(owner) {
    const tab=await menu.$(`[role="tab"][aria-controls="${owner}"]`);
    if(await tab.isExisting() && await tab.getAttribute('aria-selected')!=='true')await tab.click();
    await browser.waitUntil(()=>browser.execute((id:string)=>{
      const page=document.getElementById(id) as HTMLElement|null,track=page?.parentElement;
      return !!page && !!track && !page.inert && Math.abs(page.getBoundingClientRect().left-track.getBoundingClientRect().left)<2;
    },owner),{timeout:5000,timeoutMsg:`Workspace tools page for ${name} did not settle`});
    scope=await menu.$(`#${owner}`);
  }
  const action=await scope.$(`button=${name}`);await action.waitForDisplayed();await action.click();
  return opener;
}

/** Names of every control in the visible Workspace tools menu, across its pages; leaves the menu closed. */
export async function workspaceToolNames(gui:NativeGui) {
  const browser=gui.browser!,opener=await browser.$('button[aria-label="Workspace tools"]');
  await opener.click();
  const menu=await browser.$('[role="dialog"][aria-label="Workspace tools"]');await menu.waitForDisplayed();
  const names=await browser.execute(()=>Array.from(document.querySelectorAll('[role="dialog"][aria-label="Workspace tools"] .workspace-tools-page button'))
    .map(button=>(button.getAttribute('aria-label')||button.textContent||'').trim()));
  await browser.keys('Escape');await menu.waitForDisplayed({reverse:true});
  return names;
}

export async function typeText(browser:NonNullable<NativeGui['browser']>,text:string) {
  const action=browser.action('key');
  // keys([...]) holds the entire sequence as a chord; controlled fields need individual presses.
  for(const value of text){const key=value==='\n'?'\uE007':value;action.down(key).up(key).pause(10);}
  await action.perform();
}

export async function enterOwnedKey(gui:NativeGui,ssh:SshFixture,connect:Terminal,recovery=false) {
  return enterKey(gui,ssh,connect,recovery,false);
}
async function enterKey(gui:NativeGui,ssh:SshFixture,connect:Terminal,recovery:boolean,rememberKey:boolean) {
  const browser=gui.browser!;
  await (await connect.$('button=Private key')).click();
  const remember=await connect.$('input[type="checkbox"]');
  if(recovery)expect(await remember.isExisting()).toBe(false);
  else {expect(await remember.isSelected()).toBe(false);if(rememberKey){await remember.click();expect(await remember.isSelected()).toBe(true);}}
  const keyInput=await connect.$('textarea');
  expect(await keyInput.getValue()==='').toBe(true);
  // Enter key events keep multiline input on the native keyboard path.
  try{await keyInput.click();await typeText(browser,ssh.privateKey);}
  catch{throw new Error('Owned SSH private-key input failed');}
  const entered=await keyInput.getValue();
  if(entered!==ssh.privateKey)throw new Error(`Owned SSH private-key input mismatch (${entered===''?'empty':entered.replace(/\s/g,'')===ssh.privateKey.replace(/\s/g,'')?'whitespace':'content'})`);
  await (await connect.$(`button=${recovery?'Reconnect uploads':'Connect'}`)).click();
}

export async function openOwnedSsh(gui:NativeGui,ssh:SshFixture,transport:'ssh'|'mosh'='ssh',port=ssh.port,entry?:NonNullable<import('../src/bridge').Host['defaultMultiplexer']>,name:OwnedHostLabel='Owned SSH GUI host') {
  return openSsh(gui,ssh,transport,port,entry,false,name);
}
export async function openOwnedRememberedSsh(gui:NativeGui,ssh:SshFixture,entry?:NonNullable<import('../src/bridge').Host['defaultMultiplexer']>,port=ssh.port) {
  return openSsh(gui,ssh,'ssh',port,entry,true);
}
export async function openOwnedRememberedMosh(gui:NativeGui,ssh:SshFixture,entry:NonNullable<import('../src/bridge').Host['defaultMultiplexer']>,port=ssh.port) {
  return openSsh(gui,ssh,'mosh',port,entry,true);
}
/** `supply` chooses the identity in the open connection dialog and presses Connect itself. */
export async function openOwnedSshWith(gui:NativeGui,ssh:SshFixture,supply:(connect:Terminal)=>Promise<void>) {
  return openSsh(gui,ssh,'ssh',ssh.port,undefined,false,'Owned SSH GUI host',supply);
}
/** Save a host through the visible editor without connecting; its generated ID is read from the saved file. */
export async function saveOwnedSshHost(gui:NativeGui,ssh:SshFixture,transport:'ssh'|'mosh',port:number,entry?:NonNullable<import('../src/bridge').Host['defaultMultiplexer']>,name:OwnedHostLabel='Owned SSH GUI host') {
  const browser=gui.browser!;
  gui.stage='owned SSH host editor';
  const add=await browser.$('button[aria-label="Add host"]');await add.waitForDisplayed({timeout:30_000});await add.click();
  const editor=await browser.$('[role="dialog"][aria-label="Add a host"]');await editor.waitForDisplayed();
  await (await editor.$('input[placeholder="Home workstation"]')).setValue(name);
  await (await editor.$('input[placeholder="workstation.local"]')).setValue('127.0.0.1');
  await (await editor.$('label.port-field input')).setValue(String(port));
  await (await editor.$('input[placeholder="Your SSH username"]')).setValue(ssh.username);
  if(entry) {
    await (await (await editor.$('label*=Default multiplexer')).$('select')).selectByAttribute('value',entry.kind);
    await (await editor.$('input[maxlength="200"]')).setValue(entry.name);
  }
  await (await (await editor.$('label*=Preferred transport')).$('select')).selectByAttribute('value',transport);
  await (await editor.$('button=Save host')).click();await editor.waitForDisplayed({reverse:true});
}
/** The generated ID of a host saved through the editor, as the native app stored it. */
export async function savedOwnedHostId(gui:NativeGui,name:OwnedHostLabel='Owned SSH GUI host') {
  const hosts:{id:string;name:string}[]=JSON.parse(await readFile(join(gui.directory,'config','app.lazysh.client','hosts.json'),'utf8'));
  const matches=hosts.filter(host=>host.name===name);
  if(matches.length!==1)throw new Error('Owned saved host was not stored exactly once');
  return matches[0].id;
}
/** Review the exact ephemeral server fingerprint, then trust it for this connection. */
export async function trustOwnedHostKey(gui:NativeGui,ssh:SshFixture) {
  gui.stage='owned SSH explicit fingerprint review';
  const browser=gui.browser!,trust=await browser.$('[role="dialog"][aria-label="Verify this host"]');
  try {await trust.waitForDisplayed({timeout:20_000});}
  catch(error) {
    // Only structural state: the open connection dialog may still contain the private key.
    try {
      const state=await browser.execute(()=>{
        const dialog=document.querySelector('[role="dialog"][aria-label^="Connect to "]');
        const button=Array.from(dialog?.querySelectorAll('button')??[]).find(item=>item.textContent?.trim()==='Connect');
        return {connectionDialog:!!dialog,connectDisabled:button?.disabled??null,alertPresent:!!dialog?.querySelector('[role="alert"]')};
      });
      console.info('Owned SSH fingerprint wait state',JSON.stringify(state));
    } catch { /* The diagnostic must not replace the fingerprint timeout. */ }
    throw error;
  }
  expect(await trust.getText()).toContain(ssh.fingerprint);
  await (await trust.$('button=Trust key and connect')).click();
}
async function openSsh(gui:NativeGui,ssh:SshFixture,transport:'ssh'|'mosh',port:number,entry:NonNullable<import('../src/bridge').Host['defaultMultiplexer']>|undefined,rememberKey:boolean,name:OwnedHostLabel='Owned SSH GUI host',supply?:(connect:Terminal)=>Promise<void>) {
  const browser=gui.browser!,owner=await gui.appOwner();
  await saveOwnedSshHost(gui,ssh,transport,port,entry,name);
  gui.stage='owned SSH manual key';
  await (await browser.$(`button[aria-label=${JSON.stringify(`Connect to ${name}`)}]`)).click();
  const connect=await browser.$(`[role="dialog"][aria-label=${JSON.stringify(`Connect to ${name}`)}]`);await connect.waitForDisplayed();
  expect(await (await connect.$('select')).getValue()).toBe(transport);
  await (supply?supply(connect):enterKey(gui,ssh,connect,false,rememberKey));
  await trustOwnedHostKey(gui,ssh);
  gui.stage='owned SSH terminal prompt';
  const terminalName=entry?`${name} / ${entry.name}`:name;
  const terminal=await browser.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for ${terminalName}`)}] .xterm-screen`);
  await browser.waitUntil(async()=>{
    const alert=await browser.$('[role="dialog"] .inline-error[role="alert"]');
    if(await alert.isDisplayed()) {
      const text=await alert.getText();
      const category=/authenticat/i.test(text)?'authentication':/key|decrypt|decode/i.test(text)?'key':/timed? out|timeout/i.test(text)?'timeout':/channel|pty|shell/i.test(text)?'channel':/disconnect|closed/i.test(text)?'disconnected':'other';
      throw new Error(`Owned SSH connection failed (${category})`);
    }
    return terminal.isDisplayed();
  },{timeout:20_000,timeoutMsg:'Owned SSH terminal was not displayed'});
  // Mosh starts the login shell; its caller proves readiness with the fresh challenge.
  if(transport==='ssh' && !entry)await browser.waitUntil(async()=>(await terminal.getText()).includes(ssh!.prompt),{timeout:20_000,timeoutMsg:'Owned SSH prompt was not observed'});
  expect(await gui.appOwner()).toEqual(owner);
  expect(ssh.challenge).not.toContain(ssh.expected);
  return {browser,terminal,owner};
}

export async function challengeOwnedSsh(gui:NativeGui,ssh:SshFixture,terminal:Terminal,owner:Owner,checkpoint:boolean|'AFTER_CLOSURE'|'AFTER_RECOVERY'|'AFTER_SAVED_RECONNECT'|'AFTER_WORKSPACES'|'AFTER_PALETTE'=false) {
  const browser=gui.browser!;
  const suffix=typeof checkpoint==='string'?`_${checkpoint}`:checkpoint?'_AFTER_INSTALL':'';
  const expected=ssh.expected+suffix;
  const challenge=suffix?`printf 'SSH_%s_END${suffix}\\n' '${ssh.nonce}'`:ssh.challenge;
  expect(challenge).not.toContain(expected);
  gui.stage='owned SSH typed challenge';
  await terminal.click();await typeText(browser,`${challenge}\n`);
  await browser.waitUntil(async()=>(await terminal.getText()).includes(expected),{timeout:20_000,timeoutMsg:'Owned SSH challenge output was not observed'});
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
}

/**
 * Replace the shell with the fixture's raw receiver, which writes every byte it reads to a file. Returns a reader of
 * those bytes that refuses to answer for a different process or image than the one it started.
 */
export async function startOwnedReceiver(gui:NativeGui,ssh:SshFixture,terminal:Terminal,receiverBinary:string,label:string) {
  const browser=gui.browser!;
  gui.stage=`owned ${label} raw receiver`;
  const image=join(ssh.directory,'bin','owned-terminal-receiver'),imageStat=await stat(image);
  const imageHash=createHash('sha256').update(await readFile(image)).digest('hex');
  expect(imageHash).toBe(createHash('sha256').update(await readFile(receiverBinary)).digest('hex'));
  await terminal.click();await typeText(browser,'exec ./bin/owned-terminal-receiver .\n');
  let receiver:OwnedPid|undefined;
  await browser.waitUntil(async()=>{
    const text=await readFile(join(ssh.directory,'receiver-pid'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
    if(!/^[1-9][0-9]{0,9}\n$/.test(text))return false;
    receiver=await identity(Number(text.trim()));return !!receiver&&!['Z','X'].includes(receiver.state);
  },{timeout:3000,timeoutMsg:`Owned ${label} receiver was not ready`});
  const original=receiver!;
  let ancestor:OwnedPid|undefined=original,owned=false;
  for(let depth=0;ancestor&&depth<16;depth++){
    if(ancestor.pid===ssh.daemon.child.pid){owned=true;break;}
    ancestor=await identity(ancestor.parent);
  }
  expect(owned).toBe(true);
  const bytes=async()=>{
    const current=await identity(original.pid),executable=await stat(`/proc/${original.pid}/exe`);
    if(!current||current.start!==original.start||['Z','X'].includes(current.state)||executable.dev!==imageStat.dev||executable.ino!==imageStat.ino)
      throw new Error(`Owned ${label} receiver identity changed`);
    const path=join(ssh.directory,'received-bytes'),info=await stat(path);
    if(!info.isFile()||info.uid!==process.getuid!()||info.size>4096)throw new Error(`Owned ${label} receiver output invalid`);
    const value=await readFile(path);if(value.length>4096)throw new Error(`Owned ${label} receiver output exceeds bound`);return value;
  };
  expect(await bytes()).toEqual(Buffer.alloc(0));
  return {bytes,image,imageHash};
}

export async function disconnectOwnedSsh(gui:NativeGui,terminal:Terminal,name='Owned SSH GUI host') {
  gui.stage='owned SSH explicit disconnect';
  await workspaceAction(gui,`End ${name} connection`);
  await terminal.waitForDisplayed({reverse:true});
}

/** The shared end of an owned Herdr GUI case: a single tab, the original app owner, no extra connection, no stray terminal bytes, then the explicit disconnect. */
export async function finishOwnedHerdr(gui:NativeGui,browser:NonNullable<NativeGui['browser']>,terminal:Terminal,owner:Owner,herdr:{name:string;expectBytes(bytes:Buffer):Promise<unknown>}) {
  expect(await browser.$$('[role="tab"]')).toHaveLength(1);
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
  await herdr.expectBytes(Buffer.alloc(0));
  await disconnectOwnedSsh(gui,terminal,`Owned SSH GUI host / ${herdr.name}`);
}

async function cleanupOwnedSshGui(window:NativeGui|undefined,server:Pick<SshFixture,'stop'>|undefined,failed:boolean,captureSafe:boolean) {
  if(failed && window) {
    console.error(`Owned SSH GUI failure stage: ${window.stage}`);
    if(captureSafe)try{await window.screenshot();}catch{console.error('Owned SSH GUI screenshot unavailable');}
  }
  const failures:unknown[]=[];
  try{await window?.stop();}catch(error){failures.push(error);}
  try{await server?.stop();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Owned SSH GUI cleanup failed');
}

/** An owned SSH server whose managed companion path holds `image`, by default the current-source companion (`LAZYSH_TEST_AGENT_BIN`); `tmux` adds a real tmux (the system one, or the binary it names) in the same owned root. */
export async function ownedCompanionSsh(fixture:ReturnType<typeof ownedSshGui>,image?:Buffer,options:{tmux?:boolean|string}={}) {
  if(!image) {
    const source=process.env.LAZYSH_TEST_AGENT_BIN;
    if(!source?.startsWith('/'))throw new Error('An owned current-source companion binary is required');
    image=await readFile(source);
  }
  const ssh=await SshFixture.start(undefined,{companion:true,privateTtyGroup:true,...options});fixture.ssh=ssh;
  const companion=join(ssh.directory,'data/lazysh/companion/lazysh-agent');
  await mkdir(dirname(companion),{recursive:true,mode:0o700});await writeFile(companion,image,{flag:'wx',mode:0o700});await chmod(companion,0o700);
  return {ssh,companion};
}

export function ownedSshGui() {
  const fixture:{gui?:NativeGui;ssh?:Pick<SshFixture,'stop'>;captureSafe:boolean}={captureSafe:false};
  afterEach(async context=>{
    const {gui,ssh,captureSafe}=fixture;fixture.gui=undefined;fixture.ssh=undefined;
    await cleanupOwnedSshGui(gui,ssh,context.task.result?.state==='fail',captureSafe);
  });
  return fixture;
}

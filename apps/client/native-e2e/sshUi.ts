import {afterEach,expect} from 'vitest';
import {chmod,copyFile,mkdir} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';

type Terminal=Awaited<ReturnType<NonNullable<NativeGui['browser']>['$']>>;
type Owner=Awaited<ReturnType<NativeGui['appOwner']>>;
type OwnedHostLabel='Owned SSH GUI host'|'Owned SSH GUI second host';

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
/** `supply` chooses the identity in the open connection dialog and presses Connect itself. */
export async function openOwnedSshWith(gui:NativeGui,ssh:SshFixture,supply:(connect:Terminal)=>Promise<void>) {
  return openSsh(gui,ssh,'ssh',ssh.port,undefined,false,'Owned SSH GUI host',supply);
}
async function openSsh(gui:NativeGui,ssh:SshFixture,transport:'ssh'|'mosh',port:number,entry:NonNullable<import('../src/bridge').Host['defaultMultiplexer']>|undefined,rememberKey:boolean,name:OwnedHostLabel='Owned SSH GUI host',supply?:(connect:Terminal)=>Promise<void>) {
  const browser=gui.browser!,owner=await gui.appOwner();
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
  gui.stage='owned SSH manual key';
  await (await browser.$(`button[aria-label=${JSON.stringify(`Connect to ${name}`)}]`)).click();
  const connect=await browser.$(`[role="dialog"][aria-label=${JSON.stringify(`Connect to ${name}`)}]`);await connect.waitForDisplayed();
  expect(await (await connect.$('select')).getValue()).toBe(transport);
  await (supply?supply(connect):enterKey(gui,ssh,connect,false,rememberKey));
  gui.stage='owned SSH explicit fingerprint review';
  const trust=await browser.$('[role="dialog"][aria-label="Verify this host"]');await trust.waitForDisplayed({timeout:20_000});
  expect(await trust.getText()).toContain(ssh.fingerprint);
  await (await trust.$('button=Trust key and connect')).click();
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

export async function challengeOwnedSsh(gui:NativeGui,ssh:SshFixture,terminal:Terminal,owner:Owner,checkpoint:boolean|'AFTER_CLOSURE'|'AFTER_RECOVERY'|'AFTER_SAVED_RECONNECT'|'AFTER_WORKSPACES'=false) {
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

export async function disconnectOwnedSsh(gui:NativeGui,terminal:Terminal,name='Owned SSH GUI host') {
  gui.stage='owned SSH explicit disconnect';
  await workspaceAction(gui,`End ${name} connection`);
  await terminal.waitForDisplayed({reverse:true});
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

/** An owned SSH server whose managed companion path holds the current-source companion (`LAZYSH_TEST_AGENT_BIN`). */
export async function ownedCompanionSsh(fixture:ReturnType<typeof ownedSshGui>) {
  const source=process.env.LAZYSH_TEST_AGENT_BIN;
  if(!source?.startsWith('/'))throw new Error('An owned current-source companion binary is required');
  const ssh=await SshFixture.start(undefined,{companion:true,privateTtyGroup:true});fixture.ssh=ssh;
  const companion=join(ssh.directory,'data/lazysh/companion/lazysh-agent');
  await mkdir(dirname(companion),{recursive:true,mode:0o700});await copyFile(source,companion);await chmod(companion,0o700);
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

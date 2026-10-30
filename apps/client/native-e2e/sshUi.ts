import {afterEach,expect} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';

type Terminal=Awaited<ReturnType<NonNullable<NativeGui['browser']>['$']>>;
type Owner=Awaited<ReturnType<NativeGui['appOwner']>>;

export async function typeText(browser:NonNullable<NativeGui['browser']>,text:string) {
  const action=browser.action('key');
  // keys([...]) holds the entire sequence as a chord; controlled fields need individual presses.
  for(const value of text){const key=value==='\n'?'\uE007':value;action.down(key).up(key).pause(10);}
  await action.perform();
}

export async function enterOwnedKey(gui:NativeGui,ssh:SshFixture,connect:Terminal,recovery=false) {
  const browser=gui.browser!;
  await (await connect.$('button=Private key')).click();
  const remember=await connect.$('input[type="checkbox"]');
  if(recovery)expect(await remember.isExisting()).toBe(false);
  else expect(await remember.isSelected()).toBe(false);
  const keyInput=await connect.$('textarea');
  expect(await keyInput.getValue()==='').toBe(true);
  // Enter key events keep multiline input on the native keyboard path.
  try{await keyInput.click();await typeText(browser,ssh.privateKey);}
  catch{throw new Error('Owned SSH private-key input failed');}
  const entered=await keyInput.getValue();
  if(entered!==ssh.privateKey)throw new Error(`Owned SSH private-key input mismatch (${entered===''?'empty':entered.replace(/\s/g,'')===ssh.privateKey.replace(/\s/g,'')?'whitespace':'content'})`);
  await (await connect.$(`button=${recovery?'Reconnect uploads':'Connect'}`)).click();
}

export async function openOwnedSsh(gui:NativeGui,ssh:SshFixture,transport:'ssh'|'mosh'='ssh',port=ssh.port) {
  const browser=gui.browser!,owner=await gui.appOwner();
  gui.stage='owned SSH host editor';
  const add=await browser.$('button[aria-label="Add host"]');await add.waitForDisplayed({timeout:30_000});await add.click();
  const editor=await browser.$('[role="dialog"][aria-label="Add a host"]');await editor.waitForDisplayed();
  await (await editor.$('input[placeholder="Home workstation"]')).setValue('Owned SSH GUI host');
  await (await editor.$('input[placeholder="workstation.local"]')).setValue('127.0.0.1');
  await (await editor.$('label.port-field input')).setValue(String(port));
  await (await editor.$('input[placeholder="Your SSH username"]')).setValue(ssh.username);
  await (await (await editor.$('label*=Preferred transport')).$('select')).selectByAttribute('value',transport);
  await (await editor.$('button=Save host')).click();await editor.waitForDisplayed({reverse:true});
  gui.stage='owned SSH manual key';
  await (await browser.$('button[aria-label="Connect to Owned SSH GUI host"]')).click();
  const connect=await browser.$('[role="dialog"][aria-label="Connect to Owned SSH GUI host"]');await connect.waitForDisplayed();
  expect(await (await connect.$('select')).getValue()).toBe(transport);
  await enterOwnedKey(gui,ssh,connect);
  gui.stage='owned SSH explicit fingerprint review';
  const trust=await browser.$('[role="dialog"][aria-label="Verify this host"]');await trust.waitForDisplayed({timeout:20_000});
  expect(await trust.getText()).toContain(ssh.fingerprint);
  await (await trust.$('button=Trust key and connect')).click();
  gui.stage='owned SSH terminal prompt';
  const terminal=await browser.$('.terminal-canvas .xterm-screen');
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
  if(transport==='ssh')await browser.waitUntil(async()=>(await terminal.getText()).includes(ssh!.prompt),{timeout:20_000,timeoutMsg:'Owned SSH prompt was not observed'});
  expect(await gui.appOwner()).toEqual(owner);
  expect(ssh.challenge).not.toContain(ssh.expected);
  return {browser,terminal,owner};
}

export async function challengeOwnedSsh(gui:NativeGui,ssh:SshFixture,terminal:Terminal,owner:Owner,checkpoint:boolean|'AFTER_CLOSURE'|'AFTER_RECOVERY'=false) {
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

export async function disconnectOwnedSsh(gui:NativeGui,terminal:Terminal) {
  const browser=gui.browser!;
  gui.stage='owned SSH explicit disconnect';
  await (await browser.$('button[aria-label="End Owned SSH GUI host connection"]')).click();
  await terminal.waitForDisplayed({reverse:true});
}

async function cleanupOwnedSshGui(window:NativeGui|undefined,server:SshFixture|undefined,failed:boolean,captureSafe:boolean) {
  if(failed && window) {
    console.error(`Owned SSH GUI failure stage: ${window.stage}`);
    if(captureSafe)try{await window.screenshot();}catch{console.error('Owned SSH GUI screenshot unavailable');}
  }
  const failures:unknown[]=[];
  try{await window?.stop();}catch(error){failures.push(error);}
  try{await server?.stop();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Owned SSH GUI cleanup failed');
}

export function ownedSshGui() {
  const fixture:{gui?:NativeGui;ssh?:SshFixture;captureSafe:boolean}={captureSafe:false};
  afterEach(async context=>{
    const {gui,ssh,captureSafe}=fixture;fixture.gui=undefined;fixture.ssh=undefined;
    await cleanupOwnedSshGui(gui,ssh,context.task.result?.state==='fail',captureSafe);
  });
  return fixture;
}

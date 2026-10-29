import {afterEach,expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';

let gui:NativeGui|undefined,ssh:SshFixture|undefined;
let captureSafe=false;
afterEach(async context=>{
  const window=gui,server=ssh;gui=undefined;ssh=undefined;
  if(context.task.result?.state==='fail' && window) {
    console.error(`Owned SSH GUI failure stage: ${window.stage}`);
    if(captureSafe)try{await window.screenshot();}catch{console.error('Owned SSH GUI screenshot unavailable');}
  }
  const failures:unknown[]=[];
  try{await window?.stop();}catch(error){failures.push(error);}
  try{await server?.stop();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Owned SSH GUI cleanup failed');
});

it('trusts the exact ephemeral server and types a non-echoable challenge through the bundled SSH terminal',async()=>{
  captureSafe=false;
  ssh=await SshFixture.start();
  gui=await NativeGui.start();const browser=gui.browser!;
  const owner=await gui.appOwner();
  gui.stage='owned SSH host editor';
  const add=await browser.$('button[aria-label="Add host"]');await add.waitForDisplayed({timeout:30_000});await add.click();
  const editor=await browser.$('[role="dialog"][aria-label="Add a host"]');await editor.waitForDisplayed();
  await (await editor.$('input[placeholder="Home workstation"]')).setValue('Owned SSH GUI host');
  await (await editor.$('input[placeholder="workstation.local"]')).setValue('127.0.0.1');
  await (await editor.$('label.port-field input')).setValue(String(ssh.port));
  await (await editor.$('input[placeholder="Your SSH username"]')).setValue(ssh.username);
  await (await (await editor.$('label*=Preferred transport')).$('select')).selectByAttribute('value','ssh');
  await (await editor.$('button=Save host')).click();await editor.waitForDisplayed({reverse:true});
  gui.stage='owned SSH manual key';
  await (await browser.$('button[aria-label="Connect to Owned SSH GUI host"]')).click();
  const connect=await browser.$('[role="dialog"][aria-label="Connect to Owned SSH GUI host"]');await connect.waitForDisplayed();
  expect(await (await connect.$('select')).getValue()).toBe('ssh');
  await (await connect.$('button=Private key')).click();
  expect(await (await connect.$('input[type="checkbox"]')).isSelected()).toBe(false);
  try{await (await connect.$('textarea')).setValue(ssh.privateKey);}
  catch{throw new Error('Owned SSH private-key input failed');}
  expect(await (await connect.$('textarea')).getValue()===ssh.privateKey).toBe(true);
  await (await connect.$('button=Connect')).click();
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
  captureSafe=true;
  await browser.waitUntil(async()=>(await terminal.getText()).includes(ssh!.prompt),{timeout:20_000,timeoutMsg:'Owned SSH prompt was not observed'});
  expect(await gui.appOwner()).toEqual(owner);
  expect(ssh.challenge).not.toContain(ssh.expected);
  gui.stage='owned SSH typed challenge';
  await terminal.click();await browser.keys([...ssh.challenge,'\uE007']);
  await browser.waitUntil(async()=>(await terminal.getText()).includes(ssh!.expected),{timeout:20_000,timeoutMsg:'Owned SSH challenge output was not observed'});
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
  gui.stage='owned SSH explicit disconnect';
  await (await browser.$('button[aria-label="End Owned SSH GUI host connection"]')).click();
  await terminal.waitForDisplayed({reverse:true});
});

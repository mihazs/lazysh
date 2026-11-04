import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {openOwnedRememberedSsh,ownedSshGui,typeText} from './sshUi';

const fixture=ownedSshGui();
// The typed echo keeps `%s`; only the pane's own printf resolves the pane ID and shell PID.
const probe=(tag:string)=>`printf 'PANE<%s:%s:${tag}>\\n' "$TMUX_PANE" "$$"\n`;
const paneIdentity=(text:string,tag:string)=>text.match(new RegExp(`PANE<(%[0-9]+):([1-9][0-9]*):${tag}>`))?.slice(1,3).join(':');

it('restores the same durable tmux pane after the app is killed, only after explicit restore',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmux:true});
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  const name=`restore-${ssh.nonce.slice(0,12)}`;
  const clients=async()=>(await ssh.tmux(['list-clients','-F','#{client_tty}'])).split('\n').filter(Boolean).length;
  const {browser,terminal}=await openOwnedRememberedSsh(gui,ssh,{kind:'tmux',name});
  await gui.assertDisposableCredential('saved');
  gui.stage='owned tmux pane identity before kill';
  await terminal.click();await typeText(browser,probe('BEFORE'));
  let before:string|undefined;
  await browser.waitUntil(async()=>!!(before=paneIdentity(await terminal.getText(),'BEFORE')),{timeout:20_000,timeoutMsg:'Owned tmux pane identity was not observed'});
  expect(await clients()).toBe(1);
  gui.stage='owned workspace descriptor on disk';
  // Kill only after WebKit has written the descriptor; page memory alone would not survive.
  await browser.waitUntil(()=>gui.profileContains(name),{timeout:20_000,interval:250,timeoutMsg:'Workspace descriptor was not written to the owned profile'});

  gui.stage='owned application kill and relaunch';
  const owner=await gui.killAndRelaunch();
  const relaunched=gui.browser!;
  await relaunched.waitUntil(async()=>await clients()===0,{timeout:20_000,timeoutMsg:'Killed application left its tmux client attached'});
  const banner=await relaunched.$('.workspace-restore');await banner.waitForDisplayed({timeout:30_000});
  const restore=await banner.$('button=Restore previous workspace');
  // Restore stays disabled until the saved hosts load; a click before that is a no-op.
  await restore.waitForEnabled({timeout:20_000});
  for(const canvas of await relaunched.$$('.terminal-canvas .xterm-screen'))expect(await canvas.isDisplayed()).toBe(false);
  // Relaunch alone never reconnects or attaches; the pane keeps running unattended.
  expect(await clients()).toBe(0);

  gui.stage='owned explicit workspace restore';
  await restore.click();
  const restored=await relaunched.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for Owned SSH GUI host / ${name}`)}] .xterm-screen`);
  await restored.waitForDisplayed({timeout:20_000});
  // tmux redraws the surviving pane, including the output written before the kill.
  await relaunched.waitUntil(async()=>paneIdentity(await restored.getText(),'BEFORE')===before,{timeout:20_000,timeoutMsg:'Restored display did not show the original pane output'});
  await restored.click();await typeText(relaunched,probe('AFTER'));
  let after:string|undefined;
  await relaunched.waitUntil(async()=>!!(after=paneIdentity(await restored.getText(),'AFTER')),{timeout:20_000,timeoutMsg:'Restored pane identity was not observed'});
  expect(after).toBe(before);
  expect(await clients()).toBe(1);
  await gui.assertDisposableCredential('unchanged');
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
});

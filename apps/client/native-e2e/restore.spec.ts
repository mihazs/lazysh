import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {openOwnedRememberedSsh,ownedSshGui} from './sshUi';
import {paneIdentity,probePane,tmuxClients} from './tmuxPane';

const fixture=ownedSshGui();

it('restores the same durable tmux pane after the app is killed, only after explicit restore',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmux:true});
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  const name=`restore-${ssh.nonce.slice(0,12)}`;
  const clients=()=>tmuxClients(ssh);
  const {browser,terminal}=await openOwnedRememberedSsh(gui,ssh,{kind:'tmux',name});
  await gui.assertDisposableCredential('saved');
  gui.stage='owned tmux pane identity before kill';
  const before=await probePane(browser,terminal,'BEFORE','Owned tmux pane identity was not observed');
  expect(await clients()).toBe(1);
  gui.stage='owned workspace descriptor on disk';
  // Kill only after WebKit has written the descriptor; page memory alone would not survive.
  await browser.waitUntil(()=>gui.profileContains(name),{timeout:20_000,interval:250,timeoutMsg:'Workspace descriptor was not written to the owned profile'});

  gui.stage='owned application kill and relaunch';
  const owner=await gui.killAndRelaunch();
  const relaunched=gui.browser!;
  // A dead tmux server must not read as a lingering client.
  let tmuxFailure:unknown;
  await relaunched.waitUntil(async()=>{
    try{const attached=await clients();tmuxFailure=undefined;return attached===0;}catch(error){tmuxFailure=error;return false;}
  },{timeout:20_000,timeoutMsg:'Killed application left its tmux client attached'}).catch(error=>{
    throw tmuxFailure?new Error('Owned tmux server unavailable after the application kill',{cause:tmuxFailure}):error;
  });
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
  expect(await probePane(relaunched,restored,'AFTER','Restored pane identity was not observed')).toBe(before);
  expect(await clients()).toBe(1);
  await gui.assertDisposableCredential('unchanged');
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
});

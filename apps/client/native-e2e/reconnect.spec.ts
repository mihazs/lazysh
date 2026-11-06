import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {OwnedSshRelay} from './sshRelay';
import {openOwnedRememberedSsh,ownedSshGui} from './sshUi';
import {paneIdentity,probePane,tmuxClients} from './tmuxPane';

const fixture=ownedSshGui();

it('detects a lost SSH route, retries while it is down and reattaches the same tmux pane when it returns',async()=>{
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,tmux:true});
  const relay=await OwnedSshRelay.start(ssh.port);
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  try {
    const name=`lost-${ssh.nonce.slice(0,12)}`;
    const clients=()=>tmuxClients(ssh);
    const {browser,terminal,owner}=await openOwnedRememberedSsh(gui,ssh,{kind:'tmux',name},relay.port);
    await gui.assertDisposableCredential('saved');
    gui.stage='owned tmux pane identity before the route is cut';
    const before=await probePane(browser,terminal,'BEFORE','Owned tmux pane identity was not observed');
    expect(await clients()).toBe(1);

    gui.stage='owned SSH route cut';
    relay.block();
    const banner=await browser.$(`[role="status"][aria-label=${JSON.stringify(`Connection lost for Owned SSH GUI host / ${name}`)}]`);
    await banner.waitForDisplayed({timeout:60_000,timeoutMsg:'Lost-connection banner was not shown'});
    expect(await banner.getText()).toContain('Connection lost.');
    // The tmux client went with the route; the pane itself keeps running on the host.
    await browser.waitUntil(async()=>await clients()===0,{timeout:20_000,timeoutMsg:'Cut route left its tmux client attached'});

    gui.stage='owned automatic retry while the route is down';
    await browser.waitUntil(async()=>relay.refused>0,{timeout:45_000,interval:250,timeoutMsg:'No reconnect attempt reached the blocked route'});
    expect(await banner.isDisplayed()).toBe(true);

    gui.stage='owned automatic reconnect when the route returns';
    relay.unblock();
    await banner.waitForDisplayed({reverse:true,timeout:75_000,timeoutMsg:'Automatic reconnect did not finish after the route returned'});
    const restored=await browser.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for Owned SSH GUI host / ${name}`)}] .xterm-screen`);
    await restored.waitForDisplayed({timeout:20_000});
    // tmux redraws the surviving pane, including the output written before the loss.
    await browser.waitUntil(async()=>paneIdentity(await restored.getText(),'BEFORE')===before,{timeout:20_000,timeoutMsg:'Reconnected display did not show the original pane output'});
    expect(await probePane(browser,restored,'AFTER','Reconnected pane identity was not observed')).toBe(before);
    expect(await clients()).toBe(1);
    // Saved credentials were reused; nothing new was stored and nothing prompted.
    await gui.assertDisposableCredential('unchanged');
    expect(await gui.appOwner()).toEqual(owner);
    expect(await (await browser.$('[role="dialog"]')).isExisting()).toBe(false);
  } finally {
    await relay.stop();
  }
},240_000);

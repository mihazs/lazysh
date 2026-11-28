import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {openOwnedRememberedSsh,ownedSshGui,workspaceAction} from './sshUi';
import {probePane} from './tmuxPane';
import {muxKits,type MuxKit} from './muxKits';
import {zellijSessions} from './zellijPane';

const fixture=ownedSshGui();

/** Enters `kit`'s multiplexer through the app, kills the app once its descriptor is on disk and relaunches it to the restore offer. */
async function relaunchedAfterKill(kit:MuxKit) {
  fixture.captureSafe=false;
  const ssh=fixture.ssh=await kit.start();
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  const name=`restore-${ssh.nonce.slice(0,12)}`;
  const clients=()=>kit.clients(ssh,name);
  const {browser,terminal}=await openOwnedRememberedSsh(gui,ssh,{kind:kit.kind,name});
  await gui.assertDisposableCredential('saved');
  gui.stage=`owned ${kit.kind} pane identity before kill`;
  const before=await probePane(browser,terminal,'BEFORE',`Owned ${kit.kind} pane identity was not observed`,kit.probe);
  expect(await clients()).toBe(1);
  gui.stage='owned workspace descriptor on disk';
  // Kill only after WebKit has written the descriptor; page memory alone would not survive.
  await browser.waitUntil(()=>gui.profileContains(name),{timeout:20_000,interval:250,timeoutMsg:'Workspace descriptor was not written to the owned profile'});

  gui.stage='owned application kill and relaunch';
  const owner=await gui.killAndRelaunch();
  const relaunched=gui.browser!;
  // A dead multiplexer server must not read as a lingering client.
  let clientFailure:unknown;
  await relaunched.waitUntil(async()=>{
    try{const attached=await clients();clientFailure=undefined;return attached===0;}catch(error){clientFailure=error;return false;}
  },{timeout:20_000,timeoutMsg:`Killed application left its ${kit.kind} client attached`}).catch(error=>{
    throw clientFailure?new Error(`Owned ${kit.kind} server unavailable after the application kill`,{cause:clientFailure}):error;
  });
  const banner=await relaunched.$('.workspace-restore');await banner.waitForDisplayed({timeout:30_000});
  const restore=await banner.$('button=Restore previous workspace');
  // Restore stays disabled until the saved hosts load; a click before that is a no-op.
  await restore.waitForEnabled({timeout:20_000});
  for(const canvas of await relaunched.$$('.terminal-canvas .xterm-screen'))expect(await canvas.isDisplayed()).toBe(false);
  // Relaunch alone never reconnects or attaches; the pane keeps running unattended.
  expect(await clients()).toBe(0);
  return {ssh,gui,name,clients,before,owner,relaunched,restore};
}

it.each(muxKits)('restores the same durable $kind pane after the app is killed, only after explicit restore',async kit=>{
  const {ssh,gui,name,clients,before,owner,relaunched,restore}=await relaunchedAfterKill(kit);

  gui.stage='owned explicit workspace restore';
  await restore.click();
  const restored=await relaunched.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for Owned SSH GUI host / ${name}`)}] .xterm-screen`);
  await restored.waitForDisplayed({timeout:20_000});
  // The multiplexer redraws the surviving pane, including the output written before the kill.
  await relaunched.waitUntil(async()=>kit.probe.identity(await restored.getText(),'BEFORE')===before,{timeout:20_000,timeoutMsg:'Restored display did not show the original pane output'});
  expect(await probePane(relaunched,restored,'AFTER','Restored pane identity was not observed',kit.probe)).toBe(before);
  expect(await clients()).toBe(1);

  gui.stage=`owned Sessions panel reports the host ${kit.kind} version`;
  const version=(await kit.version(ssh)).trim().replace(`${kit.kind} `,'');
  await workspaceAction(gui,'Sessions');
  const panel=await relaunched.$('[aria-label="Multiplexer workspaces"]');await panel.waitForDisplayed({timeout:20_000});
  await relaunched.waitUntil(async()=>(await panel.getText()).includes(`${kit.label} ${version} (`),{timeout:20_000,timeoutMsg:`Sessions panel did not show the real ${kit.kind} version`});
  await gui.assertDisposableCredential('unchanged');
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
});

it('shows the multiplexer-unavailable message for a killed Zellij session and creates none',async()=>{
  const {ssh,gui,name,relaunched,restore}=await relaunchedAfterKill(muxKits.find(kit=>kit.kind==='zellij')!);

  gui.stage='owned Zellij session killed while the app is closed';
  await ssh.zellij(['kill-session',name]);
  expect(await zellijSessions(ssh)).toEqual([]);

  gui.stage='owned explicit restore of a killed Zellij session';
  await restore.click();
  const failure=await relaunched.$('.global-error');
  await failure.waitForDisplayed({timeout:30_000,timeoutMsg:'Restoring a killed Zellij session showed no error'});
  expect(await failure.getText()).toContain('Cannot enter the selected multiplexer');
  // Restore never creates: no empty session replaced the killed one, and no terminal opened for it.
  expect(await zellijSessions(ssh)).toEqual([]);
  for(const canvas of await relaunched.$$('.terminal-canvas .xterm-screen'))expect(await canvas.isDisplayed()).toBe(false);
  // The descriptor stays offered, so a later restore can still reach a session that returns.
  expect(await restore.isDisplayed()).toBe(true);
  expect(gui.connections).toBe(0);
});

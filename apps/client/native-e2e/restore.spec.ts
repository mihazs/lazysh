import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {HerdrFixture,herdrTools} from '../../../tests/support/androidHerdr';
import {herdrClients,herdrPanes} from './herdrPane';
import {openOwnedRememberedSsh,ownedSshGui,typeText,workspaceAction} from './sshUi';
import {paneIdentity,probePane,tmuxClients} from './tmuxPane';

const fixture=ownedSshGui();

/** Kills the app once its descriptor is on disk, relaunches it and returns the offered, still unclicked restore. */
async function killAndRelaunchToOffer(gui:NativeGui,name:string,clients:()=>Promise<number>,tool:'tmux'|'Herdr') {
  gui.stage='owned workspace descriptor on disk';
  // Kill only after WebKit has written the descriptor; page memory alone would not survive.
  await gui.browser!.waitUntil(()=>gui.profileContains(name),{timeout:20_000,interval:250,timeoutMsg:'Workspace descriptor was not written to the owned profile'});

  gui.stage='owned application kill and relaunch';
  const owner=await gui.killAndRelaunch();
  const relaunched=gui.browser!;
  // A dead host server must not read as a lingering client.
  let failure:unknown;
  await relaunched.waitUntil(async()=>{
    try{const attached=await clients();failure=undefined;return attached===0;}catch(error){failure=error;return false;}
  },{timeout:20_000,timeoutMsg:`Killed application left its ${tool} client attached`}).catch(error=>{
    throw failure?new Error(`Owned ${tool} server unavailable after the application kill`,{cause:failure}):error;
  });
  const banner=await relaunched.$('.workspace-restore');await banner.waitForDisplayed({timeout:30_000});
  const restore=await banner.$('button=Restore previous workspace');
  // Restore stays disabled until the saved hosts load; a click before that is a no-op.
  await restore.waitForEnabled({timeout:20_000});
  for(const canvas of await relaunched.$$('.terminal-canvas .xterm-screen'))expect(await canvas.isDisplayed()).toBe(false);
  // Relaunch alone never reconnects or attaches; the pane keeps running unattended.
  expect(await clients()).toBe(0);
  return {relaunched,restore,owner};
}

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
  const {relaunched,restore,owner}=await killAndRelaunchToOffer(gui,name,clients,'tmux');

  gui.stage='owned explicit workspace restore';
  await restore.click();
  const restored=await relaunched.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for Owned SSH GUI host / ${name}`)}] .xterm-screen`);
  await restored.waitForDisplayed({timeout:20_000});
  // tmux redraws the surviving pane, including the output written before the kill.
  await relaunched.waitUntil(async()=>paneIdentity(await restored.getText(),'BEFORE')===before,{timeout:20_000,timeoutMsg:'Restored display did not show the original pane output'});
  expect(await probePane(relaunched,restored,'AFTER','Restored pane identity was not observed')).toBe(before);
  expect(await clients()).toBe(1);

  gui.stage='owned Sessions panel reports the host tmux version';
  const version=(await ssh.tmux(['-V'])).trim().replace(/^tmux /,'');
  await workspaceAction(gui,'Sessions');
  const panel=await relaunched.$('[aria-label="Multiplexer workspaces"]');await panel.waitForDisplayed({timeout:20_000});
  await relaunched.waitUntil(async()=>(await panel.getText()).includes(`tmux ${version} (`),{timeout:20_000,timeoutMsg:'Sessions panel did not show the real tmux version'});
  await gui.assertDisposableCredential('unchanged');
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
});

it('restores the same durable Herdr pane after the app is killed, only after explicit restore',async()=>{
  fixture.captureSafe=false;
  const herdr=await HerdrFixture.start(herdrTools());fixture.ssh=herdr;
  const gui=fixture.gui=await NativeGui.startWithDisposableVault();
  const clients=()=>herdrClients(herdr);
  const {browser,terminal}=await openOwnedRememberedSsh(gui,herdr.ssh,{kind:'herdr',name:herdr.name});
  await gui.assertDisposableCredential('saved');
  gui.stage='owned Herdr pane identity before kill';
  const before=await herdrPanes(herdr);
  expect(await clients()).toBe(1);
  // The original receiver pane takes the typed bytes; its process and byte log outlive the app.
  await terminal.click();await typeText(browser,'BEFORE');
  await herdr.expectBytes(Buffer.from('BEFORE'));

  const {relaunched,restore,owner}=await killAndRelaunchToOffer(gui,herdr.name,clients,'Herdr');
  await herdr.expectBytes(Buffer.from('BEFORE'));
  expect(await herdrPanes(herdr)).toEqual(before);
  gui.stage='owned explicit workspace restore';
  await restore.click();
  const restored=await relaunched.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for Owned SSH GUI host / ${herdr.name}`)}] .xterm-screen`);
  await restored.waitForDisplayed({timeout:20_000});
  await relaunched.waitUntil(async()=>await clients()===1,{timeout:20_000,timeoutMsg:'Restore did not attach one Herdr client'});
  // The same receiver process gets the new bytes after the old ones: restore attached the surviving pane.
  await restored.click();await typeText(relaunched,'AFTER');
  await herdr.expectBytes(Buffer.from('BEFOREAFTER'));
  expect(await herdrPanes(herdr)).toEqual(before);
  await gui.assertDisposableCredential('unchanged');
  expect(await gui.appOwner()).toEqual(owner);
  expect(gui.connections).toBe(0);
},180_000);

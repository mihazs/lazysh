import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {challengeOwnedSsh,openOwnedSsh,ownedSshGui,workspaceAction} from './sshUi';
import {probePane,rmuxClients} from './tmuxPane';

const fixture=ownedSshGui();

/** The Jump To panel of the active terminal; Workspace tools reopens it when a jump closed it. */
async function jumpTo(gui:NativeGui) {
  const panel=await gui.browser!.$('section[aria-label$="Jump To"]');
  if(!await panel.isDisplayed())await workspaceAction(gui,'Jump To');
  await panel.waitForDisplayed({timeout:20_000});
  return panel;
}

it('attaches a real rmux session from Sessions, switches its windows with Jump To and leaves it running with no client after its tab closes',async()=>{
  fixture.captureSafe=false;
  // CI installs the pinned rmux release with its install.sh and exports the path of the installed binary.
  const binary=process.env.LAZYSH_TEST_RMUX;
  if(!binary?.startsWith('/'))throw new Error('An owned pinned rmux binary is required (LAZYSH_TEST_RMUX)');
  const ssh=fixture.ssh=await SshFixture.start(undefined,{privateTtyGroup:true,rmux:binary,shellSeconds:150});
  const name=`rmux-${ssh.nonce.slice(0,12)}`,tab=`Owned SSH GUI host / ${name}`;
  // Created through sshd so the daemon lives in the fixture's PID namespace; `-d` keeps the first window current.
  await (await ssh.client(true,`rmux -u -L default new-session -d -s ${name} -n first && rmux -u -L default new-window -d -t ${name} -n second`)).finish('owned rmux session',20_000);
  const pane=async(window:string)=>(await ssh.rmux(['list-panes','-t',`${name}:${window}`,'-F','#{pane_id}:#{pane_pid}'])).trim();
  const currentWindow=async()=>(await ssh.rmux(['list-windows','-t',name,'-F','#{window_name}:#{window_active}'])).split('\n').find(row=>row.endsWith(':1'));
  const version=(JSON.parse(await ssh.rmux(['capabilities','--json'])) as {version:string}).version;
  expect(version).toMatch(/^0\.10\./);
  const gui=fixture.gui=await NativeGui.start();
  const {browser,terminal:shell,owner}=await openOwnedSsh(gui,ssh);

  gui.stage='owned Sessions panel reports the real rmux version';
  await workspaceAction(gui,'Sessions');
  const sessions=await browser.$('[aria-label="Multiplexer workspaces"]');await sessions.waitForDisplayed({timeout:20_000});
  await browser.waitUntil(async()=>(await sessions.getText()).includes(`rmux ${version} (Supported)`),{timeout:20_000,timeoutMsg:'Sessions panel did not show the real rmux version as Supported'});
  gui.stage='owned rmux attach from the Sessions panel';
  await (await sessions.$('button=Browse rmux sessions')).click();
  const attach=await sessions.$(`button=Attach ${name}`);await attach.waitForDisplayed({timeout:20_000});await attach.click();
  const terminal=await browser.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for ${tab}`)}] .xterm-screen`);
  await terminal.waitForDisplayed({timeout:20_000});
  gui.stage='owned rmux pane identity before Jump To';
  const first=await probePane(browser,terminal,'FIRST','Owned rmux pane identity was not observed','RMUX_PANE');
  expect(first).toBe(await pane('first'));

  gui.stage='owned rmux Jump To lists the windows and highlights the current one';
  let jump=await jumpTo(gui);
  await (await jump.$('button*=0: first')).waitForClickable({timeout:20_000});
  expect(await (await jump.$('button*=0: first')).getAttribute('aria-current')).toBe('location');
  expect(await (await jump.$('button*=1: second')).getAttribute('aria-current')).toBeNull();
  // One display client and the Jump To control client, both on the attached session.
  await browser.waitUntil(async()=>(await rmuxClients(ssh)).join()===`${name}|0,${name}|1`,{timeout:20_000,timeoutMsg:'Attached rmux session did not hold one display and one control client'});
  gui.stage='owned rmux window switch with Jump To';
  await (await jump.$('button*=1: second')).click();
  await browser.waitUntil(async()=>await currentWindow()==='second:1',{timeout:20_000,timeoutMsg:'Jump To did not move rmux to the second window'});
  const second=await probePane(browser,terminal,'SECOND','Owned rmux pane identity after Jump To was not observed','RMUX_PANE');
  expect(second).toBe(await pane('second'));
  expect(second).not.toBe(first);
  jump=await jumpTo(gui);
  await browser.waitUntil(async()=>(await (await jump.$('button[aria-current="location"]')).getText()).includes('1: second'),{timeout:20_000,timeoutMsg:'Jump To did not highlight the second window'});

  gui.stage='owned rmux tab close';
  await (await browser.$(`button[aria-label=${JSON.stringify(`Disconnect ${tab}`)}]`)).click();
  await terminal.waitForDisplayed({reverse:true,timeout:20_000});
  await browser.waitUntil(async()=>(await rmuxClients(ssh)).length===0,{timeout:20_000,timeoutMsg:'Closed rmux tab left a client attached'});
  // The daemon keeps the session, its window and both pane shells, exactly where Jump To left them.
  expect((await ssh.rmux(['list-sessions','-F','#{session_name}'])).trim()).toBe(name);
  expect((await ssh.rmux(['list-panes','-a','-F','#{pane_id}:#{pane_pid}:#{pane_dead}'])).trim().split('\n')).toEqual([`${first}:0`,`${second}:0`]);
  expect(await currentWindow()).toBe('second:1');
  // Closing the attached terminal leaves the plain SSH connection up.
  await shell.waitForDisplayed({timeout:20_000});
  expect(await browser.$$('[role="tab"]')).toHaveLength(1);
  await challengeOwnedSsh(gui,ssh,shell,owner,'AFTER_CLOSURE');
},180_000);

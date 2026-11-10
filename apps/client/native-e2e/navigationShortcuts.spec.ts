import {expect,it} from 'vitest';
import {NativeGui} from './fixture';
import {ownedSshGui} from './sshUi';
import {setNavigationChord} from './navigationUi';

const fixture=ownedSshGui();

it('persists a changed workspace shortcut and handles it through the native keyboard',async()=>{
  const gui=fixture.gui=await NativeGui.start(),browser=gui.browser!;
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  await gui.secondary(['--dir',gui.directory]);
  await (await browser.$('.terminal-canvas .xterm-screen')).waitForDisplayed({timeout:20_000});
  gui.stage='navigation shortcut settings';
  await setNavigationChord(gui,'C-M-W');

  gui.stage='navigation shortcut restart';
  await gui.killAndRelaunch();
  const restarted=gui.browser!;
  await (await restarted.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  await gui.secondary(['--dir',gui.directory]);
  await (await restarted.$('.terminal-canvas .xterm-screen')).waitForDisplayed({timeout:20_000});
  gui.stage='navigation shortcut dispatch';
  await restarted.action('key').down('\uE009').down('\uE00A').down('w').up('w').up('\uE00A').up('\uE009').perform();
  await restarted.waitUntil(async()=>await (await restarted.$('button[data-workspace-mode="workspaces"]')).getAttribute('aria-current')==='page',{
    timeout:5000,timeoutMsg:'Restored shortcut did not open Workspaces',
  });
  expect(gui.connections).toBe(0);
});

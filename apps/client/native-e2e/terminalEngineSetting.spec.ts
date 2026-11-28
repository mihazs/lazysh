import {expect,it} from 'vitest';
import {join} from 'node:path';
import {NativeGui} from './fixture';
import {ownedSshGui,typeText,workspaceAction} from './sshUi';

const fixture=ownedSshGui();
type Browser=NonNullable<NativeGui['browser']>;

/** Opens a real local session, then Settings, Terminal; returns the dialog and the engine line of that session. */
async function openTerminalSettings(gui:NativeGui,browser:Browser,marker:string) {
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  await gui.secondary(['--dir',join(gui.directory,'home')]);
  const terminal=await browser.$('.terminal-canvas .xterm-screen');
  await terminal.waitForDisplayed({timeout:20_000});
  await terminal.click();
  // Split the literal so shell input echo cannot satisfy the output assertion.
  await typeText(browser,`printf '%s%s\\n' ${marker}- ok\n`);
  await browser.waitUntil(async()=>(await terminal.getText()).includes(`${marker}-ok`),{timeout:20_000,timeoutMsg:'The local PTY did not answer in the chosen engine'});
  await workspaceAction(gui,'Preferences');
  const dialog=await browser.$('[role="dialog"][aria-label="Preferences"]');
  await dialog.waitForDisplayed();
  await (await dialog.$('button[data-settings-target="terminal"]')).click();
  const line=await dialog.$('.terminal-engine-line');
  await line.waitForDisplayed();
  return {dialog,line};
}

it('chooses the terminal engine in Settings, applies it to the next session and keeps it across a restart',async()=>{
  const gui=fixture.gui=await NativeGui.start();
  const browser=gui.browser!;
  fixture.captureSafe=true;

  gui.stage='engine setting under Auto';
  const first=await openTerminalSettings(gui,browser,'engine-auto');
  const radio=(value:string)=>first.dialog.$(`input[name="terminal-engine"][value="${value}"]`);
  // Every platform shows the choice; this build has no usable native surface, so Native is disabled with the reason and Auto resolves to xterm.js.
  expect(await (await radio('auto')).isSelected()).toBe(true);
  expect(await (await radio('native')).isEnabled()).toBe(false);
  expect((await (await first.dialog.$('#terminal-engine-native-off')).getText()).length).toBeGreaterThan(0);
  expect(await first.line.getText()).toMatch(/terminal engine is xterm\.js: /);
  expect(await first.line.getText()).not.toContain('chosen in Settings');

  gui.stage='engine setting chooses xterm.js';
  await (await (await radio('xterm')).$('..')).click();
  expect(await (await radio('xterm')).isSelected()).toBe(true);
  // Restart only after WebKit has written the preference to the owned profile; page memory alone would not survive.
  await browser.waitUntil(()=>gui.profileContains('terminalEngine'),{timeout:20_000,interval:250,timeoutMsg:'The engine choice was not written to the owned profile'});

  gui.stage='engine setting after restart';
  await gui.killAndRelaunch();
  const again=await openTerminalSettings(gui,gui.browser!,'engine-xterm');
  expect(await (await again.dialog.$('input[name="terminal-engine"][value="xterm"]')).isSelected()).toBe(true);
  expect(await again.line.getText()).toContain('terminal engine is xterm.js: chosen in Settings');
  expect(await gui.browser!.$$('[data-terminal-surface="native"]')).toHaveLength(0);
});

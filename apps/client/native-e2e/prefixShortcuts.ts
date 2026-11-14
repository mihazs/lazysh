import {NativeGui} from './fixture';
import {workspaceAction} from './sshUi';

/**
 * Saves `Ctrl+a` as the multiplexer prefix in the Sessions panel, kills and relaunches the app, restores the workspace and
 * returns the relaunched browser with the panel, whose field must show the saved prefix. `terminal` is the restored tab's name.
 */
export async function savePrefixAcrossKill(gui:NativeGui,kind:'tmux'|'herdr',terminal:string) {
  const browser=gui.browser!;
  const region=`section[aria-label="${kind} prefix shortcuts"]`;
  const field='input[placeholder="Ctrl+b"]';
  gui.stage=`owned ${kind} shortcuts save a custom prefix`;
  await workspaceAction(gui,'Sessions');
  const panel=await browser.$(region);await panel.waitForDisplayed({timeout:20_000});
  const prefix=await panel.$(field);
  if(await prefix.getValue()!=='Ctrl+b')throw new Error('The default prefix was not offered');
  await prefix.setValue('Ctrl+a');
  await (await panel.$('button=Save prefix key')).click();
  // Kill only after WebKit has written the saved prefix; page memory alone would not survive.
  await browser.waitUntil(()=>gui.profileContains('Ctrl+a'),{timeout:20_000,interval:250,timeoutMsg:'Saved prefix was not written to the owned profile'});

  gui.stage=`owned application kill and relaunch with the saved ${kind} prefix`;
  await gui.killAndRelaunch();
  const relaunched=gui.browser!;
  // Relaunching alone never reconnects; the saved workspace returns only through the explicit restore control.
  const restore=await (await relaunched.$('.workspace-restore')).$('button=Restore previous workspace');
  await restore.waitForEnabled({timeout:30_000});
  await restore.click();
  const restored=await relaunched.$(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for ${terminal}`)}] .xterm-screen`);
  await restored.waitForDisplayed({timeout:20_000});
  await workspaceAction(gui,'Sessions');
  const shortcuts=await relaunched.$(region);await shortcuts.waitForDisplayed({timeout:20_000});
  if(await (await shortcuts.$(field)).getValue()!=='Ctrl+a')throw new Error('The saved prefix did not persist across the app kill');
  return {relaunched,restored,shortcuts};
}

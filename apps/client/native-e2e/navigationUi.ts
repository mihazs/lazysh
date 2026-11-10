import {NativeGui} from './fixture';
import {workspaceAction} from './sshUi';

export async function setNavigationChord(gui:NativeGui,chord:string) {
  const browser=gui.browser!;
  await workspaceAction(gui,'Preferences');
  const dialog=await browser.$('[role="dialog"][aria-label="Preferences"]');await dialog.waitForDisplayed();
  await (await dialog.$('button[data-settings-target="input"]')).click();
  await (await dialog.$('button[data-settings-target="navigationShortcuts"]')).click();
  const label=await dialog.$('label=Workspaces chord');
  const input=await dialog.$(`[id=${JSON.stringify(await label.getAttribute('for'))}]`);
  await input.setValue(chord);await (await dialog.$('button=Save Workspaces chord')).click();
  await browser.keys('\uE00C');await browser.keys('\uE00C');await browser.keys('\uE00C');await dialog.waitForDisplayed({reverse:true});
}

import {expect,it} from 'vitest';
import {copyFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {NativeGui} from './fixture';
import {ownedSshGui,workspaceAction} from './sshUi';

const fixture=ownedSshGui();
const fixtures=(name:string)=>fileURLToPath(new URL(`../src-tauri/fixtures/${name}`,import.meta.url));
const linked={v:1,name:'Linked by the OS',mode:'light',colors:{background:'#fafafa',foreground:'#121212'}};

/** Starts the real GUI, then opens Preferences, Appearance and the "Import and share theme" section. */
async function enterThemeImport() {
  const gui=fixture.gui=await NativeGui.start(),browser=gui.browser!;
  fixture.captureSafe=true;
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  gui.stage='theme import Preferences';
  await workspaceAction(gui,'Preferences');
  const dialog=await browser.$('[role="dialog"][aria-label="Preferences"]');await dialog.waitForDisplayed();
  await (await dialog.$('button[data-settings-target="appearance"]')).click();
  const page=await dialog.$('[data-settings-page="appearance"]');await page.waitForDisplayed();
  await (await page.$('summary=Import and share theme')).click();
  return {gui,browser,page,appTheme:()=>browser.execute(()=>document.documentElement.dataset.appTheme)};
}

it('imports a theme from a QR image chosen in the Linux GUI, decoded natively, and applies it only on request',async()=>{
  const {gui,browser,page,appTheme}=await enterThemeImport();
  expect(await appTheme()).not.toBe('custom');
  const file=await page.$('.theme-qr-panel input[type="file"]');
  // The WebDriver sets the file the chooser would return; the app reads it and the native decoder scans it.
  const choose=async(name:string)=>{const copy=join(gui.directory,name);await copyFile(fixtures(name),copy);await file.setValue(copy);};
  gui.stage='QR image without a code';
  await choose('theme-qr-camera-cropped.png');
  await (await page.$('p=No decodable QR code was found in this image.')).waitForDisplayed({timeout:20_000});
  expect(await browser.$('h3=QR fixture').isExisting()).toBe(false);
  gui.stage='QR image with a theme';
  await choose('theme-qr.png');
  await (await browser.$('h3=QR fixture')).waitForDisplayed({timeout:20_000});
  expect(await appTheme()).not.toBe('custom');
  await (await page.$('button=Apply to app and terminal')).click();
  await browser.waitUntil(async()=>await appTheme()==='custom',{timeout:10_000,timeoutMsg:'The scanned theme was not applied on request'});
  expect(gui.connections).toBe(0);
});

it('reads a theme from the X clipboard in the Linux GUI, previews it and applies it only on request',async()=>{
  const {gui,browser,page,appTheme}=await enterThemeImport();
  const draft=await page.$('textarea[aria-label="Theme JSON or share code"]'),theme=JSON.stringify({v:1,name:'Clipboard fixture',mode:'light',colors:{background:'#f4f4ee',foreground:'#202020'}});
  gui.stage='theme on the X clipboard';
  // A separate X client owns CLIPBOARD, as when a user copied the theme elsewhere; WebKitGTK only reads a foreign owner that offers text/plain.
  await gui.seedClipboard(theme,'text/plain;charset=utf-8');
  expect(await appTheme()).not.toBe('custom');expect(await draft.getValue()).toBe('');
  await (await page.$('button=Read theme from clipboard')).click();
  await (await browser.$('h3=Clipboard fixture')).waitForDisplayed({timeout:20_000});
  expect(await draft.getValue()).toBe(theme);
  expect(await appTheme()).not.toBe('custom');
  await (await page.$('button=Apply to app and terminal')).click();
  await browser.waitUntil(async()=>await appTheme()==='custom',{timeout:10_000,timeoutMsg:'The clipboard theme was not applied on request'});
  expect(gui.connections).toBe(0);
});

it('imports a theme from an lazysh:// link opened by the real xdg-open and reviews it before applying',async()=>{
  const {gui,browser,appTheme}=await enterThemeImport();
  const owner=await gui.appOwner();
  expect(await browser.$('button=Review linked theme').isExisting()).toBe(false);
  gui.stage='OS URL dispatch';
  await gui.openUrl(`lazysh://theme?data=${Buffer.from(JSON.stringify(linked)).toString('base64url')}`);
  const review=await browser.$('button=Review linked theme');await review.waitForDisplayed({timeout:20_000});
  expect(await appTheme()).not.toBe('custom');
  await review.click();
  await (await browser.$('h2=Linked by the OS')).waitForDisplayed();
  expect(await appTheme()).not.toBe('custom');
  await (await browser.$('button=Apply linked theme')).click();
  await browser.waitUntil(async()=>await appTheme()==='custom',{timeout:10_000,timeoutMsg:'The linked theme was not applied on request'});
  expect(await gui.appOwner()).toEqual(owner);expect(gui.connections).toBe(0);
});

import {expect,it} from 'vitest';
import {copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {NativeGui} from './fixture';
import {ownedSshGui,typeText} from './sshUi';
import {controlContrast} from '../e2e/fixtures/controlContrast';

const fixture=ownedSshGui();
async function captureAppearance(gui:NativeGui,state:'brand'|'paper'|'midnight') {
  await gui.screenshot();
  const directory=new URL('../test-results/native-gui/',import.meta.url);
  await copyFile(fileURLToPath(new URL('owned-synthetic-window.png',directory)),fileURLToPath(new URL(`appearance-${state}.png`,directory)));
}

it('changes native appearance through public settings and restores keyboard context without replacing its terminal',async()=>{
  const gui=fixture.gui=await NativeGui.start(),browser=gui.browser!;
  fixture.captureSafe=true;
  await (await browser.$('button[aria-label="Connect to Primary GUI host"]')).waitForDisplayed({timeout:30_000});
  const owner=await gui.appOwner();
  gui.stage='appearance local session';
  await gui.secondary(['--dir',gui.directory]);
  const terminal=await browser.$('.terminal-canvas .xterm-screen');await terminal.waitForDisplayed({timeout:20_000});
  const terminalId=terminal.elementId;
  await terminal.click();
  // Split the literal so shell input echo cannot satisfy the output assertion.
  await typeText(browser,"printf '%s%s\\n' native-appearance- before\n");
  await browser.waitUntil(async()=>(await terminal.getText()).includes('native-appearance-before'),{timeout:20_000,timeoutMsg:'Original local PTY did not produce its first marker'});

  gui.stage='appearance keyboard entry';
  const opener=await browser.$('button[aria-label="Preferences"]');await opener.click();
  const dialog=await browser.$('[role="dialog"][aria-label="Preferences"]');await dialog.waitForDisplayed();
  const appearance=await dialog.$('button[data-settings-target="appearance"]');
  const categories=await dialog.$$('.settings-index button');
  // Traverse the actual tab order; do not focus the target with injected JavaScript.
  for(let step=0;step<=categories.length && !await appearance.isFocused();step++)await browser.keys('\uE004');
  expect(await appearance.isFocused()).toBe(true);
  const focus=await browser.execute(()=>{
    const node=document.activeElement as HTMLElement,style=getComputedStyle(node),rect=node.getBoundingClientRect();
    return {visible:node.matches(':focus-visible'),outline:style.outlineStyle,width:parseFloat(style.outlineWidth),inView:rect.top>=0&&rect.bottom<=innerHeight&&rect.left>=0&&rect.right<=innerWidth};
  });
  expect(focus).toMatchObject({visible:true,inView:true});
  expect(focus.outline).not.toBe('none');expect(focus.width).toBeGreaterThan(0);
  await browser.keys('\uE007');
  const page=await dialog.$('[data-settings-page="appearance"]'),heading=await page.$('h2');
  await page.waitForDisplayed();expect(await heading.isFocused()).toBe(true);
  const theme=await page.$('//label[normalize-space(text())="App theme"]/select');
  expect(await page.$('legend=App icon').isExisting()).toBe(false);
  expect(await page.$('button=Refresh app icon').isDisplayed()).toBe(true);
  await captureAppearance(gui,'brand');
  const samples:Record<string,{foreground:string;background:string;scheme:string;opaque:boolean}>={};
  for(const value of ['paper','midnight']) {
    gui.stage=`appearance ${value} rendered`;
    await theme.selectByAttribute('value',value);
    await browser.waitUntil(async()=>await browser.execute(()=>document.documentElement.dataset.appTheme)===value,{timeout:3000,timeoutMsg:'Public app theme selection did not reach the native renderer'});
    samples[value]=await browser.execute(()=>{
      const style=getComputedStyle(document.querySelector('[role="dialog"][aria-label="Preferences"]')!);
      const canvas=document.createElement('canvas').getContext('2d')!;
      canvas.fillStyle=style.backgroundColor;canvas.fillRect(0,0,1,1);
      return {foreground:style.color,background:style.backgroundColor,scheme:document.documentElement.style.colorScheme,opaque:canvas.getImageData(0,0,1,1).data[3]===255&&style.opacity==='1'};
    });
    expect(samples[value].scheme).toBe(value==='paper'?'light':'dark');
    expect(samples[value].opaque).toBe(true);
    await captureAppearance(gui,value as 'paper'|'midnight');
    const contrasts=await browser.execute(controlContrast,page);
    expect(contrasts.length).toBeGreaterThan(5);
    for(const sample of contrasts)expect(sample.ratio,`${value} ${sample.tag} ${sample.text}`).toBeGreaterThanOrEqual(4.5);
    // Record actual native media/support state; this does not emulate or qualify fallback modes.
    console.info('Native appearance observation',JSON.stringify(await browser.execute(()=>{
      const header=getComputedStyle(document.querySelector('.settings-detail-header')!);
      return {theme:document.documentElement.dataset.appTheme,blurSupported:CSS.supports('backdrop-filter','blur(16px)'),filter:header.backdropFilter,background:header.backgroundColor,reducedTransparency:matchMedia('(prefers-reduced-transparency: reduce)').matches,forcedColors:matchMedia('(forced-colors: active)').matches,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
    })));
  }
  expect(samples.paper.background).not.toBe(samples.midnight.background);
  expect(samples.paper.foreground).not.toBe(samples.midnight.foreground);

  gui.stage='appearance contextual keyboard return';
  await browser.keys('\uE00C');
  await page.waitForDisplayed({reverse:true});expect(await appearance.isFocused()).toBe(true);
  expect(await appearance.isDisplayed()).toBe(true);
  await browser.keys('\uE00C');await dialog.waitForDisplayed({reverse:true});
  expect(await opener.isFocused()).toBe(true);expect(await opener.isDisplayed()).toBe(true);
  expect((await browser.$('.terminal-canvas .xterm-screen')).elementId).toBe(terminalId);
  expect(await gui.appOwner()).toEqual(owner);
  await terminal.click();await typeText(browser,"printf '%s%s\\n' native-appearance- after\n");
  await browser.waitUntil(async()=>{const text=await terminal.getText();return text.includes('native-appearance-before')&&text.includes('native-appearance-after');},{timeout:20_000,timeoutMsg:'Original local PTY and scrollback did not survive appearance navigation'});
  expect(await gui.appOwner()).toEqual(owner);expect(await browser.getWindowHandles()).toHaveLength(1);
  expect(gui.connections).toBe(0);
});

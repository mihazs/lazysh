import {expect,it} from 'vitest';
import {copyFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {NativeGui} from './fixture';
import {ownedSshGui,typeText,workspaceAction} from './sshUi';
import {controlContrast} from '../e2e/fixtures/controlContrast';

const fixture=ownedSshGui();
async function captureAppearance(gui:NativeGui,state:'brand'|'paper'|'midnight') {
  await gui.screenshot();
  const directory=new URL('../test-results/native-gui/',import.meta.url);
  await copyFile(fileURLToPath(new URL('owned-synthetic-window.png',directory)),fileURLToPath(new URL(`appearance-${state}.png`,directory)));
}

async function enterAppearance(gui:NativeGui) {
  const browser=gui.browser!;
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
  const opener=await workspaceAction(gui,'Preferences');
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
  return {gui,browser,owner,terminal,terminalId,opener,dialog,appearance,page};
}

async function returnToOriginalTerminal(state:Awaited<ReturnType<typeof enterAppearance>>) {
  const {gui,browser,owner,terminal,terminalId,opener,dialog,appearance,page}=state;
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
}

it('changes native appearance through public settings and restores keyboard context without replacing its terminal',async()=>{
  const gui=fixture.gui=await NativeGui.start();
  const state=await enterAppearance(gui),{browser,dialog,page}=state;
  const theme=await page.$('//label[normalize-space(text())="App theme"]/select');
  expect(await page.$('legend=App icon').isExisting()).toBe(false);
  expect(await page.$('button=Refresh app icon').isDisplayed()).toBe(true);
  await captureAppearance(gui,'brand');
  const samples:Record<string,{foreground:string;background:string;scheme:string;glass:boolean;alpha:number;opacity:string;blurred:boolean}>={};
  for(const value of ['paper','midnight']) {
    gui.stage=`appearance ${value} rendered`;
    await theme.selectByAttribute('value',value);
    await browser.waitUntil(async()=>await browser.execute(()=>document.documentElement.dataset.appTheme)===value,{timeout:3000,timeoutMsg:'Public app theme selection did not reach the native renderer'});
    samples[value]=await browser.execute(()=>{
      const style=getComputedStyle(document.querySelector('[role="dialog"][aria-label="Preferences"]')!);
      const canvas=document.createElement('canvas').getContext('2d')!;
      canvas.fillStyle=style.backgroundColor;canvas.fillRect(0,0,1,1);
      // Desktop dialogs are glass only where the renderer can blur and mix colours and the user has not opted out.
      const glass=(CSS.supports('backdrop-filter','blur(1px)')||CSS.supports('-webkit-backdrop-filter','blur(1px)'))
        &&CSS.supports('background','color-mix(in srgb, black 90%, transparent)')&&matchMedia('(min-width: 601px)').matches
        &&!matchMedia('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)').matches;
      const filter=style.backdropFilter||style.getPropertyValue('-webkit-backdrop-filter');
      return {foreground:style.color,background:style.backgroundColor,scheme:document.documentElement.style.colorScheme,glass,alpha:canvas.getImageData(0,0,1,1).data[3],opacity:style.opacity,blurred:filter.includes('blur(')};
    });
    const material=samples[value];
    expect(material.scheme).toBe(value==='paper'?'light':'dark');
    expect(material.opacity).toBe('1');
    // Glass is translucent and blurred; every fallback mode paints the dialog opaque without blur.
    expect({alpha:material.glass?material.alpha<255&&material.alpha>0:material.alpha===255,blurred:material.blurred},`${value} dialog material`).toEqual({alpha:true,blurred:material.glass});
    await captureAppearance(gui,value as 'paper'|'midnight');
    // Isolated at the dialog, so text must hold over the worst underlay, black or white, that the glass can float above.
    const contrasts=await browser.execute(controlContrast,dialog,{isolate:true});
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

  await returnToOriginalTerminal(state);
});

it('honors the private GTK reduced-motion setting while preserving native keyboard focus and its original terminal',async()=>{
  const gui=fixture.gui=await NativeGui.startWithReducedMotion();
  const state=await enterAppearance(gui),{browser,page}=state;
  gui.stage='native OS reduced-motion appearance';
  const media=await browser.execute(()=>({reduce:matchMedia('(prefers-reduced-motion: reduce)').matches,normal:matchMedia('(prefers-reduced-motion: no-preference)').matches}));
  expect(media).toEqual({reduce:true,normal:false});
  const chrome=await browser.execute(()=>Array.from(document.querySelectorAll('.sidebar, .sidebar button, .workspace-navigation-modes button, .settings-index button')).filter(node=>(node as HTMLElement).getClientRects().length>0).map(node=>{
    const style=getComputedStyle(node);return {property:style.transitionProperty,durations:style.transitionDuration.split(',').map(value=>parseFloat(value)),active:node.getAnimations().filter(animation=>animation.playState==='running'||animation.pending).length};
  }));
  expect(chrome.length).toBeGreaterThan(0);
  for(const control of chrome) {expect(control.durations.every(value=>value===0)).toBe(true);expect(control.active).toBe(0);}
  const pageMotion=await browser.execute((node)=>({name:getComputedStyle(node as HTMLElement).animationName,active:(node as HTMLElement).getAnimations().filter(animation=>animation.playState==='running'||animation.pending).length}),page);
  expect(pageMotion).toEqual({name:'none',active:0});
  console.info('Native reduced-motion observation',JSON.stringify({media,chromeCount:chrome.length,pageAnimation:pageMotion.name,activePageAnimations:pageMotion.active}));
  await returnToOriginalTerminal(state);
});

import {expect,it} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {NativeGui} from './fixture';
import {SshFixture} from '../../../tests/support/sshFixture';
import {challengeOwnedSsh,openOwnedSsh,ownedSshGui,typeText} from './sshUi';

const fixture=ownedSshGui();
const CONTROL='',SHIFT='',ENTER='',ESCAPE='';
// A 3x2 PNG whose pixels are red, green, blue / yellow, cyan, magenta.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAGElEQVR4nGP4z8DAAMH//zMw/P//n+E/AErJCPgO3Eq0AAAAAElFTkSuQmCC','base64');
const MARKDOWN='# Release notes\n\nPlain **bold** text.\n\n<img src="x" onerror="window.markdownRan=1"><script>window.markdownRan=1</script>\n\n[active link](javascript:window.markdownRan=1)\n';
const SVG='<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" onload="window.svgRan=1"><script>window.svgRan=1</script><rect width="24" height="24" fill="#3a7"/></svg>';

async function ownedSession() {
  fixture.captureSafe=false;
  // The companion fixture also serves SFTP, which the Files tool reads.
  const ssh=fixture.ssh=await SshFixture.start(undefined,{companion:true,privateTtyGroup:true});
  const gui=fixture.gui=await NativeGui.start();
  const session=await openOwnedSsh(gui,ssh);
  await challengeOwnedSsh(gui,ssh,session.terminal,session.owner);
  fixture.captureSafe=true;
  return {ssh,gui,...session};
}

/** Ctrl+K needs focus outside editable controls; Ctrl+Shift+P also works from the focused terminal. */
async function openPalette(gui:NativeGui,chord:'k'|'shift+p') {
  const browser=gui.browser!,action=browser.action('key').down(CONTROL);
  if(chord==='shift+p')action.down(SHIFT);
  action.down(chord==='k'?'k':'p').up(chord==='k'?'k':'p');
  if(chord==='shift+p')action.up(SHIFT);
  await action.up(CONTROL).perform();
  const palette=await browser.$('[role="dialog"][aria-label="Command palette"]');await palette.waitForDisplayed();
  const search=await palette.$('input[role="combobox"]');
  await browser.waitUntil(()=>search.isFocused(),{timeout:5000,timeoutMsg:'Command palette search was not focused'});
  return {palette,search};
}
// File names end in .png and .svg, which WebdriverIO would read as image selectors, so match by XPath.
const entry=(files:Awaited<ReturnType<NonNullable<NativeGui['browser']>['$']>>,name:string)=>files.$(`.//button[contains(concat(" ",@class," ")," file-entry ")][./span[normalize-space(.)="${name}"]]`);
const options=(gui:NativeGui)=>gui.browser!.execute(()=>Array.from(document.querySelectorAll('[role="dialog"][aria-label="Command palette"] [role="option"]'),
  option=>({label:option.querySelector('strong')?.textContent,selected:option.getAttribute('aria-selected')==='true'})));

/** Filters the palette by `query`, expects `label` first and selected, and runs it with Enter. */
async function runPalette(gui:NativeGui,chord:'k'|'shift+p',query:string,label:string) {
  const browser=gui.browser!,{palette}=await openPalette(gui,chord);
  await typeText(browser,query);
  await browser.waitUntil(async()=>(await options(gui))[0]?.label===label,{timeout:5000,timeoutMsg:`Command palette did not rank ${label} first for ${query}`});
  expect((await options(gui))[0]).toEqual({label,selected:true});
  await browser.keys(ENTER);await palette.waitForDisplayed({reverse:true});
}

it('runs workspace tools and application actions from the command palette against a real SSH session',async()=>{
  const {ssh,gui,browser,terminal,owner}=await ownedSession(),terminalId=terminal.elementId;
  gui.stage='owned palette from the focused terminal';
  await terminal.click();
  const {palette}=await openPalette(gui,'shift+p');
  expect((await options(gui)).some(option=>option.label==='Owned SSH GUI host')).toBe(true);
  await typeText(browser,'zzzqq');
  await browser.waitUntil(async()=>(await options(gui)).length===0,{timeout:5000,timeoutMsg:'Command palette kept results for a query without a match'});
  // Escape runs nothing: the original terminal stays in front.
  await browser.keys(ESCAPE);await palette.waitForDisplayed({reverse:true});
  expect(await terminal.isDisplayed()).toBe(true);

  gui.stage='owned palette Files tool';
  await terminal.click();
  await runPalette(gui,'shift+p','files','Files');
  const files=await browser.$('section[aria-label="Remote files"]');await files.waitForDisplayed({timeout:20_000});
  await terminal.waitForDisplayed({reverse:true});

  gui.stage='owned palette Ctrl+K back to the Terminal tool';
  await (await files.$('.panel-empty h3')).click();
  await runPalette(gui,'k','terminal','Terminal');
  await terminal.waitForDisplayed();
  expect((await browser.$('.terminal-canvas .xterm-screen')).elementId).toBe(terminalId);
  await challengeOwnedSsh(gui,ssh,terminal,owner,'AFTER_PALETTE');

  gui.stage='owned palette ends the session';
  await runPalette(gui,'shift+p','end owned','End Owned SSH GUI host connection');
  await terminal.waitForDisplayed({reverse:true});
  expect(gui.connections).toBe(0);
  expect(await gui.appOwner()).toEqual(owner);
});

it('views Markdown, a PNG and an SVG from a real SSH host in Files without running their content',async()=>{
  const {ssh,gui,browser,terminal,owner}=await ownedSession();
  const media=join(ssh.directory,'media');
  await mkdir(media);
  await Promise.all([writeFile(join(media,'README.md'),MARKDOWN),writeFile(join(media,'pixel.png'),PNG),writeFile(join(media,'icon.svg'),SVG)]);
  gui.stage='owned Files over SFTP';
  await terminal.click();
  await runPalette(gui,'shift+p','files','Files');
  const files=await browser.$('section[aria-label="Remote files"]');await files.waitForDisplayed({timeout:20_000});
  await entry(files,'media').click();
  for(const name of ['README.md','pixel.png','icon.svg'])await entry(files,name).waitForDisplayed({timeout:20_000});

  gui.stage='owned Files Markdown';
  await entry(files,'README.md').click();
  await browser.waitUntil(()=>browser.execute(()=>document.querySelector('.file-preview h1')?.textContent==='Release notes'),{timeout:20_000,timeoutMsg:'Markdown heading was not rendered'});
  expect(await browser.execute(()=>{
    const preview=document.querySelector('.file-preview')!;
    return {bold:preview.querySelector('strong')?.textContent,active:preview.querySelectorAll('a,img,script,iframe,object,embed').length,
      link:preview.textContent?.includes('active link'),ran:typeof (window as unknown as {markdownRan?:number}).markdownRan};
  })).toEqual({bold:'bold',active:0,link:true,ran:'undefined'});

  gui.stage='owned Files PNG';
  await entry(files,'pixel.png').click();
  const image='.file-preview img.file-media[alt="Preview of ./media/pixel.png"]';
  await browser.waitUntil(()=>browser.execute(selector=>{const node=document.querySelector<HTMLImageElement>(selector);return !!node&&node.complete&&node.naturalWidth>0;},image),{timeout:20_000,timeoutMsg:'PNG was not decoded'});
  // The bytes SFTP read are the file's own bytes, and the real renderer decodes them to the expected pixels.
  expect(await browser.execute(selector=>{
    const node=document.querySelector<HTMLImageElement>(selector)!,canvas=document.createElement('canvas');
    canvas.width=node.naturalWidth;canvas.height=node.naturalHeight;
    const context=canvas.getContext('2d')!;context.drawImage(node,0,0);
    const pixel=(x:number,y:number)=>Array.from(context.getImageData(x,y,1,1).data);
    return {payload:node.src.split(',')[1],size:[node.naturalWidth,node.naturalHeight],first:pixel(0,0),last:pixel(2,1),prefix:node.src.slice(0,22)};
  },image)).toEqual({payload:PNG.toString('base64'),size:[3,2],first:[255,0,0,255],last:[255,0,255,255],prefix:'data:image/png;base64,'});

  gui.stage='owned Files SVG';
  await entry(files,'icon.svg').click();
  const vector='.file-preview img.file-media[alt="Preview of ./media/icon.svg"]';
  await browser.waitUntil(()=>browser.execute(selector=>{const node=document.querySelector<HTMLImageElement>(selector);return !!node&&node.complete&&node.naturalWidth>0;},vector),{timeout:20_000,timeoutMsg:'SVG was not decoded'});
  expect(await browser.execute(selector=>({
    source:document.querySelector<HTMLImageElement>(selector)!.src.slice(0,5),width:document.querySelector<HTMLImageElement>(selector)!.naturalWidth,
    inline:document.querySelectorAll('.file-preview svg,.file-preview script,.file-preview iframe,.file-preview object').length,
    ran:typeof (window as unknown as {svgRan?:number}).svgRan,
  }),vector)).toEqual({source:'blob:',width:24,inline:0,ran:'undefined'});
  expect(gui.connections).toBe(0);
  expect(await gui.appOwner()).toEqual(owner);
});

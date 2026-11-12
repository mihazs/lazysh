import {expect,test,type Page} from '@playwright/test';
import {openHistoryWorkspace} from './fixtures/terminalHistory';
import {forgetKeyboardRequests,keyboardRequests,trackKeyboardRequests} from './fixtures/keyboardRequests';
import type {mountGestureHarness} from './fixtures/GestureHarness';
declare global {interface Window {gestures:ReturnType<typeof mountGestureHarness>}}

test.skip(({isMobile})=>!isMobile,'Touch screens raise a soft keyboard.');
test.afterEach(async({page})=>{await page.evaluate(()=>window.gestures?.dispose());});

/** Draws what Herdr's phone layout draws: a header whose last ten columns are the switch button, or the switcher with its close button. */
const frame=(page:Page,screen:'terminal'|'switcher'|'plain')=>page.evaluate(async screen=>{
  const terminal=window.gestures.terminal,{cols,rows}=terminal,at=(row:number,text:string,column=0)=>`\x1b[${row+1};${column+1}H${text}`;
  const text=screen==='switcher'
    ?at(0,' switch')+at(0,'│  close  ',cols-10)+at(1,' ',0)+at(3,'● Development')+at(5,'● codex-builder')
    :screen==='terminal'
      ?at(0,'● Development  tab 1')+at(1,'1 blocked',1)+at(1,'│ switch  ',cols-10)+at(5,'agent output')
      :at(0,'● Development  tab 1')+at(5,'agent output');
  await new Promise<void>(done=>terminal.write(`\x1b[?1000h\x1b[?1006h\x1b[2J${text}\x1b[${rows};1H`,done));
},screen);
/** The page position of a screen cell. */
const cellCenter=(page:Page,column:number,row:number)=>page.evaluate(({column,row})=>{
  const terminal=window.gestures.terminal,box=terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
  return {x:box.left+(column+.5)*box.width/terminal.cols,y:box.top+(row+.5)*box.height/terminal.rows};
},{column,row});
const focused=(page:Page)=>page.evaluate(()=>document.activeElement?.matches('.xterm-helper-textarea')===true);
const columns=(page:Page)=>page.evaluate(()=>window.gestures.terminal.cols);
const writes=(page:Page)=>page.evaluate(()=>window.gestures.steps.flat().join(''));

async function mount(page:Page) {
  await page.setViewportSize({width:415,height:900});
  await trackKeyboardRequests(page);
  await openHistoryWorkspace(page);
  await page.evaluate(async()=>{
    const fixture=await import('/e2e/fixtures/GestureHarness.tsx');
    window.gestures=fixture.mountGestureHarness('herdr');
  });
  await expect(page.locator('.terminal-canvas .xterm-screen')).toBeVisible();
}
async function tap(page:Page,column:number,row:number) {
  const {x,y}=await cellCenter(page,column,row);
  await forgetKeyboardRequests(page);
  await page.touchscreen.tap(x,y);
  await page.waitForTimeout(400);
}

test("a tap on Herdr's switch button reaches Herdr without raising the soft keyboard",async({page},testInfo)=>{
  await mount(page);
  await frame(page,'terminal');
  const cols=await columns(page);
  expect(cols).toBeLessThanOrEqual(64);
  await tap(page,cols-4,1);
  expect(await keyboardRequests(page)).toEqual([]);
  expect(await focused(page)).toBe(false);
  // Herdr still got the click: an SGR press and release over the button.
  expect(await writes(page)).toMatch(new RegExp(`\\x1b\\[<0;${cols-3};2M\\x1b\\[<0;${cols-3};2m`));
  await page.screenshot({path:testInfo.outputPath('switch-button.png')});
});

test("a tap in Herdr's switcher reaches Herdr without raising the soft keyboard",async({page},testInfo)=>{
  await mount(page);
  await frame(page,'switcher');
  await tap(page,6,5);
  expect(await keyboardRequests(page)).toEqual([]);
  expect(await writes(page)).toMatch(/\x1b\[<0;7;6M\x1b\[<0;7;6m/);
  await page.screenshot({path:testInfo.outputPath('switcher.png')});
});

test('a tap anywhere else in the terminal is a request to type and raises the keyboard',async({page})=>{
  await mount(page);
  await frame(page,'terminal');
  const cols=await columns(page);
  await tap(page,3,5);
  expect(await keyboardRequests(page)).toEqual(['Terminal input']);
  await page.evaluate(()=>window.gestures.terminal.blur());
  // The same cells without Herdr's switch button are only text.
  await frame(page,'plain');
  await tap(page,cols-4,1);
  expect(await keyboardRequests(page)).toEqual(['Terminal input']);
});

test('the switch button leaves a keyboard that is already open as it is',async({page})=>{
  await mount(page);
  await frame(page,'terminal');
  await tap(page,3,5);
  expect(await focused(page)).toBe(true);
  await tap(page,(await columns(page))-4,1);
  expect(await focused(page)).toBe(true);
});

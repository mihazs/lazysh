import {expect,type Page} from '@playwright/test';
import {test} from './fixtures/terminalBackend';
import {requestedBackend} from '../src/e2eTerminalBackend';
import {openHistoryWorkspace} from './fixtures/terminalHistory';
import {onAdapter,terminalCell,terminalDrawn,terminalSize} from './fixtures/terminalState';
import {forgetKeyboardRequests,keyboardRequests,trackKeyboardRequests} from './fixtures/keyboardRequests';
import type {mountGestureHarness} from './fixtures/GestureHarness';
declare global {interface Window {gestures:Awaited<ReturnType<typeof mountGestureHarness>>}}

test.use({syntheticBackend:true});
test.skip(({isMobile})=>!isMobile,'Touch screens raise a soft keyboard.');
test.afterEach(async({page})=>{await page.evaluate(()=>window.gestures?.dispose());});

/** Draws what Herdr's phone layout draws: a header whose last ten columns are the switch button, or the switcher with its close button. */
const frame=(page:Page,screen:'terminal'|'switcher'|'plain')=>onAdapter(page,async(adapter,screen)=>{
  const {columns:cols,rows}=adapter.size(),at=(row:number,text:string,column=0)=>`\x1b[${row+1};${column+1}H${text}`;
  const text=screen==='switcher'
    ?at(0,' switch')+at(0,'│  close  ',cols-10)+at(1,' ',0)+at(3,'● Development')+at(5,'● codex-builder')
    :screen==='terminal'
      ?at(0,'● Development  tab 1')+at(1,'1 blocked',1)+at(1,'│ switch  ',cols-10)+at(5,'agent output')
      :at(0,'● Development  tab 1')+at(5,'agent output');
  await adapter.write!(new TextEncoder().encode(`\x1b[?1000h\x1b[?1006h\x1b[2J${text}\x1b[${rows};1H`));
},screen);
const focused=(page:Page)=>onAdapter(page,adapter=>document.activeElement===adapter.inputElement());
const columns=async(page:Page)=>(await terminalSize(page)).columns;
async function mouseReport(page:Page,column:number,row:number) {
  if (requestedBackend()==='native') {
    expect(await page.evaluate(()=>window.gestures.core!.mice)).toEqual(
      ['press','release'].map(action=>({type:'mouse',action,button:'left',x:column,y:row,mods:{shift:false,ctrl:false,alt:false,meta:false}})),
    );
  } else {
    const bytes=await page.evaluate(()=>window.gestures.steps.flat().join(''));
    expect(bytes).toContain(`\x1b[<0;${column+1};${row+1}M\x1b[<0;${column+1};${row+1}m`);
  }
}

async function mount(page:Page) {
  await page.setViewportSize({width:415,height:900});
  await trackKeyboardRequests(page);
  await openHistoryWorkspace(page);
  await page.evaluate(async engine=>{
    const fixture=await import('/e2e/fixtures/GestureHarness.tsx');
    window.gestures=await fixture.mountGestureHarness('herdr',engine);
  },requestedBackend()??'xterm');
  await terminalDrawn(page);
}
async function tap(page:Page,column:number,row:number) {
  const {x,y}=await terminalCell(page,row,column);
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
  await mouseReport(page,cols-4,1);
  await page.screenshot({path:testInfo.outputPath('switch-button.png')});
});

test("a tap in Herdr's switcher reaches Herdr without raising the soft keyboard",async({page},testInfo)=>{
  await mount(page);
  await frame(page,'switcher');
  await tap(page,6,5);
  expect(await keyboardRequests(page)).toEqual([]);
  await mouseReport(page,6,5);
  await page.screenshot({path:testInfo.outputPath('switcher.png')});
});

test('a tap anywhere else in the terminal is a request to type and raises the keyboard',async({page})=>{
  await mount(page);
  await frame(page,'terminal');
  const cols=await columns(page);
  await tap(page,3,5);
  expect(await keyboardRequests(page)).toEqual(['Terminal input']);
  await onAdapter(page,adapter=>adapter.blur());
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

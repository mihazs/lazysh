import {expect,test,type Page} from '@playwright/test';
import {connectLocalTerminal,installLocalTerminal} from './fixtures/localTerminal';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';

type Style='bar'|'block'|'underline';
const cursor='.terminal-canvas .xterm-rows .xterm-cursor';

async function focusTerminal(page:Page) {
  await page.locator('.terminal-canvas:visible .xterm-screen').click();
  await expect(page.locator('.terminal-canvas:visible .xterm.focus')).toBeVisible();
  await expect(page.locator(cursor)).toBeVisible();
}
/** A focused local terminal with `ab` printed, so the cursor rests on an empty cell. */
async function openTerminal(page:Page,preferences:Record<string,unknown>={}) {
  await installLocalTerminal(page);
  await page.addInitScript(stored=>localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,...stored})),preferences);
  await page.goto('/');
  await connectLocalTerminal(page);
  await page.evaluate(()=>window.simpleShortcutOutput('ab'));
  await focusTerminal(page);
}
// xterm redraws its rows after focus and output, so each read finds the live cursor node itself instead of holding one.
const blinks=(page:Page)=>page.evaluate(selector=>document.querySelector(selector)!.getAnimations().map(animation=>{const {duration,iterations}=animation.effect!.getComputedTiming();return {duration,iterations};}),cursor);
/** The colour the cursor is drawn in (a block fills with it, a bar and an underline are lines of it), read from the first half of a blink. */
const colour=(page:Page)=>page.evaluate(selector=>{
  const node=document.querySelector(selector)!;
  for(const animation of node.getAnimations()){animation.pause();animation.currentTime=0;}
  const style=getComputedStyle(node);
  const value=style.backgroundColor!=='rgba(0, 0, 0, 0)'?style.backgroundColor:style.boxShadow!=='none'?style.boxShadow:style.borderBottomColor;
  return value.match(/\d+/g)!.slice(0,3).map(Number);
},cursor);

/** Screenshots the cursor cell and reports, per pixel column and row, the share drawn in `rgb`. */
async function coverage(page:Page,rgb:number[]) {
  const box=await page.evaluate(selector=>{const {x,y,width,height}=document.querySelector(selector)!.getBoundingClientRect();return {x,y,width,height};},cursor);
  const x=Math.ceil(box.x),y=Math.ceil(box.y);
  const clip={x,y,width:Math.floor(box.x+box.width)-x,height:Math.floor(box.y+box.height)-y};
  const image=(await page.screenshot({clip})).toString('base64');
  return page.evaluate(async([image,rgb])=>{
    const bitmap=await createImageBitmap(await (await fetch(`data:image/png;base64,${image}`)).blob());
    const context=new OffscreenCanvas(bitmap.width,bitmap.height).getContext('2d')!;
    context.drawImage(bitmap,0,0);
    const {data,width,height}=context.getImageData(0,0,bitmap.width,bitmap.height);
    const on=(column:number,row:number)=>[0,1,2].every(channel=>Math.abs(data[(row*width+column)*4+channel]-rgb[channel])<24);
    const share=(count:number,cell:(index:number,other:number)=>boolean,others:number)=>Array.from({length:count},(_,index)=>Array.from({length:others},(_,other)=>cell(index,other)).filter(Boolean).length/others);
    return {columns:share(width,(column,row)=>on(column,row),height),rows:share(height,(row,column)=>on(column,row),width)};
  },[image,rgb] as const);
}
/** The three shapes differ in which pixels they paint: the whole cell, its first column or its last row. */
async function expectShape(page:Page,style:Style,rgb:number[]) {
  const {columns,rows}=await coverage(page,rgb);
  if(style==='block'){expect(Math.min(...columns)).toBeGreaterThan(.9);expect(Math.min(...rows)).toBeGreaterThan(.9);}
  if(style==='bar'){expect(Math.max(columns[0],columns[1])).toBeGreaterThan(.9);expect(Math.max(...columns.slice(2))).toBeLessThan(.1);}
  if(style==='underline'){expect(Math.max(...rows.slice(-2))).toBeGreaterThan(.9);expect(Math.max(...rows.slice(0,-2))).toBeLessThan(.1);}
}
async function expectHidden(page:Page,rgb:number[]) {
  const {columns,rows}=await coverage(page,rgb);
  expect(Math.max(...columns,...rows)).toBeLessThan(.1);
}

for(const style of ['bar','block','underline'] as const)for(const blink of [false,true])test(`the ${style} cursor is drawn${blink?' and blinks':' without blinking'} as saved in the preferences`,async({page})=>{
  await openTerminal(page,{cursorStyle:style,cursorBlink:blink});
  const rgb=await colour(page);
  await expectShape(page,style,rgb);
  expect(await blinks(page)).toEqual(blink?[{duration:1000,iterations:Infinity}]:[]);
  if(!blink)return;
  // Seek the real animation: its first half draws the cursor, its second half does not.
  const seek=(time:number)=>page.evaluate(([selector,time])=>{const animation=document.querySelector(selector as string)!.getAnimations()[0];animation.pause();animation.currentTime=time;},[cursor,time] as const);
  await seek(600);await expectHidden(page,rgb);
  await seek(100);await expectShape(page,style,rgb);
});

test('choosing a cursor shape and turning blinking off in Preferences redraws the open terminal',async({page})=>{
  await openTerminal(page);
  await expectShape(page,'bar',await colour(page));
  expect(await blinks(page)).toHaveLength(1);
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Terminal');
  await page.getByRole('group',{name:'Cursor',exact:true}).getByText('underline',{exact:true}).click();
  await page.getByRole('checkbox',{name:'Blink cursor',exact:true}).uncheck();
  await closePreferences(page);
  await focusTerminal(page);
  await expectShape(page,'underline',await colour(page));
  expect(await blinks(page)).toEqual([]);
});

import {expect,type Page} from '@playwright/test';
import {installNativeBridge} from './nativeBridge';
import type {mountTerminalHistoryHarness} from './TerminalHistoryHarness';
declare global {interface Window {ownedHistory:ReturnType<typeof mountTerminalHistoryHarness>;ownedHistoryInput?:(data:string)=>void;edgeLog:string[]}}

/** Loads the workspace with synthetic commands; the terminal harness mounts separately. */
export async function openHistoryWorkspace(page:Page) {
  await installNativeBridge(page,{reason:'Synthetic history fixture.',generation:'1'});
  await page.addInitScript(()=>{window.nativeFixtureInvoke=async command=>{
    if(command==='list_hosts')return [];
    if(command==='app_icon_status')return {available:false,current:'unknown',reason:'Synthetic history fixture.'};
    if(command==='local_capability')return {available:false,reason:'Synthetic history fixture; no shell starts.'};
    if(command.startsWith('plugin:event|'))return 1;
    return undefined;
  };});
  await page.goto('/');
}

export async function mountHistory(page:Page,mosh:boolean,load=true,topAnchored=false,edge?:{close?:boolean}) {
  if(load)await openHistoryWorkspace(page);
  await page.evaluate(async({mosh,topAnchored,edge})=>{
    const fixture=await import('/e2e/fixtures/TerminalHistoryHarness.tsx');
    window.edgeLog=[];
    window.ownedHistory=fixture.mountTerminalHistoryHarness({mosh,topAnchored,edgeLog:edge?window.edgeLog:undefined,edgeClose:edge?.close,input:data=>window.ownedHistoryInput?.(data)});
  },{mosh,topAnchored,edge});
  await expect(page.locator('.terminal-canvas .xterm-screen')).toBeVisible();
  // A Mosh terminal adopts its geometry only from the first authoritative frame.
  if(mosh)await expect.poll(()=>page.evaluate(()=>window.ownedHistory.resizes.length)).toBeGreaterThan(0);
  await settle(page);
}

/** Waits until the xterm write queue and any pending Mosh frame are applied. */
export async function settle(page:Page) {
  await page.evaluate(()=>new Promise<void>(resolve=>setTimeout(()=>window.ownedHistory.terminal.write('',()=>requestAnimationFrame(()=>resolve())),60)));
}

export const historyLines=(count:number,from=0,wrap=false)=>Array.from({length:count},(_,i)=>{
  const id=`HISTORY_${String(from+i).padStart(4,'0')}`;
  return wrap&&i%3===0?`${id}_${'w'.repeat(90)}_end`:id;
});

/** The top visible row, its logical line and the rendered row the reader sees. */
export function historyView(page:Page) {
  return page.evaluate(()=>{
    const t=window.ownedHistory.terminal,b=t.buffer.active;
    let start=b.viewportY;while(start>0&&b.getLine(start)?.isWrapped)start--;
    return {viewportY:b.viewportY,baseY:b.baseY,length:b.length,rows:t.rows,cols:t.cols,
      top:b.getLine(b.viewportY)!.translateToString(true),wrapped:!!b.getLine(b.viewportY)?.isWrapped,
      logical:b.getLine(start)!.translateToString(true).slice(0,12),
      rendered:document.querySelector('.terminal-canvas .xterm-rows > div')?.textContent?.trimEnd()??''};
  });
}

export async function rowHeight(page:Page) {
  return page.locator('.terminal-canvas .xterm-screen').evaluate(node=>node.getBoundingClientRect().height/window.ownedHistory.terminal.rows);
}

/** Moves the reader up by `rows` with the project's own input: wheel notches or finger moves of `step` rows. */
export async function scrollHistory(page:Page,phone:boolean,rows:number,between:()=>Promise<unknown>=async()=>{},step=1) {
  const box=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!,height=await rowHeight(page);
  // A soft keyboard can leave part of a panned Mosh screen outside the pane.
  const pane=(await page.locator('.terminal-canvas').boundingBox())!,top=Math.max(box.y,pane.y),bottom=Math.min(box.y+box.height,pane.y+pane.height);
  const x=box.x+box.width/2,y=top+(bottom-top)/4;
  if(!phone) {
    await page.mouse.move(x,y);
    for(let row=0;row<rows;row++){await page.mouse.wheel(0,-height);await between();}
    await settle(page);return;
  }
  await fingerDrag(page,{x,y},height,rows,{between,step});
}

/** One finger from `start` down by `rows` rows in moves of `step` rows. A
 * `slant` first sample goes only sideways, as a thumb often starts. */
export async function fingerDrag(page:Page,start:{x:number;y:number},height:number,rows:number,{between=async()=>{},step=1,slant=0}:{between?:()=>Promise<unknown>;step?:number;slant?:number}={}) {
  const {x,y}=start,input=await page.context().newCDPSession(page);
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  if(slant)await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+slant,y}]});
  for(let move=1;move*step<=rows;move++){await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+slant,y:y+move*step*height}]});await between();}
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await input.detach();await settle(page);
}

/** Centre of a visible terminal cell in viewport coordinates. */
export function cell(page:Page,row:number,column:number) {
  return page.evaluate(([row,column])=>{
    const t=window.ownedHistory.terminal,r=t.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
    return {x:r.left+(column+.5)*r.width/t.cols,y:r.top+(row+.5)*r.height/t.rows};
  },[row,column] as const);
}
/** A still finger held past the selection delay, then lifted. */
export async function longPress(page:Page,point:{x:number;y:number}) {
  const input=await page.context().newCDPSession(page);
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  await page.waitForTimeout(650);
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await input.detach();
}
/** The on-screen keyboard holds a word in composition, as SwiftKey and Gboard do after typing. */
export async function compose(page:Page,text:string) {
  await page.evaluate(()=>window.ownedHistory.terminal.focus());
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});
  await cdp.detach();
}

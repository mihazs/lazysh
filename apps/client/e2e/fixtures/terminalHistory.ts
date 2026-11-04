import {expect,type Page} from '@playwright/test';
import {installNativeBridge} from './nativeBridge';
import type {mountTerminalHistoryHarness} from './TerminalHistoryHarness';
declare global {interface Window {ownedHistory:ReturnType<typeof mountTerminalHistoryHarness>;ownedHistoryInput?:(data:string)=>void}}

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

export async function mountHistory(page:Page,mosh:boolean,load=true) {
  if(load)await openHistoryWorkspace(page);
  await page.evaluate(async mosh=>{
    const fixture=await import('/e2e/fixtures/TerminalHistoryHarness.tsx');
    window.ownedHistory=fixture.mountTerminalHistoryHarness({mosh,input:data=>window.ownedHistoryInput?.(data)});
  },mosh);
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
  const x=box.x+box.width/2,y=box.y+box.height/4;
  if(!phone) {
    await page.mouse.move(x,y);
    for(let row=0;row<rows;row++){await page.mouse.wheel(0,-height);await between();}
    await settle(page);return;
  }
  const input=await page.context().newCDPSession(page);
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
  for(let move=1;move*step<=rows;move++){await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+move*step*height}]});await between();}
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await input.detach();await settle(page);
}

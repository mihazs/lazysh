import {expect,test,type CDPSession,type Page} from '@playwright/test';
import {historyLines,historyView,mountHistory,scrollHistory,settle} from './fixtures/terminalHistory';

const output=(page:Page,lines:string[])=>page.evaluate(lines=>window.ownedHistory.output(lines),lines);
const readClipboard=(page:Page)=>page.evaluate(()=>navigator.clipboard.readText());
const actions=(page:Page)=>page.getByRole('toolbar',{name:'Selection actions',exact:true});
const handle=(page:Page,which:'start'|'end')=>page.locator(`[data-selection-handle="${which}"]`);
test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedHistory?.dispose());});

async function open(page:Page,mosh:boolean) {
  await mountHistory(page,mosh);
  await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(page.url()).origin});
  await page.evaluate(()=>navigator.clipboard.writeText('BEFORE'));
  await output(page,historyLines(300));await settle(page);
}
/** Centre of a visible cell in viewport coordinates. */
function cell(page:Page,row:number,column:number) {
  return page.evaluate(([row,column])=>{
    const t=window.ownedHistory.terminal,r=t.element!.querySelector('.xterm-screen')!.getBoundingClientRect();
    return {x:r.left+(column+.5)*r.width/t.cols,y:r.top+(row+.5)*r.height/t.rows};
  },[row,column] as const);
}
const screenEdges=(page:Page)=>page.evaluate(()=>{const r=window.ownedHistory.terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect();return {top:r.top,bottom:r.bottom};});
/** The selection read independently from buffer cells, joined as the terminal holds its rows. */
function selected(page:Page) {
  return page.evaluate(()=>{
    const t=window.ownedHistory.terminal,p=t.getSelectionPosition()!,b=t.buffer.active,rows:string[]=[];
    for(let y=p.start.y;y<=p.end.y;y++)rows.push(b.getLine(y)!.translateToString(true,y===p.start.y?p.start.x:0,y===p.end.y?p.end.x:t.cols));
    return {start:p.start,end:p.end,text:rows.join('\n'),viewportY:b.viewportY,rows:t.rows};
  });
}
async function touch(page:Page) {return page.context().newCDPSession(page);}
async function longPress(page:Page,point:{x:number;y:number}) {
  const input=await touch(page);
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  await page.waitForTimeout(650);
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await input.detach();
}
/** Drags a handle to `to`, holds it there until `until` holds, then lifts. */
async function dragHandle(page:Page,input:CDPSession,which:'start'|'end',to:{x:number;y:number},until:()=>Promise<boolean>) {
  const box=(await handle(page,which).boundingBox())!,from={x:box.x+box.width/2,y:box.y+box.height/2};
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
  for(let step=1;step<=4;step++)await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*step/4,y:from.y+(to.y-from.y)*step/4}]});
  await expect.poll(until,{timeout:15000}).toBe(true);
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
}
async function copyMatches(page:Page) {
  const expected=await selected(page);
  await actions(page).getByRole('button',{name:'Copy',exact:true}).click();
  await expect.poll(()=>readClipboard(page)).toBe(expected.text);
  return expected;
}

for(const mosh of [false,true])test.describe(mosh?'Mosh terminal':'SSH terminal',()=>{
  test('touch handles extend a selection through scrolled history past either edge',async({page},testInfo)=>{
    test.skip(testInfo.project.name!=='phone','Touch handles.');
    await open(page,mosh);
    await page.evaluate(()=>window.ownedHistory.terminal.scrollToLine(100));await settle(page);
    await longPress(page,await cell(page,2,3));
    await expect(handle(page,'end')).toBeVisible();await expect(actions(page)).toBeVisible();
    const first=await selected(page);
    expect(first.text).toMatch(/^HISTORY_\d{4}$/);
    const input=await touch(page),edges=await screenEdges(page),begin=first.viewportY;
    // Past the bottom edge the view scrolls down through history until the selection spans more than a screen.
    await dragHandle(page,input,'end',{x:(await cell(page,0,6)).x,y:edges.bottom+40},async()=>(await selected(page)).viewportY>begin+first.rows+5);
    const down=await copyMatches(page);
    expect(down.end.y-down.start.y).toBeGreaterThan(down.rows);
    expect(down.text.split('\n').length).toBe(down.end.y-down.start.y+1);
    expect(down.text.startsWith(first.text)).toBe(true);
    // A new selection near the bottom; its start handle goes past the top edge.
    await longPress(page,await cell(page,first.rows-2,3));
    await expect(handle(page,'start')).toBeVisible();
    const low=await selected(page);
    await dragHandle(page,input,'start',{x:(await cell(page,0,2)).x,y:edges.top-40},async()=>(await selected(page)).viewportY<low.viewportY-low.rows-5);
    const up=await copyMatches(page);
    expect(up.end.y-up.start.y).toBeGreaterThan(up.rows);
    expect(up.end).toEqual(low.end);
    await input.detach();
  });

  test('a selection survives streaming output and finger or wheel scrolling',async({page},testInfo)=>{
    const phone=testInfo.project.name==='phone';
    await open(page,mosh);
    await page.evaluate(()=>window.ownedHistory.terminal.scrollToLine(120));await settle(page);
    if(phone)await longPress(page,await cell(page,3,2));
    else {const at=await cell(page,3,2);await page.mouse.dblclick(at.x,at.y);}
    await expect(actions(page)).toBeVisible();
    const before=await selected(page);
    for(let chunk=0;chunk<3;chunk++){await output(page,historyLines(30,1000+chunk*30));await settle(page);}
    expect(await selected(page)).toEqual(before);
    await scrollHistory(page,phone,6);
    const scrolled=await selected(page);
    expect({start:scrolled.start,end:scrolled.end,text:scrolled.text}).toEqual({start:before.start,end:before.end,text:before.text});
    expect(scrolled.viewportY).toBeLessThan(before.viewportY);
    await copyMatches(page);
  });

  test('mouse drag selection scrolls past the bottom edge and copies every selected row',async({page},testInfo)=>{
    test.skip(testInfo.project.name!=='desktop','Mouse selection.');
    await open(page,mosh);
    await page.evaluate(()=>window.ownedHistory.terminal.scrollToLine(100));await settle(page);
    const begin=await historyView(page),from=await cell(page,1,4),edges=await screenEdges(page);
    await page.mouse.move(from.x,from.y);await page.mouse.down();
    await page.mouse.move(from.x+30,edges.bottom+30,{steps:4});
    await expect.poll(async()=>(await historyView(page)).viewportY,{timeout:15000}).toBeGreaterThan(begin.viewportY+begin.rows+5);
    await page.mouse.up();
    await expect(actions(page)).toBeVisible();
    const copied=await copyMatches(page);
    expect(copied.end.y-copied.start.y).toBeGreaterThan(copied.rows);
    expect(copied.start).toEqual({x:4,y:begin.viewportY+1});
  });
});

test('alternate screen mouse reporting keeps Shift-drag selection, Select all and Copy screen',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Mouse selection.');
  await open(page,false);
  await page.evaluate(()=>window.ownedHistory.raw('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H'+Array.from({length:8},(_,i)=>`ALT_ROW_${i} text`).join('\r\n')));
  await settle(page);
  const from=await cell(page,1,0),to=await cell(page,3,4);
  await page.keyboard.down('Shift');
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:4});await page.mouse.up();
  await page.keyboard.up('Shift');
  await expect(actions(page)).toBeVisible();
  // The remote app received no mouse reports for the forced local selection.
  expect(await page.evaluate(()=>window.ownedHistory.writes.filter(data=>data.startsWith('\x1b[<')))).toEqual([]);
  await copyMatches(page);
  expect(await readClipboard(page)).toBe('ALT_ROW_1 text\nALT_ROW_2 text\nALT_');
  await page.keyboard.down('Shift');
  await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:2});await page.mouse.up();
  await page.keyboard.up('Shift');
  await actions(page).getByRole('button',{name:'Select all',exact:true}).click();
  expect((await selected(page)).text).toBe(await page.evaluate(()=>{const b=window.ownedHistory.terminal.buffer.active;return Array.from({length:b.length},(_,y)=>b.getLine(y)!.translateToString(true)).join('\n');}));
  const screen=await page.evaluate(()=>{const t=window.ownedHistory.terminal,b=t.buffer.active;return Array.from({length:t.rows},(_,row)=>b.getLine(b.viewportY+row)!.translateToString(true)).join('\n');});
  await actions(page).getByRole('button',{name:'Copy screen',exact:true}).click();
  await expect.poll(()=>readClipboard(page)).toBe(screen);
  await expect(actions(page)).toHaveCount(0);
});

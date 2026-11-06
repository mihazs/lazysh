import {expect,test,type Page} from '@playwright/test';
import {historyLines,historyView,mountHistory,settle} from './fixtures/terminalHistory';

const output=(page:Page,lines:string[])=>page.evaluate(lines=>window.ownedHistory.output(lines),lines);
test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedHistory?.dispose());});

/** Whether a rendered row shows `text` inside the clipped terminal pane. */
const shown=(page:Page,text:string)=>page.evaluate(text=>{
  const pane=document.querySelector('.terminal-canvas')!.getBoundingClientRect();
  return Array.from(document.querySelectorAll('.terminal-canvas .xterm-rows > div')).some(row=>{
    const box=row.getBoundingClientRect();
    return row.textContent?.includes(text)===true&&box.top>=pane.top-0.5&&box.bottom<=pane.bottom+0.5;
  });
},text);

for(const mosh of [false,true])test(`${mosh?'Mosh':'SSH'}: a soft keyboard keeps the newest output and the cursor row on screen`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Only a touch device opens a soft keyboard.');
  // The remote model is mosh-server's own: a shrink keeps the top rows and drops the bottom ones.
  await mountHistory(page,mosh,true,true);
  await output(page,historyLines(120));await settle(page);
  const before=await historyView(page),newest='HISTORY_0119';
  expect(await shown(page,newest)).toBe(true);
  const size=page.viewportSize()!;
  await page.setViewportSize({width:size.width,height:size.height-320});
  // Wait out a Mosh round trip as well as the local fit.
  await page.waitForTimeout(120);await settle(page);
  const covered=await historyView(page);
  await testInfo.attach('keyboard',{body:JSON.stringify({before,covered}),contentType:'application/json'});
  expect(await shown(page,newest)).toBe(true);
  expect(covered.viewportY).toBe(covered.baseY);
  if(mosh) {
    // The covered rows stay on the remote screen: the keyboard never shrinks it.
    expect(covered.rows).toBe(before.rows);
    expect(await page.evaluate(()=>window.ownedHistory.resizes.every(size=>size.rows>=window.ownedHistory.terminal.rows))).toBe(true);
  } else expect(covered.rows).toBeLessThan(before.rows);
  await output(page,['TYPED_WITH_KEYBOARD']);await settle(page);
  expect(await shown(page,'TYPED_WITH_KEYBOARD')).toBe(true);
  await page.setViewportSize(size);
  await page.waitForTimeout(120);await settle(page);
  const closed=await historyView(page);
  expect(closed.rows).toBe(before.rows);
  for(const text of [newest,'TYPED_WITH_KEYBOARD'])expect(await shown(page,text)).toBe(true);
  // Without the keyboard the whole screen fits, so nothing stays panned.
  expect(await page.locator('.terminal-canvas .xterm-screen').evaluate(node=>(node as HTMLElement).style.transform)).toBe('');
  expect(await page.evaluate(()=>window.ownedHistory.errors)).toEqual([]);
});

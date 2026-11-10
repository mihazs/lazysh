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

test('a non-redrawing Mosh screen loses bottom rows on shrink',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone');
  await mountHistory(page,true,true,true);
  await output(page,historyLines(120));await settle(page);
  expect(await shown(page,'HISTORY_0119')).toBe(true);
  const size=page.viewportSize()!;
  await page.setViewportSize({width:size.width,height:size.height-320});
  await page.waitForTimeout(120);await settle(page);
  expect(await shown(page,'HISTORY_0119')).toBe(false);
  await page.setViewportSize(size);await page.waitForTimeout(120);await settle(page);
  expect(await shown(page,'HISTORY_0119')).toBe(false);
});

test('Mosh requests and restores keyboard-sized remote geometry',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone');
  await mountHistory(page,true,true,true);
  const before=await historyView(page),size=page.viewportSize()!;
  await page.setViewportSize({width:size.width,height:size.height-320});
  await page.waitForTimeout(120);await settle(page);
  const smaller=await historyView(page);
  expect(smaller.rows).toBeLessThan(before.rows);
  expect(await page.locator('.terminal-pane:visible').evaluate(node=>(node as HTMLElement).style.marginBottom)).toBe('');
  expect(await page.evaluate(()=>window.ownedHistory.resizes.at(-1)?.rows)).toBe(smaller.rows);
  await page.setViewportSize(size);
  await page.waitForTimeout(120);await settle(page);
  expect((await historyView(page)).rows).toBe(before.rows);
  expect(await page.evaluate(()=>window.ownedHistory.resizes.at(-1)?.rows)).toBe(before.rows);
});

for(const mosh of [false,true])test(`${mosh?'Mosh':'SSH'} fits and restores when only the visual viewport changes`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone');
  await mountHistory(page,mosh,true,true);
  const before=await historyView(page);
  await page.evaluate(()=>{
    const viewport=window.visualViewport!;
    Object.defineProperty(viewport,'height',{configurable:true,value:viewport.height-320});
    viewport.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async()=>(await historyView(page)).rows).toBeLessThan(before.rows);
  const reduced=(await historyView(page)).rows;
  await page.evaluate(()=>{const viewport=window.visualViewport!;Object.defineProperty(viewport,'scale',{configurable:true,value:2});viewport.dispatchEvent(new Event('resize'));});
  await expect.poll(async()=>(await historyView(page)).rows).toBe(before.rows);
  await page.evaluate(()=>{const viewport=window.visualViewport!;delete (viewport as unknown as {scale?:number}).scale;Object.defineProperty(viewport,'offsetTop',{configurable:true,value:40});viewport.dispatchEvent(new Event('scroll'));});
  await expect.poll(async()=>(await historyView(page)).rows).toBeGreaterThan(reduced);
  await page.evaluate(()=>{const viewport=window.visualViewport!;delete (viewport as unknown as {offsetTop?:number}).offsetTop;});
  await page.evaluate(()=>{const viewport=window.visualViewport!;delete (viewport as unknown as {height?:number}).height;viewport.dispatchEvent(new Event('resize'));});
  await expect.poll(async()=>(await historyView(page)).rows).toBe(before.rows);
});

test('a redraw keeps a Mosh question and choices visible and accepts one answer',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone');
  await mountHistory(page,true,true,false);
  await output(page,[...historyLines(80),'QUESTION?','OPTION_YES','OPTION_NO','INPUT>']);
  await page.evaluate(()=>window.ownedHistory.raw('\x1b[H'));await settle(page);
  const size=page.viewportSize()!;
  await page.setViewportSize({width:size.width,height:size.height-320});
  await page.waitForTimeout(120);await settle(page);
  for(const text of ['QUESTION?','OPTION_YES','OPTION_NO','INPUT>'])expect(await shown(page,text)).toBe(true);
  await page.locator('.terminal-canvas .xterm-helper-textarea').focus();
  await page.keyboard.type('y');await settle(page);
  expect(await page.evaluate(()=>window.ownedHistory.writes.join(''))).toBe('y');
  await page.setViewportSize(size);await page.waitForTimeout(120);await settle(page);
  for(const text of ['QUESTION?','OPTION_YES','OPTION_NO','INPUT>'])expect(await shown(page,text)).toBe(true);
});

for(const mosh of [false,true])test(`${mosh?'Mosh':'SSH'}: a soft keyboard keeps the newest output and the cursor row on screen`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Only a touch device opens a soft keyboard.');
  // A responsive remote application redraws its content at the new size.
  await mountHistory(page,mosh,true,false);
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
  expect(covered.rows).toBeLessThan(before.rows);
  await output(page,['TYPED_WITH_KEYBOARD']);await settle(page);
  expect(await shown(page,'TYPED_WITH_KEYBOARD')).toBe(true);
  await page.setViewportSize(size);
  await page.waitForTimeout(120);await settle(page);
  const closed=await historyView(page);
  expect(closed.rows).toBe(before.rows);
  for(const text of [newest,'TYPED_WITH_KEYBOARD'])expect(await shown(page,text)).toBe(true);
  expect(await page.locator('.terminal-canvas .xterm-screen').evaluate(node=>(node as HTMLElement).style.transform)).toBe('');
  expect(await page.evaluate(()=>window.ownedHistory.errors)).toEqual([]);
});

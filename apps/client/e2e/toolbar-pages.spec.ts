import {expect,test,type Locator,type Page,type TestInfo} from '@playwright/test';
import {openToolbarTerminal} from './fixtures/localTerminal';
import {shrinkVisualViewport} from './fixtures/visualViewport';

type Point={x:number;y:number};
const wideRow=['esc','tab','ctrl','meta','shift','enter','backspace','Home','End','PageUp','PageDown','Insert','Delete','F1','F2','F3','F4','F5','F6','F7','F8'];

/** A local terminal whose toolbar has one saved snippet and one literal chord (the default layout unless `extra` sets one). */
const openToolbar=(page:Page,testInfo:TestInfo,extra:Record<string,unknown>={})=>openToolbarTerminal(page,testInfo,
  {snippets:[{label:'Greet',text:'echo snippet'}],chords:[{label:'Mark',keys:'text:PAGE_MARK'}],...extra});
const writes=(page:Page)=>page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'));
const terminalFocused=(page:Page)=>page.evaluate(()=>document.activeElement===document.querySelector('.terminal-canvas .xterm-helper-textarea'));
const center=async(target:Locator):Promise<Point>=>{const box=(await target.boundingBox())!;return {x:box.x+box.width/2,y:box.y+box.height/2};};
const press=(testInfo:TestInfo,key:Locator)=>testInfo.project.name==='phone'?key.tap():key.click();

const indicators=(keys:Locator)=>keys.getByRole('group',{name:'Toolbar pages',exact:true}).getByRole('button');
const indicator=(keys:Locator,name:string)=>keys.getByRole('group',{name:'Toolbar pages',exact:true}).getByRole('button',{name:`${name} page`,exact:true});
const pager=(keys:Locator)=>keys.getByRole('group',{name:'Toolbar pages',exact:true});
/** Activates a page button without a pointer: the dots take no touches while hidden, and a real tap on one has its own spec. */
const choose=(keys:Locator,name:'Keys'|'Tools'|'Snippets')=>indicator(keys,name).evaluate(node=>(node as HTMLElement).click());
const opacity=(target:Locator)=>target.evaluate(node=>Number(getComputedStyle(node).opacity));
/** How long to wait for the indicator to fade out: longer than its delay and its fade. */
const hideTimeout=6000;
type Box={x:number;y:number;width:number;height:number};
const overlap=(a:Box,b:Box)=>a.x<b.x+b.width&&b.x<a.x+a.width&&a.y<b.y+b.height&&b.y<a.y+a.height;
/** The dots lie inside the toolbar's own box, over none of its keys, and above the status bar and the bottom of the visual viewport (the soft keyboard). */
async function expectClear(page:Page,keys:Locator) {
  const dots=(await pager(keys).boundingBox())!,toolbar=(await keys.boundingBox())!;
  expect(dots.y).toBeGreaterThanOrEqual(toolbar.y);
  expect(dots.y+dots.height).toBeLessThanOrEqual(toolbar.y+toolbar.height);
  for(const key of await keys.getByRole('group',{name:/ page$/}).getByRole('button').all())if(await key.isVisible())expect(overlap(dots,(await key.boundingBox())!)).toBe(false);
  const footer=page.locator('.workspace-footer');
  if(await footer.isVisible())expect(dots.y+dots.height).toBeLessThanOrEqual((await footer.boundingBox())!.y+.5);
  const view=await page.evaluate(()=>window.visualViewport!.offsetTop+window.visualViewport!.height);
  expect(dots.y+dots.height).toBeLessThanOrEqual(view+.5);
}
/** The named page is selected and actually scrolled into the toolbar, not just marked current. */
async function expectPage(keys:Locator,name:'Keys'|'Tools'|'Snippets') {
  await expect(indicator(keys,name)).toHaveAttribute('aria-current','true');
  const panel=keys.getByRole('group',{name:`${name} page`,exact:true}),pages=keys.locator('.terminal-keys-pages');
  await expect.poll(async()=>Math.abs((await panel.boundingBox())!.x-(await pages.boundingBox())!.x)).toBeLessThan(2);
}
/** One finger drag through real touch events, so the browser scrolls and snaps as it would on a phone; `hold` waits before moving. */
async function swipe(page:Page,from:Point,to:Point,steps=12,hold=0) {
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
  if(hold)await page.waitForTimeout(hold);
  for(let step=1;step<=steps;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*step/steps,y:from.y+(to.y-from.y)*step/steps}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await cdp.detach();
}

test('the toolbar has a keys page, a tools page and a snippets page, each with its own keys and no extra height',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const tabs=indicators(keys);
  await expect(tabs).toHaveCount(3);
  expect(await tabs.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')))).toEqual(['Keys page','Tools page','Snippets page']);
  await expectPage(keys,'Keys');
  const compact=(await keys.boundingBox())!;
  // The page indicator is drawn inside the toolbar's own padding: below the last key row, within the toolbar, adding nothing.
  const lastRow=(await keys.locator('.terminal-keys-row').last().boundingBox())!,dots=(await keys.getByRole('group',{name:'Toolbar pages',exact:true}).boundingBox())!;
  expect(dots.y).toBeGreaterThanOrEqual(lastRow.y+lastRow.height);
  expect(dots.y+dots.height).toBeLessThanOrEqual(compact.y+compact.height);
  expect(compact.height).toBe(74);
  await page.screenshot({path:testInfo.outputPath('toolbar-keys-page.png')});

  await choose(keys,'Tools');
  await expectPage(keys,'Tools');
  await expect(keys.getByRole('group',{name:'Tools page',exact:true}).getByRole('button')).toHaveText(['Find','Copy']);
  expect((await keys.boundingBox())!.height).toBe(compact.height);
  await page.screenshot({path:testInfo.outputPath('toolbar-tools-page.png')});
  await choose(keys,'Snippets');
  await expectPage(keys,'Snippets');
  await expect(keys.getByRole('group',{name:'Snippets page',exact:true}).getByRole('button')).toHaveText(['Greet','Mark']);
  expect((await keys.boundingBox())!.height).toBe(compact.height);
  // The keys on every page are as tall as the keys of the grid.
  for(const button of await keys.getByRole('group',{name:'Snippets page',exact:true}).getByRole('button').all())expect((await button.boundingBox())!.height).toBe(32);
  await page.screenshot({path:testInfo.outputPath('toolbar-snippets-page.png')});
  await choose(keys,'Keys');
  await expectPage(keys,'Keys');
});

test('the page buttons switch pages without a gesture, with or without the keyboard, and the pages send their input',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const tab=(name:'Keys'|'Tools'|'Snippets')=>indicator(keys,name);
  await expect(tab('Keys')).toHaveAttribute('aria-current','true');
  await expect(tab('Tools')).not.toHaveAttribute('aria-current');
  await choose(keys,'Snippets');
  await expectPage(keys,'Snippets');
  // The press leaves focus, and so the on-screen keyboard, in the terminal.
  expect(await terminalFocused(page)).toBe(true);
  await press(testInfo,keys.getByRole('button',{name:'Mark',exact:true}));
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK']);
  expect(await terminalFocused(page)).toBe(true);
  // A keyboard user reaches the indicator buttons in order and selects a page with Enter or Space.
  await tab('Tools').focus();
  await page.keyboard.press('Enter');
  await expectPage(keys,'Tools');
  await tab('Keys').focus();
  await page.keyboard.press('Space');
  await expectPage(keys,'Keys');

  await choose(keys,'Snippets');
  await press(testInfo,keys.getByRole('button',{name:'Greet',exact:true}));
  await expect(page.locator('.terminal-compose textarea')).toHaveValue('echo snippet');
  await page.getByRole('button',{name:'Close composer',exact:true}).click();
  // The toolbar comes back from behind the composer on the page that was in use.
  await expectPage(keys,'Snippets');
  await choose(keys,'Tools');
  await expectPage(keys,'Tools');
  await press(testInfo,keys.getByRole('button',{name:'Find',exact:true}));
  await expect(page.locator('.terminal-search input')).toBeVisible();
  // Page keys never type; only Mark did.
  expect(await writes(page)).toEqual(['PAGE_MARK']);
});

test('a swipe moves between the pages, never types, and a key on the page sends its bytes',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch swipe contract.');
  const keys=await openToolbar(page,testInfo);
  await expectPage(keys,'Keys');
  const y=(await center(keys.locator('.terminal-keys-row').first())).y;
  // The swipe starts on a key (Up arrow, which repeats): the slide belongs to the toolbar and the key is not pressed.
  const start={x:(await center(keys.getByRole('button',{name:'Arrow up',exact:true}))).x,y};
  await swipe(page,start,{x:start.x-270,y});
  await expectPage(keys,'Tools');
  expect(await writes(page)).toEqual([]);
  await swipe(page,{x:330,y},{x:60,y});
  await expectPage(keys,'Snippets');
  expect(await writes(page)).toEqual([]);
  // The last page does not wrap: another slide stays.
  await swipe(page,{x:330,y},{x:60,y});
  await expectPage(keys,'Snippets');
  await keys.getByRole('button',{name:'Mark',exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK']);
  await swipe(page,{x:60,y},{x:330,y});
  await expectPage(keys,'Tools');
  await swipe(page,{x:60,y},{x:330,y});
  await expectPage(keys,'Keys');
  await keys.getByRole('button',{name:'tab',exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK','\t']);
  expect((await keys.boundingBox())!.height).toBe(74);
});

test('a wide key row scrolls its own keys first and a swipe that starts at its end continues to the next page',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch swipe contract.');
  const keys=await openToolbar(page,testInfo,{toolbar:wideRow});
  const row=keys.locator('.terminal-keys-row');
  await expect(row).toHaveCount(1);
  await expectPage(keys,'Keys');
  const scroll=()=>row.evaluate(node=>({left:Math.round(node.scrollLeft),end:node.scrollLeft+node.clientWidth>=node.scrollWidth-1}));
  expect(await row.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
  /** Waits for the row's momentum to stop, then reports where it rests. */
  const settled=async()=>{let last=-1;await expect.poll(async()=>{const now=(await scroll()).left,still=now===last;last=now;return still;},{intervals:[150]}).toBe(true);return scroll();};
  const y=(await center(row)).y;
  await swipe(page,{x:330,y},{x:60,y});
  expect((await settled()).left).toBeGreaterThan(0);
  await expectPage(keys,'Keys');
  for(let slide=0;slide<8&&!(await settled()).end;slide++){
    await swipe(page,{x:330,y},{x:60,y});
    await expectPage(keys,'Keys');
  }
  expect((await settled()).end).toBe(true);
  await swipe(page,{x:330,y},{x:60,y});
  await expectPage(keys,'Tools');
  expect(await writes(page)).toEqual([]);
  await swipe(page,{x:60,y},{x:330,y});
  await expectPage(keys,'Keys');
});

test('a drag that follows a held, repeating key stays on the page and the key keeps repeating',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch hold contract.');
  const keys=await openToolbar(page,testInfo);
  const up=await center(keys.getByRole('button',{name:'Arrow up',exact:true}));
  await swipe(page,up,{x:up.x-270,y:up.y},20,700);
  await expect.poll(async()=>(await writes(page)).length).toBeGreaterThan(1);
  expect(new Set(await writes(page))).toEqual(new Set(['\x1b[A']));
  await expectPage(keys,'Keys');
  // The finger lifted: repeating stops and the next swipe turns the page again.
  const total=(await writes(page)).length;
  await page.waitForTimeout(400);
  expect((await writes(page)).length).toBe(total);
  await swipe(page,{x:330,y:up.y},{x:60,y:up.y});
  await expectPage(keys,'Tools');
});

test('a key with a long-press action keeps its hold and the swipe does not turn the page under it',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch hold contract.');
  const keys=await openToolbar(page,testInfo,{toolbarAlternates:{tab:{action:'escape'}}});
  const tab=await center(keys.getByRole('button',{name:'tab',exact:true}));
  await swipe(page,tab,{x:tab.x-270,y:tab.y},20,900);
  await expect.poll(()=>writes(page)).toEqual(['\x1b']);
  await expectPage(keys,'Keys');
});

test('the pages follow the key height setting and the saved layout, and a one-row layout keeps its single row',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo,{toolbarKeyHeight:48});
  const height=(await keys.boundingBox())!.height;
  // Two 48px rows and the same padding as at 32px: 74 + 2 * 16.
  expect(height).toBe(106);
  await choose(keys,'Snippets');
  await expectPage(keys,'Snippets');
  expect((await keys.boundingBox())!.height).toBe(height);
  for(const button of await keys.getByRole('group',{name:'Snippets page',exact:true}).getByRole('button').all())expect((await button.boundingBox())!.height).toBe(48);
  await page.evaluate(toolbar=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar,toolbarKeyHeight:48,chords:[{label:'Mark',keys:'text:PAGE_MARK'}]}));window.dispatchEvent(new StorageEvent('storage',{key:'lazysh.preferences.v1'}));},['esc','tab']);
  await expect(keys.locator('.terminal-keys-row')).toHaveCount(1);
  // One row of keys: the pages are one row tall as well.
  expect((await keys.boundingBox())!.height).toBe(106-48-3);
  await choose(keys,'Snippets');
  await expectPage(keys,'Snippets');
  await expect(keys.getByRole('button',{name:'Mark',exact:true})).toBeInViewport({ratio:1});
});

test('a toolbar without saved snippets or chords has the keys and tools pages only',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo,{snippets:[],chords:[]});
  await expect(indicators(keys)).toHaveCount(2);
  expect(await indicators(keys).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')))).toEqual(['Keys page','Tools page']);
});

test('the page indicator is hidden on load, takes no touches, and covers neither keys nor the status bar',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const dots=pager(keys);
  await expect(dots.getByRole('button')).toHaveCount(3);
  expect(await opacity(dots)).toBe(0);
  expect(await dots.evaluate(node=>getComputedStyle(node).pointerEvents)).toBe('none');
  // Hidden is not removed: the buttons keep their size and their names, so a screen reader and the Tab key still reach them.
  for(const name of ['Keys','Tools','Snippets'])expect((await indicator(keys,name).boundingBox())!.height).toBeGreaterThan(0);
  // A touch on the dots goes to what is under them, never to a hidden button.
  const point=await center(indicator(keys,'Tools'));
  expect(await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('.terminal-keys-pager')??null,point)).toBeNull();
  expect((await keys.boundingBox())!.height).toBe(74);
  await expectClear(page,keys);
  await page.screenshot({path:testInfo.outputPath('pager-hidden.png')});
  // Nothing changes the page, so it stays hidden.
  await page.waitForTimeout(500);
  expect(await opacity(dots)).toBe(0);
});

test('a swipe to another page fades the dots in as reduced-opacity dots, and they fade out again',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch swipe contract.');
  const keys=await openToolbar(page,testInfo);
  const dots=pager(keys),y=(await center(keys.locator('.terminal-keys-row').first())).y;
  expect(await opacity(dots)).toBe(0);
  await swipe(page,{x:330,y},{x:60,y});
  await expectPage(keys,'Tools');
  await expect.poll(()=>opacity(dots)).toBe(1);
  expect(await dots.evaluate(node=>getComputedStyle(node).pointerEvents)).toBe('auto');
  // Dots, not lines: round marks of one size, the page in view a little longer, none fully opaque.
  const marks=await dots.locator('span').evaluateAll(nodes=>nodes.map(node=>{const style=getComputedStyle(node),box=node.getBoundingClientRect();return {width:box.width,height:box.height,opacity:Number(style.opacity),radius:parseFloat(style.borderTopLeftRadius)};}));
  expect(marks.map(mark=>mark.height)).toEqual([marks[0].height,marks[0].height,marks[0].height]);
  expect(marks[0].height).toBeGreaterThanOrEqual(4);
  expect(marks[0].height).toBeLessThanOrEqual(6);
  for(const mark of marks)expect(mark.radius).toBeGreaterThanOrEqual(mark.height/2);
  expect(marks[0].width).toBe(marks[0].height);
  expect(marks[2].width).toBe(marks[0].width);
  await expect.poll(async()=>(await dots.locator('span').nth(1).evaluate(node=>node.getBoundingClientRect().width))).toBeGreaterThan(marks[0].width);
  for(const mark of marks)expect(mark.opacity).toBeLessThan(1);
  expect(marks[0].opacity).toBeGreaterThanOrEqual(.55);
  expect(marks[0].opacity).toBeLessThanOrEqual(.7);
  expect(marks[1].opacity).toBeGreaterThan(marks[0].opacity);
  expect(marks[1].opacity).toBeLessThanOrEqual(1);
  expect(marks[2].opacity).toBe(marks[0].opacity);
  await expectClear(page,keys);
  expect((await keys.boundingBox())!.height).toBe(74);
  await page.screenshot({path:testInfo.outputPath('pager-visible.png')});
  // Then it goes, fading rather than snapping.
  await expect.poll(()=>opacity(dots),{timeout:hideTimeout}).toBeLessThan(1);
  await expect.poll(()=>opacity(dots),{timeout:hideTimeout}).toBe(0);
  expect(await dots.evaluate(node=>getComputedStyle(node).pointerEvents)).toBe('none');
  expect(await dots.evaluate(node=>getComputedStyle(node).transitionProperty+' '+getComputedStyle(node).transitionDuration)).toBe('opacity 0.22s');
  await expectPage(keys,'Tools');
});

test('a shown indicator takes the pointer: pressing a dot switches page and keeps the dots for another delay',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const dots=pager(keys);
  await choose(keys,'Tools');
  await expectPage(keys,'Tools');
  await expect.poll(()=>opacity(dots)).toBe(1);
  await page.waitForTimeout(1200);
  await press(testInfo,indicator(keys,'Snippets'));
  await expectPage(keys,'Snippets');
  // Pressing a dot leaves the focus, and so the soft keyboard, in the terminal.
  expect(await terminalFocused(page)).toBe(true);
  // 1.2 s after the first change the first delay would be nearly over; the press started a new one.
  await page.waitForTimeout(1200);
  expect(await opacity(dots)).toBe(1);
  await expect.poll(()=>opacity(dots),{timeout:hideTimeout}).toBe(0);
});

test('keyboard focus on a page button shows the indicator at once and keeps it while focused',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const dots=pager(keys);
  expect(await opacity(dots)).toBe(0);
  await indicator(keys,'Tools').focus();
  await expect.poll(()=>opacity(dots)).toBe(1);
  expect(await dots.evaluate(node=>getComputedStyle(node).pointerEvents)).toBe('auto');
  await page.keyboard.press('Enter');
  await expectPage(keys,'Tools');
  // Well past the delay of a page change: the focused dots stay.
  await page.waitForTimeout(3000);
  expect(await opacity(dots)).toBe(1);
  await expectClear(page,keys);
  await page.evaluate(()=>(document.activeElement as HTMLElement).blur());
  await expect.poll(()=>opacity(dots),{timeout:hideTimeout}).toBe(0);
});

test('with reduced motion the dots appear and go without a fade, after the same delay',async({page},testInfo)=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  const keys=await openToolbar(page,testInfo);
  const dots=pager(keys);
  expect(await opacity(dots)).toBe(0);
  await choose(keys,'Tools');
  await expect.poll(()=>opacity(dots)).toBe(1);
  expect(await dots.evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');
  expect(await dots.locator('span').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).transitionDuration))).toEqual(['0s','0s','0s']);
  await page.waitForTimeout(800);
  expect(await opacity(dots)).toBe(1);
  await expect.poll(()=>opacity(dots),{timeout:hideTimeout}).toBe(0);
});

test('screen-reader mode keeps the indicator shown',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo,{screenReader:true});
  const dots=pager(keys);
  await expect.poll(()=>opacity(dots)).toBe(1);
  expect(await dots.evaluate(node=>getComputedStyle(node).pointerEvents)).toBe('auto');
  await choose(keys,'Tools');
  await expectPage(keys,'Tools');
  await page.waitForTimeout(3000);
  expect(await opacity(dots)).toBe(1);
  await expectClear(page,keys);
  await page.screenshot({path:testInfo.outputPath('pager-screen-reader.png')});
});

for(const [kind,keyboard] of [
  ['a window the keyboard shrinks',async(page:Page)=>{const size=page.viewportSize()!;await page.setViewportSize({width:size.width,height:size.height-320});}],
  ['a visual viewport only the keyboard shrinks',(page:Page)=>shrinkVisualViewport(page,320)],
] as const)test(`the page indicator stays inside the toolbar, above the soft keyboard, with the keyboard open in ${kind}`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','The soft keyboard.');
  const keys=await openToolbar(page,testInfo);
  await keyboard(page);
  await page.waitForTimeout(400);
  expect(await opacity(pager(keys))).toBe(0);
  await choose(keys,'Tools');
  await expectPage(keys,'Tools');
  await expect.poll(()=>opacity(pager(keys))).toBe(1);
  await expectClear(page,keys);
  expect((await keys.boundingBox())!.height).toBe(74);
  await page.screenshot({path:testInfo.outputPath(`pager-keyboard-${kind.replace(/\W+/g,'-')}.png`)});
  await expect.poll(()=>opacity(pager(keys)),{timeout:hideTimeout}).toBe(0);
});

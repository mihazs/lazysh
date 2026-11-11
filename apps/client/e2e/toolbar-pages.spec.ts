import {expect,test,type Locator,type Page,type TestInfo} from '@playwright/test';
import {installLocalTerminal} from './fixtures/localTerminal';

type Point={x:number;y:number};
const wideRow=['esc','tab','ctrl','meta','shift','enter','backspace','Home','End','PageUp','PageDown','Insert','Delete','F1','F2','F3','F4','F5','F6','F7','F8'];

/** A local terminal whose toolbar has one saved snippet and one literal chord (the default layout unless `extra` sets one); input bytes are recorded. */
async function openToolbar(page:Page,testInfo:TestInfo,extra:Record<string,unknown>={}) {
  await installLocalTerminal(page);
  await page.addInitScript(extra=>{
    if(sessionStorage.getItem('toolbar-pages-seeded'))return;
    sessionStorage.setItem('toolbar-pages-seeded','1');
    localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,composerSendEnter:false,
      snippets:[{label:'Greet',text:'echo snippet'}],chords:[{label:'Mark',keys:'text:PAGE_MARK'}],...extra}));
  },extra);
  await page.goto('/');
  await openTerminal(page,testInfo);
  return page.getByLabel('Terminal keys',{exact:true});
}
async function openTerminal(page:Page,testInfo:TestInfo) {
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.simpleShortcutOutput)).toBe('function');
}
const writes=(page:Page)=>page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'));
const terminalFocused=(page:Page)=>page.evaluate(()=>document.activeElement===document.querySelector('.terminal-canvas .xterm-helper-textarea'));
const center=async(target:Locator):Promise<Point>=>{const box=(await target.boundingBox())!;return {x:box.x+box.width/2,y:box.y+box.height/2};};
const press=(testInfo:TestInfo,key:Locator)=>testInfo.project.name==='phone'?key.tap():key.click();

const indicators=(keys:Locator)=>keys.getByRole('group',{name:'Toolbar pages',exact:true}).getByRole('button');
const indicator=(keys:Locator,name:string)=>keys.getByRole('group',{name:'Toolbar pages',exact:true}).getByRole('button',{name:`${name} page`,exact:true});
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

  await tabs.nth(1).click();
  await expectPage(keys,'Tools');
  await expect(keys.getByRole('group',{name:'Tools page',exact:true}).getByRole('button')).toHaveText(['Find','Copy']);
  expect((await keys.boundingBox())!.height).toBe(compact.height);
  await page.screenshot({path:testInfo.outputPath('toolbar-tools-page.png')});
  await tabs.nth(2).click();
  await expectPage(keys,'Snippets');
  await expect(keys.getByRole('group',{name:'Snippets page',exact:true}).getByRole('button')).toHaveText(['Greet','Mark']);
  expect((await keys.boundingBox())!.height).toBe(compact.height);
  // The keys on every page are as tall as the keys of the grid.
  for(const button of await keys.getByRole('group',{name:'Snippets page',exact:true}).getByRole('button').all())expect((await button.boundingBox())!.height).toBe(32);
  await page.screenshot({path:testInfo.outputPath('toolbar-snippets-page.png')});
  await tabs.nth(0).click();
  await expectPage(keys,'Keys');
});

test('the page indicator switches pages without a gesture, by pointer and by keyboard, and the pages send their input',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const tab=(name:'Keys'|'Tools'|'Snippets')=>indicator(keys,name);
  await expect(tab('Keys')).toHaveAttribute('aria-current','true');
  await expect(tab('Tools')).not.toHaveAttribute('aria-current');
  await tab('Snippets').click();
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

  await tab('Snippets').click();
  await press(testInfo,keys.getByRole('button',{name:'Greet',exact:true}));
  await expect(page.locator('.terminal-compose textarea')).toHaveValue('echo snippet');
  await page.getByRole('button',{name:'Close composer',exact:true}).click();
  // The toolbar comes back from behind the composer on the page that was in use.
  await expectPage(keys,'Snippets');
  await tab('Tools').click();
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
  await indicator(keys,'Snippets').click();
  await expectPage(keys,'Snippets');
  expect((await keys.boundingBox())!.height).toBe(height);
  for(const button of await keys.getByRole('group',{name:'Snippets page',exact:true}).getByRole('button').all())expect((await button.boundingBox())!.height).toBe(48);
  await page.evaluate(toolbar=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar,toolbarKeyHeight:48,chords:[{label:'Mark',keys:'text:PAGE_MARK'}]}));window.dispatchEvent(new StorageEvent('storage',{key:'lazysh.preferences.v1'}));},['esc','tab']);
  await expect(keys.locator('.terminal-keys-row')).toHaveCount(1);
  // One row of keys: the pages are one row tall as well.
  expect((await keys.boundingBox())!.height).toBe(106-48-3);
  await indicator(keys,'Snippets').click();
  await expectPage(keys,'Snippets');
  await expect(keys.getByRole('button',{name:'Mark',exact:true})).toBeInViewport({ratio:1});
});

test('a toolbar without saved snippets or chords has the keys and tools pages only',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo,{snippets:[],chords:[]});
  await expect(indicators(keys)).toHaveCount(2);
  expect(await indicators(keys).evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')))).toEqual(['Keys page','Tools page']);
});

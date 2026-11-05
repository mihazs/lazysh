import {expect,test,type Locator,type Page,type TestInfo} from '@playwright/test';
import {installLocalTerminal} from './fixtures/localTerminal';

type Point={x:number;y:number};
const twoRows=['esc','tab','left','row-break','up','enter'];
const threeRows=['esc','tab','row-break','up','down','row-break','enter','c'];

/** A local terminal whose toolbar has key rows, one snippet and one literal chord; input bytes are recorded. */
async function openToolbar(page:Page,testInfo:TestInfo,toolbar:string[]) {
  await installLocalTerminal(page);
  await page.addInitScript(toolbar=>{
    if(sessionStorage.getItem('toolbar-pages-seeded'))return;
    sessionStorage.setItem('toolbar-pages-seeded','1');
    localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar,composerSendEnter:false,
      snippets:[{label:'Greet',text:'echo snippet'}],chords:[{label:'Mark',keys:'text:PAGE_MARK'}]}));
  },toolbar);
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

/** The named page is selected and actually scrolled into the toolbar, not just marked current. */
async function expectPage(keys:Locator,name:'Tools'|'Snippets') {
  await expect(keys.getByRole('tab',{name,exact:true})).toHaveAttribute('aria-selected','true');
  const panel=keys.getByRole('tabpanel',{name,exact:true}),pages=keys.locator('.terminal-keys-pages');
  await expect.poll(async()=>Math.abs((await panel.boundingBox())!.x-(await pages.boundingBox())!.x)).toBeLessThan(2);
}
/** One finger drag through real touch events, so the browser scrolls and snaps as it would on a phone. */
async function swipe(page:Page,from:Point,to:Point,steps=12) {
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
  for(let step=1;step<=steps;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*step/steps,y:from.y+(to.y-from.y)*step/steps}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await cdp.detach();
}

test('a slide moves between the tools and snippets pages, both pages send their input and the page is remembered',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch slide contract.');
  const keys=await openToolbar(page,testInfo,twoRows);
  await expectPage(keys,'Tools');
  await expect(keys.getByRole('tabpanel',{name:'Tools',exact:true}).locator('.terminal-keys-row')).toHaveCount(2);
  await keys.getByRole('button',{name:'tab',exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['\t']);
  await page.screenshot({path:testInfo.outputPath('toolbar-tools-page.png')});

  const tools=await center(keys.getByRole('tabpanel',{name:'Tools',exact:true}));
  await swipe(page,{x:330,y:tools.y},{x:60,y:tools.y});
  await expectPage(keys,'Snippets');
  // The slide itself never typed: the key under the finger was not pressed.
  expect(await writes(page)).toEqual(['\t']);
  await page.screenshot({path:testInfo.outputPath('toolbar-snippets-page.png')});
  await keys.getByRole('button',{name:'Mark',exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['\t','PAGE_MARK']);
  expect(await terminalFocused(page)).toBe(true);
  // Choosing a page from its indicator leaves the terminal input, and so the keyboard, where it was.
  await keys.getByRole('tab',{name:'Tools',exact:true}).tap();
  await expectPage(keys,'Tools');
  expect(await terminalFocused(page)).toBe(true);
  await keys.getByRole('tab',{name:'Snippets',exact:true}).tap();
  await expectPage(keys,'Snippets');

  await keys.getByRole('button',{name:'Greet',exact:true}).tap();
  await expect(page.locator('.terminal-compose textarea')).toHaveValue('echo snippet');
  await page.getByRole('button',{name:'Paste draft',exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['\t','PAGE_MARK','echo snippet']);
  // The toolbar comes back from behind the composer on the page that was in use.
  await expectPage(keys,'Snippets');

  await page.reload();
  await openTerminal(page,testInfo);
  await expectPage(keys,'Snippets');
  const snippets=await center(keys.getByRole('tabpanel',{name:'Snippets',exact:true}));
  await swipe(page,{x:60,y:snippets.y},{x:330,y:snippets.y});
  await expectPage(keys,'Tools');
  await keys.getByRole('button',{name:'enter',exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['\r']);
});

test('continuing a vertical swipe past the last row opens the snippets page and past the first row returns',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch overscroll contract.');
  // A keyboard-sized viewport leaves room for two of the three rows, so the tools page scrolls.
  await page.setViewportSize({width:390,height:420});
  const keys=await openToolbar(page,testInfo,threeRows);
  const tools=keys.getByRole('tabpanel',{name:'Tools',exact:true});
  await expectPage(keys,'Tools');
  const scrollTop=()=>tools.evaluate(node=>node.scrollTop);
  expect(await tools.evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
  const start=await center(tools);
  // A short swipe only scrolls the rows.
  await swipe(page,{x:start.x,y:start.y+10},{x:start.x,y:start.y-14},4);
  await expect.poll(scrollTop).toBeGreaterThan(0);
  await expectPage(keys,'Tools');
  await page.screenshot({path:testInfo.outputPath('toolbar-tools-scrolled.png')});
  // Swiping on once the last row is showing turns to the next page.
  await swipe(page,{x:start.x,y:start.y+30},{x:start.x,y:start.y-150},16);
  await expectPage(keys,'Snippets');
  await keys.getByRole('button',{name:'Mark',exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK']);
  // The snippets page shows everything already, so a downward swipe is past its first row.
  const snippets=await center(keys.getByRole('tabpanel',{name:'Snippets',exact:true}));
  await swipe(page,{x:snippets.x,y:snippets.y-30},{x:snippets.x,y:snippets.y+120},12);
  await expectPage(keys,'Tools');
  for(const name of ['esc','c'])await keys.getByRole('button',{name,exact:true}).tap();
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK','\x1b','c']);
});

test('the wheel continues past the last row to the next page and indicators and a sideways scroll switch pages',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Mouse and trackpad contract.');
  await page.setViewportSize({width:1280,height:520});
  const keys=await openToolbar(page,testInfo,threeRows);
  const tools=keys.getByRole('tabpanel',{name:'Tools',exact:true});
  await expectPage(keys,'Tools');
  expect(await tools.evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
  const point=await center(tools);
  await page.mouse.move(point.x,point.y);
  // Above the first row there is no earlier page.
  await page.mouse.wheel(0,-120);
  await page.waitForTimeout(100);
  await expectPage(keys,'Tools');
  // The first notch scrolls the rows to their end; the next continues past it.
  await page.mouse.wheel(0,120);
  await expect.poll(()=>tools.evaluate(node=>node.scrollTop+node.clientHeight>=node.scrollHeight-1)).toBe(true);
  await expectPage(keys,'Tools');
  await page.mouse.wheel(0,120);
  await expectPage(keys,'Snippets');
  await keys.getByRole('button',{name:'Mark',exact:true}).click();
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK']);

  await keys.getByRole('tab',{name:'Tools',exact:true}).click();
  await expectPage(keys,'Tools');
  expect(await terminalFocused(page)).toBe(true);
  await keys.getByRole('button',{name:'tab',exact:true}).click();
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK','\t']);
  // A trackpad's sideways two-finger scroll slides the pages as a finger would.
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.synthesizeScrollGesture',{x:Math.round(point.x),y:Math.round(point.y),xDistance:-600,yDistance:0,gestureSourceType:'mouse',speed:1500});
  await cdp.detach();
  await expectPage(keys,'Snippets');
  // A chord stays reachable directly, which keyboard and assistive navigation rely on.
  await keys.getByRole('tab',{name:'Tools',exact:true}).click();
  await expectPage(keys,'Tools');
  await keys.getByRole('button',{name:'Mark',exact:true}).click();
  await expect.poll(()=>writes(page)).toEqual(['PAGE_MARK','\t','PAGE_MARK']);
  await expectPage(keys,'Snippets');
});

test('without snippets or chords the toolbar stays a single page with no indicators',async({page},testInfo)=>{
  await installLocalTerminal(page);
  await page.addInitScript(()=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar:['esc','tab']}));});
  await page.goto('/');
  await openTerminal(page,testInfo);
  const keys=page.getByLabel('Terminal keys',{exact:true});
  await expect(keys.getByRole('button')).toHaveText(['esc','tab','Find','Copy']);
  await expect(keys.getByRole('tablist')).toHaveCount(0);
});

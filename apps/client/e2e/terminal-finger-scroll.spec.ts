import {expect,test,type Page} from '@playwright/test';
import {compose,fingerDrag,historyLines,historyView,mountHistory,rowHeight,settle} from './fixtures/terminalHistory';

// Finger drags exist only on a touch screen; the desktop wheel path is covered by terminal-history.spec.ts.
test.skip(({isMobile})=>!isMobile,'Finger drags need a touch screen.');
test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedHistory?.dispose());});

type Route={name:string;mosh:boolean;agent:boolean};
const routes:Route[]=[
  {name:'normal scrollback',mosh:false,agent:false},
  // A full-screen agent (Claude Code fullscreen, Herdr, tmux mouse mode) scrolls its own history from wheel reports.
  {name:'a full-screen agent with mouse reporting',mosh:false,agent:true},
  // Mosh keeps the remote alternate screen in the local normal buffer.
  {name:'a Mosh agent with mouse reporting',mosh:true,agent:true},
];
const wheelUp=/^\x1b\[<64;\d+;\d+M$/;

async function open(page:Page,route:Route) {
  await mountHistory(page,route.mosh);
  await page.evaluate(lines=>window.ownedHistory.output(lines),historyLines(300));await settle(page);
  if(route.agent){await page.evaluate(mosh=>window.ownedHistory.raw(`${mosh?'':'\x1b[?1049h'}\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[H\x1b[2JAGENT`),route.mosh);await settle(page);}
}
/** Rows the reader has moved up: local history, or wheel-up reports the agent received. */
function travelled(page:Page,route:Route) {
  return route.agent
    ?page.evaluate(pattern=>window.ownedHistory.writes.filter(data=>new RegExp(pattern).test(data)).length,wheelUp.source)
    :historyView(page).then(view=>view.baseY-view.viewportY);
}
async function drag(page:Page,rows:number,slant=0) {
  const box=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!;
  await fingerDrag(page,{x:box.x+box.width/2,y:box.y+box.height/4},await rowHeight(page),rows,{slant});
}
/** The reader waits while the agent keeps writing. */
async function pause(page:Page,route:Route) {
  await page.evaluate(({agent,mosh})=>new Promise<void>(resolve=>{
    let line=0;
    const timer=setInterval(()=>void (agent&&!mosh?window.ownedHistory.raw(`\x1b[2;1HWORKING_${line++}\x1b[K`):window.ownedHistory.output([`STREAM_${line++}`])),100);
    setTimeout(()=>{clearInterval(timer);resolve();},1200);
  }),route);
  await settle(page);
}

for(const route of routes)test.describe(route.name,()=>{
  test('a slanted drag after a pause still scrolls while the keyboard composes a word',async({page})=>{
    await open(page,route);
    await drag(page,6);
    expect(await travelled(page,route)).toBe(6);
    await compose(page,'hel');
    await pause(page,route);
    const before=await travelled(page,route);
    // The first sample after touch slop moves sideways, as a thumb drag often starts.
    await drag(page,6,16);
    expect(await travelled(page,route)-before).toBe(6);
  });

  test('a toolbar key that sends the composed word leaves later drags scrolling',async({page})=>{
    await open(page,route);
    await drag(page,4);
    await compose(page,'hel');
    await page.locator('.terminal-keys button',{hasText:/^esc$/}).tap();
    await expect.poll(()=>page.evaluate(()=>window.ownedHistory.writes.slice(-2))).toEqual(['hel','\x1b']);
    await pause(page,route);
    for(const slant of [16,0,-16]){
      const before=await travelled(page,route);
      await drag(page,3,slant);
      expect(await travelled(page,route)-before).toBe(3);
    }
  });
});

test('a long-press selects a word once a toolbar key has sent the composed word',async({page})=>{
  await open(page,routes[0]);
  await compose(page,'hel');
  await page.locator('.terminal-keys button',{hasText:/^esc$/}).tap();
  await expect.poll(()=>page.evaluate(()=>window.ownedHistory.writes.slice(-2))).toEqual(['hel','\x1b']);
  const box=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!,height=await rowHeight(page);
  const input=await page.context().newCDPSession(page);
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+8,y:box.y+height/2}]});
  await page.waitForTimeout(650);
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await input.detach();
  await expect.poll(()=>page.evaluate(()=>window.ownedHistory.terminal.getSelection())).toMatch(/^HISTORY_\d{4}$/);
});

import {expect,test,type Page} from '@playwright/test';
import {cell,compose,fingerDrag,historyLines,historyView,longPress,mountHistory,rowHeight,settle} from './fixtures/terminalHistory';

type Point={x:number;y:number};
const log=(page:Page)=>page.evaluate(()=>window.edgeLog.slice());
const width=390,height=844;
const left:Point={x:4,y:420},right:Point={x:width-4,y:420},bottom:Point={x:width/2,y:height-4};
const toward={left:{x:220,y:420},right:{x:170,y:420},bottom:{x:width/2,y:height-250}};

async function open(page:Page,preferences?:object,close=false) {
  if(preferences)await page.addInitScript(value=>localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,...value})),preferences);
  await mountHistory(page,false,true,false,{close});
  await page.evaluate(lines=>window.ownedHistory.output(lines),historyLines(300));await settle(page);
}
/** One finger from `from` to `to` in `steps` moves, `pause` ms apart; `rest` holds the finger still first. */
async function swipe(page:Page,from:Point,to:Point,{steps=6,pause=12,rest=0}:{steps?:number;pause?:number;rest?:number}={}) {
  const input=await page.context().newCDPSession(page);
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[from]});
  if(rest)await page.waitForTimeout(rest);
  for(let step=1;step<=steps;step++){
    await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:from.x+(to.x-from.x)*step/steps,y:from.y+(to.y-from.y)*step/steps}]});
    if(pause)await page.waitForTimeout(pause);
  }
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await input.detach();
}
/** The edge swipe that must fire, used to prove a guard has released. */
async function swipeEdge(page:Page,edge:'left'|'right'|'bottom') {
  await swipe(page,{left,right,bottom}[edge],toward[edge]);
}
const commits=(entries:string[])=>entries.filter(entry=>entry.startsWith('commit:'));
const fontSize=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')??'{}').fontSize??14);

test.describe('phone',()=>{
  test.skip(({isMobile})=>!isMobile,'Edge swipes exist only on a touch screen.');
  test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedHistory?.dispose());});

  for(const edge of ['left','right','bottom'] as const)test(`a swipe from the ${edge} edge follows the finger and commits`,async({page})=>{
    await open(page);
    await swipeEdge(page,edge);
    const entries=await log(page);
    expect(entries[0]).toBe(`start:${edge}`);
    expect(entries.at(-1)).toBe(`commit:${edge}`);
    const progress=entries.filter(entry=>entry.startsWith('progress:')).map(entry=>Number(entry.split(':')[2]));
    expect(progress.length).toBeGreaterThan(2);
    expect(progress).toEqual([...progress].sort((a,b)=>a-b));
    // The claimed touch reaches nothing under the finger: no key was pressed on release.
    expect(await page.evaluate(()=>window.ownedHistory.writes)).toEqual([]);
  });

  test('a short slow swipe settles back as a cancel',async({page})=>{
    await open(page);
    await swipe(page,left,{x:60,y:420},{steps:4,pause:90});
    expect((await log(page)).at(-1)).toBe('cancel:left');
  });

  test('a swipe that starts in the interior never becomes an edge swipe',async({page})=>{
    await open(page);
    await swipe(page,{x:120,y:420},{x:2,y:420});
    await swipe(page,{x:120,y:420},{x:width-2,y:420});
    await swipe(page,{x:200,y:height-120},{x:200,y:height-2},{steps:8});
    expect(await log(page)).toEqual([]);
  });

  test('closing swipes work from anywhere except the zone that opens the other way',async({page})=>{
    await open(page,undefined,true);
    await swipe(page,{x:100,y:420},{x:330,y:420});
    expect((await log(page)).at(-1)).toBe('closed');
    await page.evaluate(()=>{window.edgeLog.length=0;});
    await swipe(page,left,{x:330,y:420});
    expect(await log(page)).not.toContain('closed');
    expect((await log(page)).at(-1)).toBe('commit:left');
  });

  test.describe('the guard',()=>{
    test('keyboard composing: no swipe, and swipes return once the composition ends',async({page})=>{
      await open(page);
      await compose(page,'hel');
      await swipeEdge(page,'left');
      await swipeEdge(page,'bottom');
      expect(await log(page)).toEqual([]);
      const cdp=await page.context().newCDPSession(page);
      await cdp.send('Input.insertText',{text:'hel'});await cdp.detach();
      await page.waitForTimeout(1000);
      await swipeEdge(page,'left');
      expect(commits(await log(page))).toEqual(['commit:left']);
    });

    test('a key typed a moment ago: no swipe until the typing window ends',async({page})=>{
      await open(page);
      await page.evaluate(()=>window.ownedHistory.terminal.focus());
      await page.keyboard.press('a');
      await swipeEdge(page,'right');
      expect(await log(page)).toEqual([]);
      await page.waitForTimeout(1000);
      await swipeEdge(page,'right');
      expect(commits(await log(page))).toEqual(['commit:right']);
    });

    test('focus in a text field: no swipe',async({page})=>{
      await open(page);
      await page.getByLabel('Synthetic text field').focus();
      await swipeEdge(page,'left');
      expect(await log(page)).toEqual([]);
      await page.getByLabel('Synthetic text field').blur();
      await page.waitForTimeout(900);
      await swipeEdge(page,'left');
      expect(commits(await log(page))).toEqual(['commit:left']);
    });

    test('a terminal selection and a selection-handle drag: no swipe, and the selection still works',async({page})=>{
      await open(page);
      await longPress(page,await cell(page,3,4));
      await expect.poll(()=>page.evaluate(()=>window.ownedHistory.terminal.getSelection())).toMatch(/^HISTORY_\d{4}$/);
      await swipeEdge(page,'left');
      await swipeEdge(page,'bottom');
      // Dragging an end handle to the screen edge is selection work, not an edge swipe.
      const box=(await page.locator('[data-selection-handle="end"]').boundingBox())!;
      await swipe(page,{x:box.x+box.width/2,y:box.y+box.height/2},{x:2,y:box.y+box.height/2});
      expect(await log(page)).toEqual([]);
      await page.evaluate(()=>window.ownedHistory.terminal.clearSelection());
      await page.waitForTimeout(600);
      await swipeEdge(page,'left');
      expect(commits(await log(page))).toEqual(['commit:left']);
    });

    test('a long press that then drags (cursor move) is not an edge swipe',async({page})=>{
      await open(page);
      await swipe(page,left,toward.left,{rest:650});
      await swipe(page,bottom,toward.bottom,{rest:650});
      expect(await log(page)).toEqual([]);
    });

    test('a pinch, even with a finger in an edge zone: no swipe, and the pinch still resizes text',async({page})=>{
      await open(page);
      const before=await fontSize(page),input=await page.context().newCDPSession(page);
      await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:4,y:420},{x:200,y:420}]});
      for(let step=1;step<=8;step++)await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:4,y:420-step*6},{x:200+step*18,y:420+step*6}]});
      await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await input.detach();
      expect(await log(page)).toEqual([]);
      await expect.poll(()=>fontSize(page)).toBeGreaterThan(before);
      await page.waitForTimeout(400);
      await swipeEdge(page,'left');
      expect(commits(await log(page))).toEqual(['commit:left']);
    });

    test('a terminal finger scroll and its momentum: no swipe until it settles, and the scroll still works',async({page})=>{
      await open(page);
      const box=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!;
      await fingerDrag(page,{x:box.x+box.width/2,y:box.y+box.height/4},await rowHeight(page),6);
      expect((await historyView(page)).baseY-(await historyView(page)).viewportY).toBe(6);
      await swipeEdge(page,'left');
      expect(await log(page)).toEqual([]);
      await page.waitForTimeout(800);
      await swipeEdge(page,'left');
      expect(commits(await log(page))).toEqual(['commit:left']);
    });
  });

  test('a vertical drag that starts in the edge zone still scrolls the terminal',async({page})=>{
    await open(page);
    const box=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!,rows=await rowHeight(page);
    await fingerDrag(page,{x:3,y:box.y+box.height/4},rows,5);
    expect((await historyView(page)).baseY-(await historyView(page)).viewportY).toBe(5);
    expect(await log(page)).toEqual([]);
  });

  test('a mouse-tracking program keeps receiving interior touches, and an edge swipe is not sent to it',async({page})=>{
    await open(page);
    await page.evaluate(()=>window.ownedHistory.raw('\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h\x1b[H\x1b[2JAGENT'));await settle(page);
    const box=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!,rows=await rowHeight(page);
    await fingerDrag(page,{x:box.x+box.width/2,y:box.y+box.height/4},rows,5);
    expect(await page.evaluate(()=>window.ownedHistory.writes.filter(data=>/^\x1b\[<6[45];\d+;\d+M$/.test(data)).length)).toBeGreaterThan(0);
    expect(await log(page)).toEqual([]);
    await page.evaluate(()=>{window.ownedHistory.writes.length=0;});
    await page.waitForTimeout(600);
    await swipeEdge(page,'left');
    expect(commits(await log(page))).toEqual(['commit:left']);
    expect(await page.evaluate(()=>window.ownedHistory.writes)).toEqual([]);
  });

  test('a swipe binding keeps working in the interior and does not also fire for a claimed edge swipe',async({page})=>{
    await open(page,{bodyGestures:{swipeRight:'escape'}});
    await swipe(page,{x:100,y:420},{x:250,y:420});
    await expect.poll(()=>page.evaluate(()=>window.ownedHistory.writes)).toEqual(['\x1b']);
    await page.evaluate(()=>{window.ownedHistory.writes.length=0;window.edgeLog.length=0;});
    await page.waitForTimeout(500);
    await swipeEdge(page,'left');
    expect((await log(page)).at(-1)).toBe('commit:left');
    await page.waitForTimeout(300);
    expect(await page.evaluate(()=>window.ownedHistory.writes)).toEqual([]);
  });

  test('a long press still selects a word with the engine mounted',async({page})=>{
    await open(page);
    await longPress(page,await cell(page,3,4));
    await expect.poll(()=>page.evaluate(()=>window.ownedHistory.terminal.getSelection())).toMatch(/^HISTORY_\d{4}$/);
    expect(await log(page)).toEqual([]);
  });

  test('an edge swipe switched off in Preferences does nothing, the others still work',async({page})=>{
    await open(page,{edgeGestures:{leftMenu:false}});
    await swipeEdge(page,'left');
    expect(await log(page)).toEqual([]);
    await page.waitForTimeout(500);
    await swipeEdge(page,'right');
    expect(commits(await log(page))).toEqual(['commit:right']);
  });

  test('the zone width follows the preference',async({page})=>{
    await open(page,{edgeGestures:{zoneWidth:48}});
    await swipe(page,{x:40,y:420},{x:220,y:420});
    expect((await log(page)).at(-1)).toBe('commit:left');
  });

  test('screen-reader mode turns the swipes off',async({page})=>{
    await open(page,{screenReader:true});
    await swipeEdge(page,'left');
    await swipeEdge(page,'right');
    expect(await log(page)).toEqual([]);
  });

  test('reduced motion reports no intermediate progress',async({page})=>{
    await page.emulateMedia({reducedMotion:'reduce'});
    await open(page);
    await swipeEdge(page,'left');
    expect((await log(page)).filter(entry=>entry.startsWith('progress:'))).toEqual(['progress:left:1.00']);
    expect((await log(page)).at(-1)).toBe('commit:left');
  });
});

test('a mouse drag from the edge is not an edge swipe on a desktop pointer',async({page,isMobile})=>{
  test.skip(isMobile,'The desktop project has no touch screen.');
  await open(page);
  await page.mouse.move(4,420);await page.mouse.down();await page.mouse.move(220,420,{steps:8});await page.mouse.up();
  expect(await log(page)).toEqual([]);
  await page.evaluate(()=>window.ownedHistory.dispose());
});

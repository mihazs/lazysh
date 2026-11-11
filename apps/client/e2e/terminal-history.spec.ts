import {expect,test,type Page} from '@playwright/test';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';
import {historyLines,historyView,mountHistory,rowHeight,scrollHistory,settle} from './fixtures/terminalHistory';
import {pressMore} from './fixtures/toolbarMore';

const output=(page:Page,lines:string[])=>page.evaluate(lines=>window.ownedHistory.output(lines),lines);
const id=(text:string)=>Number(/HISTORY_(\d{4})/.exec(text)?.[1]);
test.afterEach(async({page})=>{await page.evaluate(()=>window.ownedHistory?.dispose());});

for(const mosh of [false,true])test.describe(mosh?'Mosh terminal':'SSH terminal',()=>{
  test('new output never pulls a reader out of history, while the bottom keeps following',async({page},testInfo)=>{
    await mountHistory(page,mosh);
    await output(page,historyLines(300));await settle(page);
    const following=await historyView(page);
    expect(following.viewportY).toBe(following.baseY);
    await scrollHistory(page,testInfo.project.name==='phone',20);
    const reading=await historyView(page);
    expect(reading.baseY-reading.viewportY).toBeGreaterThanOrEqual(18);
    for(let chunk=0;chunk<3;chunk++){await output(page,historyLines(40,1000+chunk*40));await settle(page);}
    const after=await historyView(page);
    expect(after.baseY).toBe(reading.baseY+120);
    expect({viewportY:after.viewportY,top:after.top,rendered:after.rendered}).toEqual({viewportY:reading.viewportY,top:reading.top,rendered:reading.top});
    // Returning to the bottom resumes following.
    await page.evaluate(()=>window.ownedHistory.terminal.scrollToBottom());
    await output(page,['FOLLOWED_AGAIN']);await settle(page);
    const resumed=await historyView(page);
    expect(resumed.viewportY).toBe(resumed.baseY);
    await expect(page.locator('.terminal-canvas .xterm-rows')).toContainText('FOLLOWED_AGAIN');
  });

  test('a scroll that starts while output streams moves history by its own rows',async({page},testInfo)=>{
    await mountHistory(page,mosh);
    await output(page,historyLines(300));await settle(page);
    const start=id((await historyView(page)).top);
    let next=2000;
    // Two remote lines are queued right behind every move; a finger moves less than a row at a time.
    await scrollHistory(page,testInfo.project.name==='phone',12,()=>page.evaluate(lines=>{void window.ownedHistory.output(lines);},[`STREAM_${next++}`,`STREAM_${next++}`]),.75);
    const reading=await historyView(page);
    await testInfo.attach('streamed-scroll',{body:JSON.stringify({start,reading}),contentType:'application/json'});
    expect(reading.top).toMatch(/^HISTORY_/);
    expect(Math.abs(id(reading.top)-(start-12))).toBeLessThanOrEqual(2);
    await output(page,historyLines(30,3000));await settle(page);
    expect((await historyView(page)).top).toBe(reading.top);
  });

  // A phone scrolls by finger, or by wheel from a mouse or trackpad.
  for(const input of ['wheel','finger'] as const)test(`a ${input} scroll in the same frame as new output reaches history and stays there`,async({page},testInfo)=>{
    test.skip(input==='finger'&&testInfo.project.name!=='phone','Finger drags need a touch screen.');
    await mountHistory(page,mosh);
    await output(page,historyLines(300));await settle(page);
    const height=await rowHeight(page);
    // xterm 5.5 follows output by moving the viewport and ignoring the next scroll event; the reader
    // moves once the redrawn rows land, before that event is dispatched, as a finger or wheel can.
    const moved=await page.evaluate(({finger,height,rows})=>new Promise<number>(resolve=>{
      const t=window.ownedHistory.terminal,screen=document.querySelector<HTMLElement>('.terminal-canvas .xterm-screen')!;
      const observer=new MutationObserver(()=>{
        observer.disconnect();
        const box=screen.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/4;
        if(finger){
          const touch=(clientY:number)=>[new Touch({identifier:1,target:screen,clientX:x,clientY})];
          const send=(type:string,touches:Touch[],changed=touches)=>screen.dispatchEvent(new TouchEvent(type,{bubbles:true,cancelable:true,touches,targetTouches:touches,changedTouches:changed}));
          send('touchstart',touch(y));send('touchmove',touch(y+rows*height));send('touchend',[],touch(y+rows*height));
        } else screen.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,clientX:x,clientY:y,deltaY:-rows*height,deltaMode:WheelEvent.DOM_DELTA_PIXEL}));
        resolve(t.buffer.active.baseY);
      });
      observer.observe(document.querySelector('.terminal-canvas .xterm-rows')!,{childList:true,subtree:true,characterData:true});
      void window.ownedHistory.output(['SAME_FRAME']);
    }),{finger:input==='finger',height,rows:10});
    await settle(page);
    const reading=await historyView(page);
    await testInfo.attach(`same-frame-${input}`,{body:JSON.stringify({moved,reading}),contentType:'application/json'});
    expect(reading.baseY-reading.viewportY).toBe(10);
    expect(reading.top).toMatch(/^HISTORY_/);
    // The rendered rows are the history the buffer reports, not the live screen.
    expect(reading.rendered).toBe(reading.top);
    await expect(page.locator('.terminal-canvas .xterm-rows')).not.toContainText('SAME_FRAME');
    // Further output keeps the reader anchored in history.
    for(let chunk=0;chunk<3;chunk++){await output(page,historyLines(20,5000+chunk*20));await settle(page);}
    const after=await historyView(page);
    expect({viewportY:after.viewportY,top:after.top,rendered:after.rendered}).toEqual({viewportY:reading.viewportY,top:reading.top,rendered:reading.top});
  });

  test('resizing while in history keeps the reader on the same line',async({page},testInfo)=>{
    await mountHistory(page,mosh);
    await output(page,historyLines(300,0,true));await settle(page);
    await scrollHistory(page,testInfo.project.name==='phone',25);
    let before=await historyView(page);
    // Start from a whole logical line so every resize has one exact expectation.
    while(before.wrapped){await page.evaluate(()=>window.ownedHistory.terminal.scrollLines(-1));await settle(page);before=await historyView(page);}
    expect(before.wrapped).toBe(false);
    const size=page.viewportSize()!;
    const sizes=[{width:size.width,height:size.height-300},size,{width:size.width-120,height:size.height},size,{width:size.width-120,height:size.height-300},size];
    for(const [step,next] of sizes.entries()) {
      const geometry=await historyView(page);
      await page.setViewportSize(next);
      await expect.poll(async()=>{const view=await historyView(page);return view.rows!==geometry.rows||view.cols!==geometry.cols;}).toBe(true);
      // Output arriving right after the resize must not move the reader either.
      await output(page,historyLines(5,4000+step*5));await settle(page);
      const view=await historyView(page);
      await testInfo.attach(`resize-${step}`,{body:JSON.stringify({next,before,view}),contentType:'application/json'});
      expect({wrapped:view.wrapped,logical:view.logical}).toEqual({wrapped:false,logical:before.logical});
      expect(view.rendered.startsWith(before.logical)).toBe(true);
    }
    expect(await page.evaluate(()=>window.ownedHistory.errors)).toEqual([]);
  });

  test('a keyboard-sized grow keeps a near-bottom reader in place and a following reader following',async({page},testInfo)=>{
    await mountHistory(page,mosh);
    await output(page,historyLines(300));await settle(page);
    const size=page.viewportSize()!,keyboard={width:size.width,height:size.height-300};
    const resize=async(next:{width:number;height:number})=>{
      const rows=(await historyView(page)).rows;await page.setViewportSize(next);
      await expect.poll(async()=>(await historyView(page)).rows).not.toBe(rows);await settle(page);
    };
    await resize(keyboard);
    await scrollHistory(page,testInfo.project.name==='phone',5);
    const reading=await historyView(page);
    expect(reading.baseY-reading.viewportY).toBe(5);
    await resize(size);
    const grown=await historyView(page);
    await testInfo.attach('near-bottom-grow',{body:JSON.stringify({reading,grown}),contentType:'application/json'});
    // Mosh keeps its canonical top rows; a stock grow can only reveal more below the reader.
    if(mosh)expect({viewportY:grown.viewportY,top:grown.top}).toEqual({viewportY:reading.viewportY,top:reading.top});
    else expect(grown.viewportY).toBe(grown.baseY);
    expect(await page.locator('.terminal-canvas .xterm-rows').innerText()).toContain(reading.top);
    await page.evaluate(()=>window.ownedHistory.terminal.scrollToBottom());
    for(const next of [keyboard,size]) {
      await resize(next);
      await output(page,[`FOLLOWED_${next.height}`]);await settle(page);
      const view=await historyView(page);
      expect(view.viewportY).toBe(view.baseY);
      await expect(page.locator('.terminal-canvas .xterm-rows')).toContainText(`FOLLOWED_${next.height}`);
    }
  });
});

test('History lines bounds local scrollback, applies live and Find reports trimmed lines as gone',async({page})=>{
  await mountHistory(page,false);
  // Find stays open: opening it later would shrink the rows and trim more history.
  const toolbar=page.getByRole('button',{name:'Show keys',exact:true});
  if(await toolbar.isVisible())await toolbar.click();
  await pressMore(page,'Find');
  const search=page.locator('.terminal-search input'),status=page.locator('.terminal-search [role="status"]');
  await expect(search).toBeVisible();await settle(page);
  const rows=(await historyView(page)).rows;
  await output(page,historyLines(400));await settle(page);
  expect((await historyView(page)).length).toBe(401);
  await page.evaluate(()=>window.ownedHistory.hide(true));
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Terminal');
  await page.getByLabel('History lines',{exact:true}).fill('100');
  await closePreferences(page);
  await page.evaluate(()=>window.ownedHistory.hide(false));
  const oldest=()=>page.evaluate(()=>window.ownedHistory.terminal.buffer.active.getLine(0)!.translateToString(true));
  await expect.poll(async()=>(await historyView(page)).length).toBe(100+rows);
  expect(await oldest()).toBe(`HISTORY_${String(300-rows).padStart(4,'0')}`);
  // Writing past the bound keeps trimming the oldest lines.
  await output(page,historyLines(50,400));await settle(page);
  expect((await historyView(page)).length).toBe(100+rows);
  const retained=await oldest();
  expect(retained).toBe(`HISTORY_${String(350-rows).padStart(4,'0')}`);
  await search.fill('HISTORY_0000');await search.press('Enter');
  await expect(status).toHaveText('No match in retained history.');
  await search.fill(retained);await search.press('Enter');
  await expect(status).toHaveText('Match on line 1');
});

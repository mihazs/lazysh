import {expect,test,type Locator,type Page,type TestInfo} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';

declare global {interface Window {toolbarWrites:string[]}}
type Point={x:number;y:number};

/** A local terminal whose only observable output is the bytes each toolbar key writes. */
async function openApp(page:Page,toolbar:string[]) {
  await installNativeBridge(page);
  await page.addInitScript(toolbar=>{
    window.toolbarWrites=[];
    if(!sessionStorage.getItem('toolbar-seeded')){sessionStorage.setItem('toolbar-seeded','1');localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar}));}
    window.nativeFixtureInvoke=async(command,args)=>{
      switch(command){
        case 'list_hosts':return [];
        case 'app_icon_status':return {available:false,current:'unknown',reason:'Toolbar layout fixture.'};
        case 'local_capability':return {available:true,reason:'Toolbar layout fixture; no shell runs.'};
        case 'local_connect':return {sessionId:'local:toolbar-layout'};
        case 'local_write':{const steps=args.steps as string[]|undefined;window.toolbarWrites.push(steps?steps.join(''):args.data as string);return;}
        case 'local_resize':case 'local_ack':case 'local_disconnect':return;
      }
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected toolbar fixture command: ${command}`);
    };
  },toolbar);
  await page.goto('/');
}
async function openToolbarSettings(page:Page) {
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Toolbar keys and order',{exact:true}).click();
}
/** Accessible names of a row's keys: icon and arrow keys have no text of their own. */
const names=(row:Locator)=>row.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')??button.textContent));
const stored=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).toolbar as string[]);
const center=async(target:Locator):Promise<Point>=>{const box=(await target.boundingBox())!;return {x:box.x+box.width/2,y:box.y+box.height/2};};
const leftEdge=async(target:Locator):Promise<Point>=>{const box=(await target.boundingBox())!;return {x:box.x+4,y:box.y+box.height/2};};

/** A real pointer drag: mouse movement on desktop, or a held finger on the phone. */
async function startDrag(page:Page,testInfo:TestInfo,source:Locator) {
  await source.scrollIntoViewIfNeeded();
  let at=await center(source);
  const phone=testInfo.project.name==='phone';
  const cdp=phone?await page.context().newCDPSession(page):undefined;
  if(cdp){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[at]});
    await page.waitForTimeout(450);
  }else{await page.mouse.move(at.x,at.y);await page.mouse.down();}
  // A short nudge starts the drag, as a hand does before travelling.
  at={x:at.x+8,y:at.y};
  if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[at]});else await page.mouse.move(at.x,at.y);
  const move=async(to:Point)=>{
    for(let step=1;step<=8;step++){
      const point={x:at.x+(to.x-at.x)*step/8,y:at.y+(to.y-at.y)*step/8};
      if(cdp)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});
      else await page.mouse.move(point.x,point.y);
    }
    at=to;
  };
  const end=async()=>{if(cdp){await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}else await page.mouse.up();};
  return {move,end};
}
async function drag(page:Page,testInfo:TestInfo,source:Locator,target:()=>Promise<Point>) {
  const gesture=await startDrag(page,testInfo,source);
  // Rows below a hovered row grow to show the drop slot, so aim again once the layout settles.
  await gesture.move(await target());
  await gesture.move(await target());
  await gesture.end();
}

test('pointer drags reorder, move between rows, add and remove toolbar keys, and the terminal sends their bytes',async({page},testInfo)=>{
  await openApp(page,['esc','ctrl','tab','left','c']);
  await openToolbarSettings(page);
  const editor=page.locator('.toolbar-editor');
  const row=(index:number)=>editor.getByRole('group',{name:`Row ${index}`,exact:true});
  const chip=(name:string)=>editor.getByRole('button',{name,exact:true});
  await page.screenshot({path:testInfo.outputPath('toolbar-editor-one-row.png')});
  await editor.getByRole('combobox',{name:'Toolbar rows',exact:true}).selectOption('2');
  await expect(row(2)).toContainText('Drag keys here');
  // Keep both rows clear of the page edge, where a drag would start scrolling the page under the finger.
  await row(2).evaluate(node=>node.scrollIntoView({block:'center'}));

  const tab=await startDrag(page,testInfo,chip('tab'));
  await tab.move(await center(row(2)));
  // The preview shows the result before the key is dropped.
  await expect(editor.locator('.toolbar-preview-row').nth(1).locator('[data-preview-key]')).toHaveText(['tab']);
  expect(await stored(page)).toEqual(['esc','ctrl','tab','left','c','row-break']);
  await tab.end();
  expect(await stored(page)).toEqual(['esc','ctrl','left','c','row-break','tab']);

  await drag(page,testInfo,chip('ctrl'),()=>leftEdge(row(2).locator('[data-chip-key="tab"]')));
  await drag(page,testInfo,chip('left'),()=>leftEdge(row(1).locator('[data-chip-key="esc"]')));
  await drag(page,testInfo,editor.getByRole('button',{name:'Add enter',exact:true}),async()=>{const box=(await row(2).boundingBox())!;return {x:box.x+box.width-12,y:box.y+box.height/2};});
  expect(await stored(page)).toEqual(['left','esc','c','row-break','ctrl','tab','enter']);
  await expect(page.getByRole('status').filter({hasText:'enter added to row 2, position 3'})).toBeAttached();

  const remove=await startDrag(page,testInfo,chip('esc'));
  const zone=page.locator('.toolbar-remove-zone');
  await expect(zone).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('toolbar-editor-dragging.png')});
  await remove.move(await center(zone));
  await expect(zone).toHaveAttribute('data-target','true');
  await remove.end();
  await expect(zone).toHaveCount(0);
  await drag(page,testInfo,chip('c'),()=>center(editor.getByRole('heading',{name:'Available keys',exact:true})));
  expect(await stored(page)).toEqual(['left','row-break','ctrl','tab','enter']);
  for(const name of ['Add esc','Add c'])await expect(editor.getByRole('button',{name,exact:true})).toBeVisible();
  // A drop away from every row and palette cancels without changing the toolbar.
  await drag(page,testInfo,chip('tab'),async()=>({x:5,y:(await editor.getByRole('combobox',{name:'Toolbar rows',exact:true}).boundingBox())!.y}));
  expect(await stored(page)).toEqual(['left','row-break','ctrl','tab','enter']);
  await expect(page.getByRole('dialog',{name:'Preferences',exact:true})).toBeVisible();
  if(testInfo.project.name==='desktop'){
    // Escape abandons a drag without leaving the settings page.
    const held=await startDrag(page,testInfo,chip('tab'));
    await held.move(await center(row(1)));
    await page.keyboard.press('Escape');
    await expect(page.locator('.toolbar-drag-ghost')).toHaveCount(0);
    await held.end();
    expect(await stored(page)).toEqual(['left','row-break','ctrl','tab','enter']);
    await expect(editor).toBeVisible();
  }
  await page.screenshot({path:testInfo.outputPath('toolbar-editor-two-rows.png')});

  await page.reload();
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const keys=page.getByLabel('Terminal keys',{exact:true});
  const rows=keys.locator('.terminal-keys-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('button')).toHaveText(['←']);
  expect(await names(rows.nth(1))).toEqual(['ctrl','tab','enter']);
  const [first,second]=[(await rows.nth(0).boundingBox())!,(await rows.nth(1).boundingBox())!];
  expect(second.y).toBeGreaterThanOrEqual(first.y+first.height);
  // Compact keys: tall enough for a finger and never narrower than the grid's minimum column.
  for(const button of await rows.getByRole('button').all()){const box=(await button.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(32);expect(box.width).toBeGreaterThanOrEqual(28);}
  const press=async(target:Locator)=>{if(testInfo.project.name==='phone')await target.tap();else await target.click();};
  for(const name of ['Arrow left','tab','enter'])await press(keys.getByRole('button',{name,exact:true}));
  await expect.poll(()=>page.evaluate(()=>window.toolbarWrites)).toEqual(['\x1b[D','\t','\r']);
  // The modifier in the second row keeps its one-shot, locked and released states.
  const ctrl=keys.getByRole('button',{name:/^ctrl(?: · lock)?$/});
  await press(ctrl);await expect(ctrl).toHaveAttribute('aria-pressed','true');
  await press(ctrl);await expect(ctrl).toHaveAccessibleName('ctrl · lock');await expect(ctrl.locator('.terminal-key-lock')).toBeVisible();
  await press(ctrl);await expect(ctrl).toHaveAttribute('aria-pressed','false');
  await page.screenshot({path:testInfo.outputPath('terminal-two-rows.png')});
  if(testInfo.project.name==='phone'){
    // A keyboard-sized viewport keeps every row on screen above the docked keyboard.
    await page.setViewportSize({width:390,height:420});
    for(const index of [0,1])await expect(rows.nth(index)).toBeInViewport();
    expect((await keys.boundingBox())!.y+(await keys.boundingBox())!.height).toBeLessThanOrEqual(420);
    await expect(page.locator('.terminal-canvas:visible')).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('terminal-two-rows-keyboard.png')});
  }
  expect(await page.evaluate(()=>window.toolbarWrites)).toEqual(['\x1b[D','\t','\r']);
});

test('three stored rows render as three terminal lines and an older flat toolbar stays one line',async({page},testInfo)=>{
  await openApp(page,['esc','row-break','tab','row-break','left','right']);
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const rows=page.getByLabel('Terminal keys',{exact:true}).locator('.terminal-keys-row');
  await expect(rows).toHaveCount(3);
  expect(await names(rows.nth(2))).toEqual(['Arrow left','Arrow right']);
  await page.screenshot({path:testInfo.outputPath('terminal-three-rows.png')});
  await page.evaluate(()=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar:['esc','tab','left']}));window.dispatchEvent(new StorageEvent('storage',{key:'lazysh.preferences.v1'}));});
  await expect(rows).toHaveCount(1);
  expect(await names(rows.first())).toEqual(['esc','tab','Arrow left']);
});

test('a quick touch swipe over the keys scrolls the settings page instead of dragging',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch-only scrolling contract.');
  await openApp(page,['esc','ctrl','tab']);
  await openToolbarSettings(page);
  const content=page.getByRole('dialog',{name:'Preferences',exact:true}).locator('.dialog-content');
  const start=await center(page.getByRole('button',{name:'Add enter',exact:true}));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
  for(let step=1;step<=10;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:start.y-step*25}]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(()=>content.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('.toolbar-drag-ghost')).toHaveCount(0);
  expect(await stored(page)).toEqual(['esc','ctrl','tab']);
});

test('adding keys from the palette keeps the full-page Preferences close control on screen and tappable',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Only the phone page presentation pins the heading above its own scrolling body.');
  await openApp(page,['esc','ctrl','tab','left','right','up','down']);
  await openToolbarSettings(page);
  const dialog=page.getByRole('dialog',{name:'Preferences',exact:true});
  // Each add moves focus to the next palette key, which sits below the first screen of the page.
  for(const key of ['Shift','enter'])await dialog.getByRole('button',{name:`Add ${key}`,exact:true}).click();
  expect(await stored(page)).toEqual(['esc','ctrl','tab','left','right','up','down','shift','enter']);
  const close=dialog.getByRole('button',{name:'Close Preferences',exact:true});
  const box=(await close.boundingBox())!;
  const viewport=page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x+box.width).toBeLessThanOrEqual(viewport.width);
  // A finger at the control's on-screen centre reaches it without any page scrolling first.
  const hit=await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.closest('button')?.getAttribute('aria-label')??null,{x:box.x+box.width/2,y:box.y+box.height/2});
  expect(hit).toBe('Close Preferences');
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await expect(dialog).toHaveCount(0);
});

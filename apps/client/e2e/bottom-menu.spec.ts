import {expect,test,type Page} from '@playwright/test';
import {connectLocalTerminal,installLocalTerminal} from './fixtures/localTerminal';

const key='lazysh.preferences.v1';
const lastSize=(page:Page)=>page.evaluate(()=>window.simpleShortcutResizes.at(-1)!);
const resizes=(page:Page)=>page.evaluate(()=>window.simpleShortcutResizes.length);
const settle=async(page:Page)=>{await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await page.waitForTimeout(350);};
const stored=(page:Page)=>page.evaluate(name=>JSON.parse(localStorage.getItem(name)??'{}') as {toolbarHidden?:boolean},key);

/** A connected local terminal. The first load seeds the given preferences; a reload keeps whatever the page saved since. */
async function open(page:Page,preferences:object={}) {
  await installLocalTerminal(page);
  await page.addInitScript(([name,seed])=>{if(!localStorage.getItem(name as string))localStorage.setItem(name as string,JSON.stringify({version:1,...seed as object}));},[key,preferences]);
  await page.goto('/');
  await connect(page);
}
async function connect(page:Page) {
  await connectLocalTerminal(page);
  await expect.poll(()=>resizes(page)).toBeGreaterThan(0);
  await settle(page);
}

/** A one-finger drag from (x, from) towards (x, to) in even steps: real touch input, paused after each step so the page can react. */
async function drag(page:Page,from:number,to:number,{x=195,steps=8,pause=20,between}:{x?:number;steps?:number;pause?:number;between?:(step:number)=>Promise<void>}={}) {
  const cdp=await page.context().newCDPSession(page);
  const send=(type:'touchStart'|'touchMove'|'touchEnd',y?:number)=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:y===undefined?[]:[{x,y}]});
  await send('touchStart',from);
  for(let step=1;step<=steps;step++){await send('touchMove',from+(to-from)*step/steps);await page.waitForTimeout(pause);await between?.(step);}
  await send('touchEnd');
  await cdp.detach();
}
const height=(page:Page)=>page.evaluate(()=>window.innerHeight);
/** The sheet's top edge, or Infinity while it is hidden below the screen. */
const sheetTop=(page:Page)=>page.evaluate(()=>{const sheet=document.querySelector('.bottom-menu');return !sheet||getComputedStyle(sheet).visibility==='hidden'?Infinity:sheet.getBoundingClientRect().top;});
const menu=(page:Page)=>page.getByRole('group',{name:'Bottom menu'});
const opener=(page:Page)=>page.getByRole('button',{name:'Open bottom menu',exact:true});
const swipeUp=async(page:Page)=>{const bottom=await height(page);await drag(page,bottom-8,bottom-300);};
async function openByTouch(page:Page) {await swipeUp(page);await expect(menu(page)).toBeVisible();await settle(page);}
const closed=async(page:Page)=>{await expect(menu(page)).toBeHidden();expect(await sheetTop(page)).toBe(Infinity);};

test.describe('on a phone',()=>{
  test.skip(({isMobile})=>!isMobile,'The bottom menu is for phone windows.');
  test.use({viewport:{width:415,height:900}});

  test('swiping up from the bottom edge drags the menu open under the finger, swiping down hides it',async({page},testInfo)=>{
    await open(page);
    await expect(menu(page)).toBeHidden();
    await page.screenshot({path:testInfo.outputPath('menu-closed.png')});
    const bottom=await height(page),tops:number[]=[];
    // Past 10 px of movement the panel starts to follow: its top edge rises with the finger and is never ahead of it.
    await drag(page,bottom-8,bottom-100,{pause:45,between:async()=>{tops.push(await sheetTop(page));}});
    await settle(page);
    const visible=tops.filter(top=>top!==Infinity);
    expect(visible.length).toBeGreaterThan(2);
    expect(visible).toEqual([...visible].sort((a,b)=>b-a));
    expect(visible.at(-1)!).toBeLessThan(bottom);
    // 100 px is short of the commit point: the panel slides back down.
    await closed(page);

    await openByTouch(page);
    await page.screenshot({path:testInfo.outputPath('menu-open.png')});
    const box=(await menu(page).boundingBox())!;
    expect(box.y+box.height).toBeCloseTo(bottom,0);
    // The opposite swipe, starting on the panel, hides it.
    await drag(page,box.y+20,box.y+260);
    await closed(page);
  });

  test('a short drag does nothing, a swipe in the middle of the screen does nothing, and Escape closes the menu',async({page})=>{
    await open(page);
    const bottom=await height(page);
    await drag(page,bottom-8,bottom-50,{pause:45});
    await settle(page);
    await closed(page);
    await drag(page,bottom/2,bottom/2-250);
    await settle(page);
    await closed(page);
    await openByTouch(page);
    await page.keyboard.press('Escape');
    await closed(page);
  });

  test('the toolbar button hands its rows back to the terminal and the choice survives a reload',async({page},testInfo)=>{
    await open(page);
    const keys=page.locator('.terminal-keys');
    await expect(keys).toBeVisible();
    const withKeys={size:await lastSize(page),height:(await keys.boundingBox())!.height};
    await openByTouch(page);
    await menu(page).getByRole('button',{name:'Hide toolbar'}).tap();
    await expect(keys).toHaveCount(0);
    await closed(page);
    await settle(page);
    const without=await lastSize(page);
    expect(without.cols).toBe(withKeys.size.cols);
    // Every pixel of the key rows becomes terminal rows, to within a row.
    const rowHeight=(await page.locator('.terminal-canvas .xterm-screen').boundingBox())!.height/without.rows;
    expect(without.rows-withKeys.size.rows).toBeGreaterThanOrEqual(Math.floor(withKeys.height/rowHeight)-1);
    expect((await stored(page)).toolbarHidden).toBe(true);
    await page.screenshot({path:testInfo.outputPath('toolbar-hidden.png')});
    testInfo.annotations.push({type:'rows',description:`toolbar shown ${withKeys.size.rows} rows (${Math.round(withKeys.height)}px of keys), hidden ${without.rows} rows`});

    await page.reload();
    await connect(page);
    await expect(keys).toHaveCount(0);
    expect((await lastSize(page)).rows).toBe(without.rows);

    await openByTouch(page);
    await menu(page).getByRole('button',{name:'Show toolbar'}).tap();
    await expect(keys).toBeVisible();
    await settle(page);
    expect((await lastSize(page)).rows).toBe(withKeys.size.rows);
    expect((await stored(page)).toolbarHidden).toBe(false);
  });

  test('the terminal keeps its size while the menu opens and closes',async({page})=>{
    await open(page);
    const canvas=page.locator('.terminal-canvas .xterm-screen');
    const before={box:await canvas.boundingBox(),size:await lastSize(page),resizes:await resizes(page)};
    await openByTouch(page);
    expect(await canvas.boundingBox()).toEqual(before.box);
    expect(await resizes(page)).toBe(before.resizes);
    await drag(page,(await menu(page).boundingBox())!.y+20,(await height(page))-10);
    await closed(page);
    await settle(page);
    expect(await canvas.boundingBox()).toEqual(before.box);
    expect(await lastSize(page)).toEqual(before.size);
    expect(await resizes(page)).toBe(before.resizes);
  });

  test('the composer button shows and hides the composer without losing the draft',async({page},testInfo)=>{
    await open(page);
    const composer=page.locator('.terminal-composer-sheet');
    await expect(composer).toHaveCount(0);
    await openByTouch(page);
    await menu(page).getByRole('button',{name:'Show composer'}).tap();
    await expect(composer).toBeVisible();
    await page.screenshot({path:testInfo.outputPath('composer-shown.png')});
    await composer.locator('textarea').fill('draft text');
    // A focused text field and a recent key block the swipe: leave the field, then it works.
    await composer.locator('textarea').blur();
    await page.waitForTimeout(1000);
    await openByTouch(page);
    await menu(page).getByRole('button',{name:'Hide composer'}).tap();
    await expect(composer).toHaveCount(0);
    await openByTouch(page);
    await menu(page).getByRole('button',{name:'Show composer'}).tap();
    await expect(composer.locator('textarea')).toHaveValue('draft text');
  });

  test('a tap outside closes the menu',async({page})=>{
    await open(page);
    await openByTouch(page);
    await page.touchscreen.tap(195,200);
    await closed(page);
  });

  test.describe('while the user types or edits text',()=>{
    /** The swipe is refused, then allowed again once the text interaction is over. */
    async function refused(page:Page,end:()=>Promise<void>) {
      await swipeUp(page);
      await settle(page);
      await closed(page);
      await end();
      await page.waitForTimeout(1000);
      await openByTouch(page);
    }

    test('a key was just typed',async({page})=>{
      await open(page);
      await page.locator('.xterm-helper-textarea').focus();
      await page.keyboard.type('ls');
      await refused(page,async()=>{});
    });

    test('the keyboard is composing a word',async({page})=>{
      await open(page);
      await page.locator('.xterm-helper-textarea').focus();
      const cdp=await page.context().newCDPSession(page);
      await cdp.send('Input.imeSetComposition',{text:'hel',selectionStart:3,selectionEnd:3});
      await refused(page,async()=>{await cdp.send('Input.insertText',{text:'hello'});await cdp.detach();});
    });

    test('a text field has the focus',async({page})=>{
      await open(page);
      await openByTouch(page);
      await menu(page).getByRole('button',{name:'Show composer'}).tap();
      const editor=page.locator('.terminal-composer-sheet textarea');
      await editor.focus();
      await refused(page,async()=>{await editor.blur();});
    });

    test('text is selected',async({page})=>{
      await open(page);
      await page.evaluate(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('.workspace-footer')!);const selection=getSelection()!;selection.removeAllRanges();selection.addRange(range);});
      await refused(page,()=>page.evaluate(()=>getSelection()!.removeAllRanges()));
    });
  });
});

test.describe('with a screen reader or the swipe switched off',()=>{
  test.skip(({isMobile})=>!isMobile,'The bottom menu is for phone windows.');
  test.use({viewport:{width:415,height:900}});

  test('a visible button opens the menu, and the swipe does nothing',async({page},testInfo)=>{
    await open(page,{screenReader:true});
    await expect(opener(page)).toBeVisible();
    await expect(page.locator('.bottom-menu-handle')).toHaveCount(0);
    await page.screenshot({path:testInfo.outputPath('button.png')});
    await swipeUp(page);
    await settle(page);
    await closed(page);
    await opener(page).focus();
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeVisible();
    // Keyboard and screen-reader users land on the first action and return to the button.
    await expect(menu(page).getByRole('button',{name:'Show composer'})).toBeFocused();
    await page.keyboard.press('Escape');
    await closed(page);
    await expect(opener(page)).toBeFocused();
  });

  test('switching the bottom gesture off in Preferences shows the button',async({page})=>{
    await open(page,{edgeGestures:{bottomMenu:false}});
    await expect(opener(page)).toBeVisible();
    await swipeUp(page);
    await settle(page);
    await closed(page);
  });
});

test('a desktop window has no bottom menu',async({page,isMobile})=>{
  test.skip(isMobile,'Desktop only.');
  await open(page);
  await expect(page.locator('.bottom-menu')).toHaveCount(0);
  await expect(opener(page)).toHaveCount(0);
});

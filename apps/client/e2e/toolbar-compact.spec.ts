import {expect,test,type Locator,type Page,type TestInfo} from '@playwright/test';
import {openToolbarTerminal as openToolbar} from './fixtures/localTerminal';

const oldDefault=['esc','ctrl','meta','shift','tab','paste','attach','left','up','down','right','c','d'];

const writes=(page:Page)=>page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'));
/** A key's accessible name: icon and arrow keys have no text of their own. */
const names=(row:Locator)=>row.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')??button.textContent));
const boxes=async(row:Locator)=>Promise.all((await row.getByRole('button').all()).map(async button=>(await button.boundingBox())!));
const press=(page:Page,testInfo:TestInfo,key:Locator)=>testInfo.project.name==='phone'?key.tap():key.click();

test('the default toolbar is two fixed rows of equal keys that show every key of the keys page at once, with the arrows in an inverted T',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const rows=keys.locator('.terminal-keys-row');
  await expect(rows).toHaveCount(2);
  expect(await names(rows.nth(0))).toEqual(['Toggle keyboard','Attach','esc','tab','paste','/','Home','Arrow up','End']);
  expect(await names(rows.nth(1))).toEqual(['Shift','ctrl','Alt','c','d','enter','Arrow left','Arrow down','Arrow right']);
  // The keys page is the first of the pages and nothing on it scrolls: every key is on screen.
  await expect(keys.getByRole('group',{name:'Toolbar pages',exact:true}).locator('[aria-current]')).toHaveAccessibleName('Keys page');
  for(const row of await rows.all()){
    expect(await row.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
    for(const button of await row.getByRole('button').all())await expect(button).toBeInViewport({ratio:1});
  }
  const [first,second]=[await boxes(rows.nth(0)),await boxes(rows.nth(1))];
  // One key width and height everywhere, so the rows line up as a grid.
  const widths=[...first,...second].map(box=>Math.round(box.width));
  expect(Math.max(...widths)-Math.min(...widths)).toBeLessThanOrEqual(1);
  expect(new Set([...first,...second].map(box=>Math.round(box.height))).size).toBe(1);
  expect(first[0].height).toBeLessThanOrEqual(34);
  // Arrow keys form an inverted T: Up sits over Down, Home over Left and End over Right.
  for(const [above,below] of [[6,6],[7,7],[8,8]])expect(Math.abs(first[above].x-second[below].x)).toBeLessThanOrEqual(1);
  // The whole toolbar is a 1px border, two 32px rows, a 3px gap and the padding, page indicator included: the same 74px as before the pages.
  expect((await keys.boundingBox())!.height).toBe(74);
  await page.screenshot({path:testInfo.outputPath('compact-toolbar.png')});
  for(const name of ['esc','Home','End','Arrow up','Arrow down','Arrow left','Arrow right'])await press(page,testInfo,keys.getByRole('button',{name,exact:true}));
  await expect.poll(()=>writes(page)).toEqual(['\x1b','\x1b[H','\x1b[F','\x1b[A','\x1b[B','\x1b[D','\x1b[C']);
});

test('a saved layout keeps every key: the old default moves to the new grid and a wide row scrolls instead of dropping keys',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo,{toolbar:oldDefault});
  // The previous default was never customized, so it becomes the compact default.
  await expect(keys.locator('.terminal-keys-row')).toHaveCount(2);
  await expect(keys.getByRole('button',{name:'Home',exact:true})).toBeVisible();
  const custom=['esc','tab','ctrl','meta','shift','enter','backspace','Home','End','PageUp','PageDown','Insert','Delete','F1','F2','F3','F4','F5','F6'];
  await page.evaluate(toolbar=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar}));window.dispatchEvent(new StorageEvent('storage',{key:'lazysh.preferences.v1'}));},custom);
  const row=keys.locator('.terminal-keys-row');
  await expect(row).toHaveCount(1);
  const all=await names(row);
  expect(all).toEqual(expect.arrayContaining(['esc','tab','ctrl','Alt','Shift','enter','backspace','Home','End','PageUp','PageDown','Insert','Delete','F1','F6']));
  // On a phone the row is wider than the screen, so it scrolls; its last key is reachable either way.
  if(testInfo.project.name==='phone')expect(await row.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
  const last=keys.getByRole('button',{name:'F6',exact:true});
  await last.scrollIntoViewIfNeeded();
  await last.click();
  await expect.poll(()=>writes(page)).toEqual(['\x1b[17~']);
});

test('on a phone the status bar gives its height back to the terminal while the soft keyboard leaves little room',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone status bar.');
  const keys=await openToolbar(page,testInfo);
  const footer=page.locator('.workspace-footer');
  await expect(footer).toBeVisible();
  const full=(await keys.boundingBox())!;
  expect(full.y+full.height).toBeLessThanOrEqual((await footer.boundingBox())!.y+1);
  // A keyboard-sized window: the toolbar sits at the very bottom, with no status bar between it and the keyboard.
  await page.setViewportSize({width:390,height:520});
  await expect(footer).toBeHidden();
  const docked=(await keys.boundingBox())!;
  expect(Math.round(docked.y+docked.height)).toBe(520);
  await page.screenshot({path:testInfo.outputPath('compact-toolbar-keyboard.png')});
});

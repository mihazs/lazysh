import {expect,test,type Locator,type Page,type TestInfo} from '@playwright/test';
import {openToolbarTerminal as openToolbar} from './fixtures/localTerminal';
import {closePreferences,openToolbarSettings} from './fixtures/workspaceControl';

const arrows=['Arrow left','Arrow up','Arrow down','Arrow right'] as const;
const normal={'Arrow up':'\x1b[A','Arrow down':'\x1b[B','Arrow right':'\x1b[C','Arrow left':'\x1b[D',Home:'\x1b[H',End:'\x1b[F'};
const application={'Arrow up':'\x1bOA','Arrow down':'\x1bOB','Arrow right':'\x1bOC','Arrow left':'\x1bOD',Home:'\x1bOH',End:'\x1bOF'};

const writes=(page:Page)=>page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'));
const clearWrites=(page:Page)=>page.evaluate(()=>{window.simpleShortcutWrites=[];});
const press=(testInfo:TestInfo,key:Locator)=>testInfo.project.name==='phone'?key.tap():key.click();
const key=(keys:Locator,name:string)=>keys.getByRole('button',{name,exact:true});
const box=async(target:Locator)=>(await target.boundingBox())!;
const applicationMode=(page:Page,on:boolean)=>page.evaluate(on=>window.simpleShortcutOutput(on?'\x1b[?1h':'\x1b[?1l'),on);
/** Holds a key down for `ms` through a real pointer: a finger on the phone, the mouse button on the desktop. */
async function hold(page:Page,testInfo:TestInfo,target:Locator,ms:number) {
  const rect=await box(target),at={x:rect.x+rect.width/2,y:rect.y+rect.height/2};
  if(testInfo.project.name==='phone'){
    const cdp=await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[at]});
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await cdp.detach();
  }else{
    await page.mouse.move(at.x,at.y);await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  }
}

test('the default toolbar draws the arrows as one classic cluster: Up between Home and End, Left, Down and Right under them, in two rows',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const rows=keys.locator('.terminal-keys-row');
  await expect(rows).toHaveCount(2);
  const [home,up,end,left,down,right]=await Promise.all(['Home','Arrow up','End','Arrow left','Arrow down','Arrow right'].map(name=>box(key(keys,name))));
  // The inverted T: Up centred over Down, Left and Right on either side of Down, one key width each.
  expect(Math.abs(up.x-down.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(home.x-left.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(end.x-right.x)).toBeLessThanOrEqual(1);
  expect(left.x).toBeLessThan(down.x);expect(down.x).toBeLessThan(right.x);
  expect(Math.abs(left.x+left.width+3-down.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(down.x+down.width+3-right.x)).toBeLessThanOrEqual(1);
  expect(up.y).toBeLessThan(down.y);
  expect(Math.abs(left.y-down.y)).toBeLessThanOrEqual(1);expect(Math.abs(down.y-right.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(up.y-home.y)).toBeLessThanOrEqual(1);
  for(const arrow of [up,down,left,right]){expect(Math.round(arrow.width)).toBe(Math.round(up.width));expect(Math.round(arrow.height)).toBe(32);}
  // Both rows of the cluster sit inside the compact toolbar, which is as tall as with separate arrow keys.
  const toolbar=await box(keys);
  expect(toolbar.height).toBe(74);
  for(const arrow of [up,down,left,right]){expect(arrow.y).toBeGreaterThanOrEqual(toolbar.y);expect(arrow.y+arrow.height).toBeLessThanOrEqual(toolbar.y+toolbar.height);}
  // The cluster is not a row of its own and leaves no empty cell behind: every cell of both rows is a key.
  expect(await rows.evaluateAll(nodes=>nodes.map(node=>node.children.length))).toEqual([9,9]);
  await page.screenshot({path:testInfo.outputPath('toolbar-arrows-cluster.png')});
});

test('each arrow sends its own bytes, as cursor keys in normal mode and as application cursor keys after the program asks for them',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  for(const name of arrows)await press(testInfo,key(keys,name));
  await expect.poll(()=>writes(page)).toEqual(arrows.map(name=>normal[name]));
  await clearWrites(page);
  await applicationMode(page,true);
  for(const name of [...arrows,'Home','End'])await press(testInfo,key(keys,name));
  await expect.poll(()=>writes(page)).toEqual([...arrows,'Home','End'].map(name=>application[name as keyof typeof application]));
  // The program leaves application mode: back to the plain sequences.
  await clearWrites(page);
  await applicationMode(page,false);
  await press(testInfo,key(keys,'Arrow up'));
  await expect.poll(()=>writes(page)).toEqual([normal['Arrow up']]);
});

test('Shift, Ctrl and Alt latch for the next arrow and then release, and a locked modifier stays for every arrow, in both cursor modes',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const ctrl=keys.getByRole('button',{name:/^ctrl(?: · lock)?$/}),alt=key(keys,'Alt'),shift=key(keys,'Shift');
  for(const application of [false,true]){
    await clearWrites(page);
    await applicationMode(page,application);
    // One-shot modifiers: pressed, applied to the next arrow only, then released. Modified arrows use the CSI form in either mode.
    await press(testInfo,shift);await expect(shift).toHaveAttribute('aria-pressed','true');
    await press(testInfo,key(keys,'Arrow up'));
    await expect(shift).toHaveAttribute('aria-pressed','false');
    await press(testInfo,ctrl);await press(testInfo,key(keys,'Arrow left'));
    await press(testInfo,alt);await press(testInfo,key(keys,'Arrow right'));
    await press(testInfo,key(keys,'Arrow down'));
    await expect.poll(()=>writes(page)).toEqual(['\x1b[1;2A','\x1b[1;5D','\x1b[1;3C',application?'\x1bOB':'\x1b[B']);
  }
  // A locked Ctrl (two presses) stays for every arrow until it is pressed again.
  await clearWrites(page);
  await press(testInfo,ctrl);await press(testInfo,ctrl);
  await expect(ctrl).toHaveAccessibleName('ctrl · lock');
  await press(testInfo,key(keys,'Arrow up'));await press(testInfo,key(keys,'Arrow down'));
  await expect.poll(()=>writes(page)).toEqual(['\x1b[1;5A','\x1b[1;5B']);
  await press(testInfo,ctrl);
  await expect(ctrl).toHaveAttribute('aria-pressed','false');
});

test('holding an arrow repeats it until release, with the bytes of the current cursor mode, and a short press sends it once',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  const left=key(keys,'Arrow left');
  await press(testInfo,left);
  await expect.poll(()=>writes(page)).toEqual(['\x1b[D']);
  await clearWrites(page);
  await hold(page,testInfo,left,900);
  const held=await writes(page);
  expect(held.length).toBeGreaterThan(3);
  expect(new Set(held)).toEqual(new Set(['\x1b[D']));
  // Releasing stops the repeat.
  await page.waitForTimeout(300);
  expect((await writes(page)).length).toBe(held.length);
  await clearWrites(page);
  await applicationMode(page,true);
  await hold(page,testInfo,key(keys,'Arrow up'),900);
  const heldApplication=await writes(page);
  expect(heldApplication.length).toBeGreaterThan(3);
  expect(new Set(heldApplication)).toEqual(new Set(['\x1bOA']));
});

test('saved layouts with separate arrow keys keep rendering them, also when the layout has no arrows at all',async({page},testInfo)=>{
  // The 1.33 layout: arrows as four separate keys, in two rows or scattered.
  const separate=['esc','up','tab','row-break','left','down','right','enter'];
  const keys=await openToolbar(page,testInfo,{toolbar:separate});
  const rows=keys.locator('.terminal-keys-row');
  await expect(rows).toHaveCount(2);
  const names=(row:Locator)=>row.getByRole('button').evaluateAll(buttons=>buttons.map(button=>button.getAttribute('aria-label')??button.textContent));
  expect(await names(rows.nth(0))).toEqual(['esc','Arrow up','tab']);
  expect(await names(rows.nth(1))).toEqual(['Arrow left','Arrow down','Arrow right','enter']);
  for(const name of arrows)await press(testInfo,key(keys,name));
  await expect.poll(()=>writes(page)).toEqual(arrows.map(name=>normal[name]));
  await page.evaluate(toolbar=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar}));window.dispatchEvent(new StorageEvent('storage',{key:'lazysh.preferences.v1'}));},['esc','tab']);
  await expect(key(keys,'Arrow up')).toHaveCount(0);
  await expect(keys.getByRole('button',{name:/Arrow/})).toHaveCount(0);
  // A layout that has Arrows and also separate arrow keys draws one cluster, not two sets.
  await page.evaluate(toolbar=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar}));window.dispatchEvent(new StorageEvent('storage',{key:'lazysh.preferences.v1'}));},['esc','up','arrows','row-break','tab','left']);
  await expect(keys.getByRole('button',{name:/Arrow/})).toHaveCount(4);
});

test('the 1.33 default layout moves to the new default and keeps the cluster; a customised layout keeps its keys',async({page},testInfo)=>{
  const previous=['keyboard','attach','esc','tab','paste','/','Home','up','End','row-break','shift','ctrl','meta','c','d','enter','left','down','right'];
  const keys=await openToolbar(page,testInfo,{toolbar:previous});
  const [up,down]=await Promise.all([box(key(keys,'Arrow up')),box(key(keys,'Arrow down'))]);
  expect(Math.abs(up.x-down.x)).toBeLessThanOrEqual(1);
  // The stored 1.33 default is read as the current default, whose Arrows entry replaces the four keys.
  await expect(keys.locator('.terminal-keys-row').nth(0).getByRole('button')).toHaveCount(9);
});

test('the toolbar key height scales the whole cluster',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo,{toolbarKeyHeight:48});
  for(const name of arrows)expect((await box(key(keys,name))).height).toBe(48);
  // Two 48px rows, the same 3px gap and padding as at 32px: the cluster adds no height at any size.
  expect((await box(keys)).height).toBe(106);
  const [up,down]=await Promise.all([box(key(keys,'Arrow up')),box(key(keys,'Arrow down'))]);
  expect(Math.abs(up.x-down.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(down.y-(up.y+up.height+3))).toBeLessThanOrEqual(1);
});

test('Arrows is one placeable component in the toolbar editor: one chip, one palette entry, and the preview draws the cluster',async({page},testInfo)=>{
  const keys=await openToolbar(page,testInfo);
  await openToolbarSettings(page);
  const editor=page.locator('.toolbar-editor');
  const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).toolbar as string[]);
  // In the default layout Arrows is a single chip of the first row, between Home and End; the four arrows are not separate chips.
  const chip=editor.locator('[data-chip-key="arrows"]');
  await expect(chip).toHaveCount(1);
  await expect(chip.getByRole('button').first()).toHaveText('Arrows');
  await expect(editor.locator('[data-chip-key="up"], [data-chip-key="left"], [data-chip-key="down"], [data-chip-key="right"]')).toHaveCount(0);
  expect(await editor.locator('.toolbar-editor-row').first().locator('[data-chip-key]').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-chip-key')).slice(-3))).toEqual(['Home','arrows','End']);
  // The preview draws the cluster: Up in the first row, Left, Down and Right in the second.
  const preview=editor.locator('.toolbar-preview-row');
  await expect(preview.nth(0).locator('[data-preview-key="up"]')).toHaveCount(1);
  await expect(preview.nth(1).locator('[data-preview-key="left"], [data-preview-key="down"], [data-preview-key="right"]')).toHaveCount(3);
  await page.screenshot({path:testInfo.outputPath('toolbar-editor-arrows.png')});
  // Removing it removes the whole cluster; the palette offers it back as one entry that goes to the end of the last row.
  await chip.getByRole('button',{name:'Remove arrows',exact:true}).click();
  await expect(chip).toHaveCount(0);
  await expect(preview.nth(1).locator('[data-preview-key="left"]')).toHaveCount(0);
  expect(await stored()).not.toContain('arrows');
  await editor.getByRole('button',{name:/^Add Arrows$/}).click();
  expect((await stored()).filter(entry=>entry==='arrows')).toHaveLength(1);
  expect((await stored()).at(-1)).toBe('arrows');
  await expect(editor.getByRole('button',{name:/^Add Arrows$/})).toHaveCount(0);
  // In the last row the cluster's Up key sits above its Down key.
  await expect(preview.nth(0).locator('[data-preview-key="up"]')).toHaveCount(1);
  await expect(preview.nth(1).locator('[data-preview-key="down"]')).toHaveCount(1);
  await closePreferences(page);
  const [up,down,left,right]=await Promise.all(['Arrow up','Arrow down','Arrow left','Arrow right'].map(name=>box(key(keys,name))));
  expect(Math.abs(up.x-down.x)).toBeLessThanOrEqual(1);
  expect(up.y).toBeLessThan(down.y);expect(left.x).toBeLessThan(down.x);expect(down.x).toBeLessThan(right.x);
  for(const name of arrows)await press(testInfo,key(keys,name));
  await expect.poll(()=>writes(page)).toEqual(arrows.map(name=>normal[name]));
  expect((await box(keys)).height).toBe(74);
});

import {expect,test,type Page} from '@playwright/test';
import {connectLocalTerminal,installLocalTerminal,startLocalTerminal} from './fixtures/localTerminal';
import {emulateVisualViewportKeyboard,setKeyboard} from './fixtures/softKeyboard';

const stored = 'lazysh.composerFloat.v1';
/** A local terminal whose composer is set to Floating on this device, so a reload keeps both choices. */
async function openTerminal(page:Page,bracketed=true) {
  await installLocalTerminal(page);
  await page.addInitScript(()=>{
    if(sessionStorage.getItem('floating-seeded'))return;
    sessionStorage.setItem('floating-seeded','1');
    localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,composerLayout:'floating'}));
  });
  await page.goto('/');
  await connectLocalTerminal(page);
  await page.evaluate(mode=>window.simpleShortcutOutput(`$ \x1b[?2004${mode?'h':'l'}`),bracketed);
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutResizes.length)).toBeGreaterThan(0);
}
const compose=(page:Page)=>page.getByRole('button',{name:'Compose',exact:true}).click();
const panel=(page:Page)=>page.locator('.terminal-composer-floating');
const editor=(page:Page)=>page.getByRole('textbox',{name:'Compose text',exact:true});
const stage=(page:Page)=>page.locator('.terminal-stage:visible');
const rows=(page:Page)=>page.locator('.terminal-canvas:visible .xterm-rows > div').count();
const place=(page:Page)=>page.evaluate(key=>JSON.parse(localStorage.getItem(key)??'null'),stored);
const box=async(page:Page)=>(await panel(page).boundingBox())!;

test('opens over the terminal without resizing its grid or locking it, and the toolbar stays',async({page},testInfo)=>{
  await openTerminal(page);
  const before={rows:await rows(page),resizes:await page.evaluate(()=>window.simpleShortcutResizes.length),canvas:await page.locator('.terminal-canvas:visible').boundingBox()};
  await compose(page);
  await expect(panel(page)).toBeVisible();
  await expect(editor(page)).toBeFocused();
  // A small panel inside the terminal area, not the full-height sheet.
  const area=(await stage(page).boundingBox())!,at=await box(page);
  expect(at.height).toBeLessThan(area.height/2);
  expect(at.x).toBeGreaterThanOrEqual(area.x);expect(at.x+at.width).toBeLessThanOrEqual(area.x+area.width+0.5);
  expect(at.y+at.height).toBeLessThanOrEqual(area.y+area.height+0.5);
  expect({rows:await rows(page),resizes:await page.evaluate(()=>window.simpleShortcutResizes.length),canvas:await page.locator('.terminal-canvas:visible').boundingBox()}).toEqual(before);
  await expect(page.locator('.terminal-keys')).toBeVisible();
  // The terminal is not inert: output still arrives and a tap on it focuses its own input.
  await page.evaluate(()=>window.simpleShortcutOutput('STILL_LIVE\r\n'));
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toContainText('STILL_LIVE');
  await page.locator('.terminal-canvas:visible .xterm-screen').click({position:{x:20,y:10}});
  await expect(page.locator('.terminal-canvas:visible .xterm-helper-textarea')).toBeFocused();
  await expect(editor(page)).not.toBeFocused();
  await page.screenshot({path:testInfo.outputPath('floating-composer.png'),animations:'disabled'});
  expect(await page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'))).toEqual([]);
});

for(const [bracketed,pasted] of [[true,'\x1b[200~floating text\x1b[201~'],[false,'floating text']] as const)
  test(`Send and Insert write the same bytes as the docked composer (bracketed paste ${bracketed?'on':'off'})`,async({page})=>{
    await openTerminal(page,bracketed);
    await compose(page);
    await editor(page).fill('floating text');
    await panel(page).getByRole('button',{name:'Insert',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'))).toEqual([pasted]);
    await expect(panel(page)).toHaveCount(0);
    await compose(page);
    await expect(editor(page)).toHaveValue('');
    await editor(page).fill('floating text');
    await panel(page).getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.simpleShortcutSteps)).toEqual([[pasted,'\r']]);
  });

test('stays above a soft keyboard that takes the window\'s height, as on Android',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Soft keyboard');
  await openTerminal(page);
  await compose(page);
  await editor(page).fill('above the keyboard');
  const full=page.viewportSize()!;
  await setKeyboard(page,true,330);
  await expect.poll(async()=>(await box(page)).y+(await box(page)).height).toBeLessThanOrEqual(full.height-330);
  expect((await box(page)).y).toBeGreaterThanOrEqual(0);
  await expect(editor(page)).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('floating-keyboard-resizes-window.png'),animations:'disabled'});
  await setKeyboard(page,false);
  // Back to the open window, the panel returns to the bottom of the terminal.
  await expect.poll(async()=>(await box(page)).y+(await box(page)).height).toBeGreaterThan(full.height-330);
});

test('stays above a soft keyboard that only shrinks the visual viewport, as on iOS',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Soft keyboard');
  await openTerminal(page);
  // WebKit keeps the layout viewport under the keyboard; the panel reads the visual viewport.
  const keyboard=await emulateVisualViewportKeyboard(page);
  await compose(page);
  await editor(page).fill('above the keyboard');
  const visible=page.viewportSize()!.height-330;
  await keyboard(330);
  await expect.poll(async()=>{const at=await box(page);return at.y+at.height<=visible+0.5;}).toBe(true);
  expect((await box(page)).y).toBeGreaterThanOrEqual(0);
  await page.screenshot({path:testInfo.outputPath('floating-keyboard-visual-viewport.png'),animations:'disabled'});
  await keyboard(0);
  await expect.poll(async()=>{const at=await box(page);return at.y+at.height>visible;}).toBe(true);
});

test('can be dragged and nudged with the arrow keys, remembers its place on this device, and Home restores it',async({page})=>{
  await openTerminal(page);
  await compose(page);
  const start=await box(page);
  const grip=panel(page).getByRole('button',{name:'Move composer',exact:true});
  const at=(await grip.boundingBox())!;
  await page.mouse.move(at.x+at.width/2,at.y+at.height/2);
  await page.mouse.down();
  await page.mouse.move(at.x+at.width/2+8,at.y+at.height/2-120,{steps:4});
  await page.mouse.up();
  const moved=await box(page);
  expect(Math.abs(moved.x-(start.x+8))).toBeLessThanOrEqual(1);
  expect(Math.abs(moved.y-(start.y-120))).toBeLessThanOrEqual(1);
  expect(await place(page)).toMatchObject({left:expect.any(Number),bottom:expect.any(Number)});
  // The terminal grid did not move with it.
  await grip.focus();
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowDown');
  const nudged=await box(page);
  // The panel is nearly as wide as a phone, so it can only move left by what room the edge leaves.
  expect(Math.round(moved.x-nudged.x)).toBe(Math.min(16,Math.round(moved.x)));expect(Math.round(nudged.y-moved.y)).toBe(16);
  // Closed and reopened, even after a reload, it is where it was left.
  await page.keyboard.press('Escape');
  await compose(page);
  expect(await box(page)).toEqual(nudged);
  await page.reload();
  await connectLocalTerminal(page);
  await compose(page);
  expect(await box(page)).toEqual(nudged);
  await panel(page).getByRole('button',{name:'Move composer',exact:true}).focus();
  await page.keyboard.press('Home');
  expect(await box(page)).toEqual(start);
});

test('collapses to a handle, keeps its draft and its place, and expands again',async({page})=>{
  await openTerminal(page);
  await compose(page);
  await editor(page).fill('keep this draft');
  const open=await box(page);
  await panel(page).getByRole('button',{name:'Collapse composer',exact:true}).click();
  const handle=panel(page).getByRole('button',{name:'Expand composer',exact:true});
  await expect(handle).toBeVisible();
  await expect(editor(page)).toBeHidden();
  const folded=await box(page);
  expect(folded.width).toBeLessThan(60);expect(folded.height).toBeLessThan(60);
  // Folded at the same corner, so the terminal behind stays reachable.
  expect(Math.abs(folded.x-open.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(folded.y+folded.height-(open.y+open.height))).toBeLessThanOrEqual(1);
  await handle.click();
  await expect(editor(page)).toHaveValue('keep this draft');
  await expect(editor(page)).toBeFocused();
  expect(await box(page)).toEqual(open);
  // Reopening the composer after a fold shows the editor, not the handle.
  await panel(page).getByRole('button',{name:'Collapse composer',exact:true}).click();
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await expect(editor(page)).toBeVisible();
});

test('the Preferences setting switches between Docked and Floating and stays on this device',async({page})=>{
  await installLocalTerminal(page);
  await page.goto('/');
  const {workspaceControl,openPreferenceCategory}=await import('./fixtures/workspaceControl');
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  const docked=page.getByRole('radio',{name:'Docked',exact:true}),floating=page.getByRole('radio',{name:'Floating',exact:true});
  await expect(docked).toBeChecked();
  await floating.check();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).composerLayout)).toBe('floating');
  await docked.check();
  expect(await page.evaluate(()=>'composerLayout' in JSON.parse(localStorage.getItem('lazysh.preferences.v1')!))).toBe(false);
});

test('the soft keyboard button lives in the panel header, not twice in the header bar',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Soft keyboard');
  await openTerminal(page);
  await compose(page);
  await expect(panel(page).getByRole('button',{name:'Show keyboard',exact:true})).toBeVisible();
  // The toolbar stays in view with its own keyboard key, so the session header adds none.
  await expect(page.getByRole('button',{name:'Toggle keyboard',exact:true})).toBeVisible();
  await expect(page.locator('.terminal-actions').getByRole('button',{name:/^(Show|Hide) keyboard$/})).toHaveCount(0);
  await setKeyboard(page,true);
  await expect(panel(page).getByRole('button',{name:'Hide keyboard',exact:true})).toBeVisible();
  await setKeyboard(page,false);
});

test('Docked stays the default: the sheet covers the terminal as before',async({page})=>{
  await startLocalTerminal(page);
  await compose(page);
  await expect(page.locator('.terminal-composer-sheet')).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  const area=(await stage(page).boundingBox())!;
  await expect.poll(async()=>(await page.locator('.terminal-composer-sheet').boundingBox())!).toEqual(area);
});

test('first opens over the bottom edge, or at the top when that would cover the cursor row',async({page},testInfo)=>{
  await openTerminal(page);
  // The prompt is at the top of a fresh screen: the panel sits low, near the keyboard.
  await compose(page);
  const area=(await stage(page).boundingBox())!;
  const low=await box(page);
  expect(low.y+low.height).toBeGreaterThan(area.y+area.height-24);
  await page.keyboard.press('Escape');
  await page.evaluate(key=>localStorage.removeItem(key),stored);
  // A screenful of output leaves the cursor on the last row: the panel starts at the top instead.
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:80},(_,index)=>`output ${index}\r\n`).join('')+'$ '));
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toContainText('$');
  await compose(page);
  const high=await box(page);
  expect(high.y).toBeLessThan(area.y+24);
  const cursor=await page.locator('.terminal-canvas:visible .xterm-cursor').boundingBox();
  if(cursor)expect(cursor.y>=high.y+high.height||cursor.y+cursor.height<=high.y).toBe(true);
  await page.screenshot({path:testInfo.outputPath('floating-clear-of-cursor.png'),animations:'disabled'});
});

import {expect,test,type Page,type TestInfo} from '@playwright/test';
import {installLocalTerminal,openLocalTerminal as openTerminal} from './fixtures/localTerminal';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';

const storedHeight=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')??'{}').toolbarKeyHeight as number|undefined);

/** What the toolbar costs the terminal: the rendered height of its keys and the rows the PTY was last resized to. */
async function measure(page:Page) {
  const key=page.getByLabel('Terminal keys',{exact:true}).getByRole('button',{name:'esc',exact:true});
  const keys=page.getByLabel('Terminal keys',{exact:true});
  await expect(key).toBeVisible();
  // The terminal refits after layout; wait for the resize the new toolbar height causes to settle.
  let rows=-1,stable=0;
  await expect.poll(async()=>{const now=await page.evaluate(()=>window.simpleShortcutResizes.at(-1)?.rows??0);stable=now===rows?stable+1:0;rows=now;return stable>=3;},{intervals:[100]}).toBe(true);
  const box=(await key.boundingBox())!,bar=(await keys.boundingBox())!,canvas=(await page.locator('.terminal-canvas:visible').boundingBox())!;
  return {key:box.height,bar:bar.height,rows,gap:bar.y-(canvas.y+canvas.height)};
}
async function setKeyHeight(page:Page,value:string|'reset') {
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Toolbar keys and order',{exact:true}).click();
  if(value==='reset')await page.getByRole('button',{name:'Default size',exact:true}).click();
  else await page.getByRole('slider',{name:'Toolbar key height',exact:true}).fill(value);
}

test('the toolbar key height setting resizes the keys and the terminal rows live, persists per device and resets to the compact default',async({page},testInfo)=>{
  await installLocalTerminal(page);
  await page.goto('/');
  await openTerminal(page,testInfo);
  const compact=await measure(page);
  expect(compact.key).toBe(32);

  await setKeyHeight(page,'48');
  const slider=page.getByRole('slider',{name:'Toolbar key height',exact:true});
  await expect(slider).toHaveAttribute('aria-valuetext','48 px');
  // The preview in the editor draws keys at the chosen height before the dialog closes.
  const preview=page.locator('.toolbar-preview-row > span').first();
  await expect.poll(async()=>(await preview.boundingBox())!.height).toBe(48);
  await page.screenshot({path:testInfo.outputPath('toolbar-size-editor.png')});
  expect(await storedHeight(page)).toBe(48);
  await closePreferences(page);
  const tall=await measure(page);
  expect(tall.key).toBe(48);
  // Two rows grew by 16 px each, and the terminal gave that room up: fewer rows, none hidden behind the keys.
  expect(Math.round(tall.bar-compact.bar)).toBe(32);
  expect(tall.rows).toBeLessThan(compact.rows);
  expect(tall.gap).toBeGreaterThanOrEqual(-1);
  await page.screenshot({path:testInfo.outputPath('toolbar-size-48.png')});

  // The smallest and largest stops of the control.
  await setKeyHeight(page,'28');
  await closePreferences(page);
  const small=await measure(page);
  expect(small.key).toBe(28);
  expect(small.rows).toBeGreaterThanOrEqual(compact.rows);
  await setKeyHeight(page,'56');
  await closePreferences(page);
  const largest=await measure(page);
  expect(largest.key).toBe(56);
  expect(largest.rows).toBeLessThanOrEqual(tall.rows);
  expect(largest.rows).toBeLessThan(compact.rows);

  // The size is saved on this device and survives a reload.
  await setKeyHeight(page,'40');
  await closePreferences(page);
  expect(await storedHeight(page)).toBe(40);
  await page.reload();
  await openTerminal(page,testInfo);
  const reloaded=await measure(page);
  expect(reloaded.key).toBe(40);

  // Back to the default: the key height returns, and the setting is no longer stored.
  await setKeyHeight(page,'reset');
  await expect(page.getByRole('slider',{name:'Toolbar key height',exact:true})).toHaveValue('32');
  await expect(page.getByRole('button',{name:'Default size',exact:true})).toBeDisabled();
  await closePreferences(page);
  const again=await measure(page);
  expect(again.key).toBe(32);
  expect(again.bar).toBe(compact.bar);
  // The 8 px per key row the toolbar gave back goes to the terminal.
  expect(again.rows).toBeGreaterThanOrEqual(reloaded.rows);
  expect(again.gap).toBeGreaterThanOrEqual(-1);
  expect(await storedHeight(page)).toBeUndefined();
});

for(const hostile of [10,200,40.5,'44']) test(`a stored key height of ${JSON.stringify(hostile)} is outside the control's range and falls back to the default size`,async({page},testInfo)=>{
  await installLocalTerminal(page);
  await page.addInitScript(hostile=>{if(!sessionStorage.getItem('size-seeded')){sessionStorage.setItem('size-seeded','1');localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbarKeyHeight:hostile}));}},hostile);
  await page.goto('/');
  await openTerminal(page,testInfo);
  expect((await measure(page)).key).toBe(32);
});

test('a saved key height scales the key text and icons, keeps every key on screen and yields to a short window',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone geometry.');
  await installLocalTerminal(page);
  await page.addInitScript(()=>{if(!sessionStorage.getItem('size-seeded')){sessionStorage.setItem('size-seeded','1');localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbarKeyHeight:56}));}});
  await page.goto('/');
  await openTerminal(page,testInfo);
  const keys=page.getByLabel('Terminal keys',{exact:true});
  const esc=keys.getByRole('button',{name:'esc',exact:true}),attach=keys.getByRole('button',{name:'Toggle keyboard',exact:true});
  expect((await esc.boundingBox())!.height).toBe(56);
  const text=await esc.evaluate(node=>parseFloat(getComputedStyle(node).fontSize));
  const icon=(await attach.locator('svg').boundingBox())!.height;
  // Text and icons follow the keys: larger than at the default 32 px (12 px text, 16 px icons).
  expect(text).toBeGreaterThan(12);
  expect(icon).toBeGreaterThan(16);
  for(const button of await keys.locator('.terminal-keys-row').getByRole('button').all())await expect(button).toBeInViewport({ratio:1});
  // A very short window keeps the rows to about a third of it instead of the full 56 px each.
  await page.setViewportSize({width:390,height:300});
  const squeezed=(await esc.boundingBox())!.height;
  expect(squeezed).toBeLessThan(56);
  expect(squeezed).toBeGreaterThanOrEqual(24);
  expect((await keys.boundingBox())!.height).toBeLessThanOrEqual(300*0.36);
});

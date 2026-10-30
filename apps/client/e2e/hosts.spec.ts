import { installNativeBridge } from './fixtures/nativeBridge';
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test.beforeEach(async ({ page }) => {
  await installNativeBridge(page);
  await page.addInitScript(() => {
    let hosts = [{id:'fixture-host', name:'Touch workstation', hostname:'fixture.invalid', username:'test', port:22}];
    window.nativeFixtureInvoke = async(command: string, args: Record<string, unknown> = {}) => {
        if (command === 'list_hosts') return hosts;
        if (command === 'local_capability') return {available:false, reason:'Test fixture'};
        if (command === 'delete_host') { hosts=[]; return; }
        if (command.startsWith('plugin:event|')) return 1;
        throw new Error(`Unexpected native command: ${command}`);
    };
  });
});

test('home and sidebar display the canonical Bed Mode mark',async({page},testInfo)=>{
  await page.goto('/');
  const welcomeMark=page.getByRole('img',{name:'lazysh',exact:true});
  await expect(welcomeMark).toBeVisible();
  await expect.poll(()=>welcomeMark.evaluate(image=>(image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth)).toBe(256);
  const homeBounds=await welcomeMark.boundingBox();
  expect(homeBounds!.width).toBeGreaterThan(64);
  expect(homeBounds!.height).toBe(homeBounds!.width);
  expect(homeBounds!.x).toBeGreaterThanOrEqual(0);
  expect(homeBounds!.x+homeBounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  const welcomeSource=await welcomeMark.getAttribute('src');
  await page.screenshot({path:testInfo.outputPath('welcome-brand.png')});
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).tap();
  const brand=page.getByRole('complementary',{name:'Hosts and connections'}).locator('.brand');
  const mark=brand.locator('img.brand-mark');
  await expect(brand).toBeVisible();
  await expect(mark).toBeVisible();
  expect(await mark.getAttribute('src')).toBe(welcomeSource);
  await expect(mark).toHaveAttribute('alt','');
  await expect(mark).toHaveAttribute('aria-hidden','true');
  await expect(brand.getByRole('img',{name:/lazysh|Bed Mode/})).toHaveCount(0);
  expect((await brand.innerText()).match(/lazysh/g)).toHaveLength(1);
  expect(await brand.innerText()).not.toContain('l_');
  await expect.poll(()=>mark.evaluate(image=>(image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth)).toBe(256);
  const canonical=await readFile(new URL('../../../brand/lazysh/svg/icon-gradient.svg',import.meta.url),'utf8');
  const svg=await mark.evaluate(async(image,original)=>{
    const normalize=(text:string)=>new DOMParser().parseFromString(text,'image/svg+xml').documentElement.outerHTML;
    return [normalize(await(await fetch((image as HTMLImageElement).src)).text()),normalize(original)];
  },canonical);
  expect(svg[0]).toBe(svg[1]);
  // Match existing host geometry checks: wait for the drawer to settle.
  await mark.scrollIntoViewIfNeeded();
  const dimensions=await mark.boundingBox();
  expect(dimensions?.width).toBe(35);expect(dimensions?.height).toBe(35);
  expect(dimensions!.x).toBeGreaterThanOrEqual(0);
  expect(dimensions!.x+dimensions!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(page.getByRole('button',{name:'Connect to Touch workstation',exact:true})).toBeVisible();
  await brand.screenshot({path:testInfo.outputPath('sidebar-brand.png')});
});

test('host actions remain reachable by touch and keyboard without connecting', async ({ page }, testInfo) => {
  await page.goto('/');
  const phone = testInfo.project.name === 'phone';
  if (phone) await page.getByRole('button', {name:'Open hosts', exact:true}).tap();
  const connect = page.getByRole('button', {name:'Connect to Touch workstation', exact:true});
  await expect(connect).toBeVisible();
  if (!phone) await connect.focus();
  const edit = page.getByRole('button', {name:'Edit Touch workstation', exact:true});
  const remove = page.getByRole('button', {name:'Delete Touch workstation', exact:true});
  await expect(edit).toBeVisible();
  await expect(remove).toBeVisible();
  if (phone) {
    for (const button of [edit, remove]) {
      // Wait for the drawer transition to settle before measuring its targets.
      await button.scrollIntoViewIfNeeded();
      const bounds = await button.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await remove.tap();
  } else {
    await page.keyboard.press('Tab');
    await expect(edit).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(remove).toBeFocused();
    await page.keyboard.press('Enter');
  }
  const dialog = page.getByRole('dialog', {name:'Delete host', exact:true});
  await expect(dialog).toBeVisible();
  await expect(connect).toHaveCount(1);
  await dialog.getByRole('button', {name:'Delete host', exact:true}).click();
  await expect(connect).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('phone host form stays legible and fits the viewport while focusing fields', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'Phone form layout');
  await page.goto('/');
  await page.getByRole('button', {name:'Open hosts', exact:true}).tap();
  await page.getByRole('button', {name:'Edit Touch workstation', exact:true}).tap();
  const dialog = page.getByRole('dialog', {name:'Edit host', exact:true});
  await dialog.getByRole('combobox', {name:'Preferred transport', exact:true}).selectOption('auto');
  for (const width of [360, 384, 393, 412]) {
    await page.setViewportSize({width, height: 844});
    for (const placeholder of ['Home workstation', 'workstation.local', 'Your SSH username']) {
      const field = dialog.getByPlaceholder(placeholder, {exact:true});
      await field.tap();
      expect(await field.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
      const bounds = await field.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await dialog.getByRole('button', {name:'Save host', exact:true}).tap({trial:true});
  }
});

test('preferences expose host multiplexer editing and keep mobile checkbox text beside controls', async ({page},testInfo) => {
  await page.goto('/');
  await page.getByRole('button', {name:'Preferences',exact:true}).click();
  const settings=page.getByRole('dialog',{name:'Preferences',exact:true});
  const lock=settings.getByRole('region',{name:'App lock settings',exact:true});
  await lock.scrollIntoViewIfNeeded();
  const gutter=await lock.evaluate(element=>{
    const dialog=element.closest('[role="dialog"]')!.getBoundingClientRect();
    const bounds=element.getBoundingClientRect();
    return {left:bounds.left-dialog.left,right:dialog.right-bounds.right};
  });
  expect(gutter.left).toBeGreaterThanOrEqual(16);
  expect(gutter.right).toBeGreaterThanOrEqual(16);
  await settings.screenshot({path:testInfo.outputPath('settings-gutters.png')});
  await settings.getByRole('region',{name:'Default multiplexer',exact:true}).getByRole('button',{name:'Edit Touch workstation',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'Edit host',exact:true});
  await editor.getByRole('combobox',{name:'Default multiplexer',exact:true}).selectOption('herdr');
  await editor.getByRole('textbox',{name:'Default multiplexer session',exact:true}).fill('mobile');
  const checkbox=editor.getByRole('checkbox').last();
  await checkbox.scrollIntoViewIfNeeded();
  const row=await checkbox.evaluate(input=>{
    const label=input.closest('label')!;
    const text=document.createRange();text.selectNodeContents(label);text.setStartAfter(input);
    const control=input.getBoundingClientRect(), words=text.getBoundingClientRect();
    return {controlRight:control.right,textLeft:words.left,controlTop:control.top,textBottom:words.bottom,scrolls:label.scrollWidth>label.clientWidth};
  });
  expect(row.textLeft).toBeGreaterThan(row.controlRight);
  expect(row.textBottom).toBeGreaterThan(row.controlTop);
  expect(row.scrolls).toBe(false);
  await editor.screenshot({path:testInfo.outputPath('checkbox-alignment.png')});
  expect(await editor.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
});

test('workspace restore explanation wraps below reachable actions on phones',async({page},testInfo)=>{
  await page.addInitScript(()=>localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'fixture-host'}])));
  await page.goto('/');
  const restore=page.getByRole('button',{name:'Restore previous workspace',exact:true});
  const dismiss=page.getByRole('button',{name:'Dismiss',exact:true});
  await expect(restore).toBeVisible();
  const banner=restore.locator('..');
  expect(await banner.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  if(testInfo.project.name==='phone'){
    const actions=await dismiss.boundingBox(), text=await banner.locator('span').boundingBox();
    expect(text!.y).toBeGreaterThanOrEqual(actions!.y+actions!.height);
  }
  await banner.screenshot({path:testInfo.outputPath('workspace-restore.png')});
  await dismiss.click();
  await expect(restore).toHaveCount(0);
});

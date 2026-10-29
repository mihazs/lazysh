import {installNativeBridge} from './fixtures/nativeBridge';
import { expect, test } from '@playwright/test';

test('browser preview is honest, usable at phone width and keyboard navigable', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByText(/SSH connections require the native/).first()).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  if ((page.viewportSize()?.width || 1200) <= 600) {
    await page.getByRole('button', {name:'Workspace tools',exact:true}).click();
    await expect(page.getByRole('button',{name:'Open encrypted sync'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Open shareable uploads'})).toBeDisabled();
    await expect(page.getByRole('button',{name:'Open notification inbox'})).toBeVisible();
    await page.keyboard.press('Escape');
  }
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('phone menu stays below a nonzero safe area and opens a touchable drawer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'Phone safe-area layout');
  const protocol = await page.context().newCDPSession(page);
  await protocol.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 62 } });
  await page.goto('/');
  const header = page.locator('.workspace-header');
  await expect(header).toHaveCSS('padding-top', '62px');
  const menu = page.getByRole('button', { name: 'Open hosts', exact: true });
  const menuBounds = await menu.boundingBox();
  const headerBounds = await header.boundingBox();
  expect(menuBounds).not.toBeNull();
  expect(headerBounds).not.toBeNull();
  expect(menuBounds!.y).toBeGreaterThanOrEqual(62);
  expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(headerBounds!.y + headerBounds!.height);
  await menu.tap();
  const close = page.getByRole('button', { name: 'Close hosts', exact: true });
  await expect(close).toBeInViewport();
  await close.tap();
  await expect(close).not.toBeInViewport();
});

test('saved named multiplexer entry is explicit and reachable on phone and desktop',async({page},testInfo)=>{
  await installNativeBridge(page);
  await page.addInitScript(()=>{
    let host={id:'default-host',name:'Direct workspace',hostname:'fixture.invalid',port:22,username:'test',transport:'mosh'};
    window.nativeFixtureInvoke=async(command,args)=>{
      if(command==='list_hosts')return [host];
      if(command==='save_host'){host=args.host as typeof host;return host;}
      if(command==='local_capability')return {available:false,reason:'Browser fixture'};
      if(command==='transport_capabilities')return {mosh:true,et:true};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected native request: ${command}`);
    };
  });
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).tap();
  await page.getByRole('button',{name:'Connect to Direct workspace',exact:true}).hover();
  await page.getByRole('button',{name:'Edit Direct workspace',exact:true}).click();
  const editor=page.getByRole('dialog',{name:'Edit host',exact:true});
  await editor.getByRole('combobox',{name:'Default multiplexer',exact:true}).selectOption('tmux');
  await editor.getByLabel('Default multiplexer session',{exact:true}).fill('my-new-workspace');
  await expect(editor.getByRole('combobox',{name:'Preferred transport',exact:true})).toHaveValue('mosh');
  await expect(editor.getByText('Attach to the named session, or create it using the selected multiplexer. No other session is selected.')).toBeVisible();
  const target=editor.getByLabel('Default multiplexer session',{exact:true});
  await target.scrollIntoViewIfNeeded();
  if(testInfo.project.name==='phone')expect(await target.evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await editor.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('default-multiplexer-editor.png')});
  await editor.getByRole('button',{name:'Save host',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Direct workspace',exact:true}).click();
  const connection=page.getByRole('dialog',{name:'Connect to Direct workspace',exact:true});
  await expect(connection.getByRole('combobox',{name:'Transport',exact:true})).toHaveValue('ssh');
  await expect(connection.getByRole('combobox',{name:'Transport',exact:true})).toBeDisabled();
  await expect(connection.getByText(/Enter tmux session my-new-workspace directly after connecting/)).toBeVisible();
  await expect(connection.getByText(/The saved transport preference is unchanged/)).toBeVisible();
  await connection.getByLabel('Password',{exact:true}).fill('browser-only-draft');
  await page.screenshot({path:testInfo.outputPath('default-multiplexer-connect.png')});
});

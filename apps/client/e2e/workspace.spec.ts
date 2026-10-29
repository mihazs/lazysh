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

test('one connected agent sidebar suspends hidden activity and preserves its drafts',async({page},testInfo)=>{
  await installNativeBridge(page);
  await page.clock.install();
  await page.addInitScript(()=>{
    const calls:string[]=[];const state={updated:false,installed:false};Object.assign(window,{workspaceNavigationCalls:calls,workspaceNavigationState:state});
    window.nativeFixtureInvoke=async(command,args={})=>{
      calls.push(command);
      if(command==='list_hosts')return [{id:'nav-host',name:'Navigation host',hostname:'fixture.invalid',username:'fixture',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic SSH UI fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'owned-navigation-ssh'};
      if(command==='install_companion'){
        if(args.sessionId!=='owned-navigation-ssh'||Object.keys(args).sort().join(',')!=='progress,sessionId')throw new Error('Unexpected installer arguments');
        (args.progress as {onmessage:(value:unknown)=>void}).onmessage({stage:'uploading'});state.installed=true;
        return {schemaVersion:1,status:'installed',version:'1.0.0',path:'/owned/lazysh/companion/lazysh-agent',cleanup:'complete'};
      }
      if(command==='agent_snapshot'){
        if(!state.installed)throw {message:'Synthetic missing host companion'};
        return {schemaVersion:1,sessions:[{sessionId:'reported-context',agent:'Claude Code',project:'/nav/project',state:'working',updatedAt:'2026-10-29T12:00:00Z',summary:state.updated?'Refreshed work':'Reported work',paneId:'%7',eventCount:3}]};
      }
      if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
      if(command==='get_companion_settings')return {schemaVersion:1,revision:4,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
      if(command==='board_keep_awake_status')return {available:false,active:false,reason:'Synthetic keep-awake unavailable',epoch:'0/11111111-1111-4111-8111-111111111111',ticket:1};
      if(command==='apple_status_capability')return {available:false,reason:'Synthetic status unavailable'};
      if(['cancel_credential_auth','adopt_session','resize','ack_output','disconnect'].includes(command)||command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected navigation fixture request: ${command}`);
    };
  });
  await page.goto('/');
  const phone=testInfo.project.name==='phone';
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const modes=page.getByRole('navigation',{name:'Workspace navigation',exact:true});
  await expect(modes.getByRole('button',{name:'Connections',exact:true})).toHaveAttribute('aria-current','page');
  await page.getByRole('button',{name:'Connect to Navigation host',exact:true}).click();
  await page.getByRole('textbox',{name:'Password',exact:true}).fill('synthetic-only');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  const views=page.getByRole('navigation',{name:'Session views',exact:true});
  for(const width of (phone?[360,393,412]:[1280])){
    await page.setViewportSize({width,height:844});
    for(const fontSize of [null,'16px']){
      await views.evaluate((node,size)=>{for(const button of node.querySelectorAll('button'))button.style.fontSize=size??'';},fontSize);
      const layout=await views.evaluate(node=>({
        pageFits:document.documentElement.scrollWidth<=window.innerWidth,
        scrolls:node.scrollWidth>node.clientWidth,
        contained:[...node.querySelectorAll('button')].every(button=>{
          const target=button.getBoundingClientRect();
          return [...button.children].every(child=>{const rect=child.getBoundingClientRect();return rect.left>=target.left&&rect.right<=target.right;});
        }),
      }));
      expect(layout.pageFits).toBe(true);
      expect(layout.contained).toBe(true);
      if(phone)expect(layout.scrolls).toBe(true);
      const last=views.getByRole('button').last();await last.scrollIntoViewIfNeeded();await expect(last).toBeInViewport();
    }
  }
  await page.screenshot({path:testInfo.outputPath('session-toolbar.png')});
  await views.evaluate(node=>{for(const button of node.querySelectorAll('button'))button.style.fontSize='';});
  await views.getByRole('button').first().scrollIntoViewIfNeeded();
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  const board=page.getByRole('region',{name:'Agent activity',exact:true});await expect(board).toHaveCount(1);
  await expect(board.getByRole('button',{name:'Install companion',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>command==='install_companion'))).toEqual([]);
  await board.getByRole('button',{name:'Install companion',exact:true}).click();
  await expect(board.getByText('Installed host companion 1.0.0.',{exact:true})).toBeVisible();
  await expect(board.getByRole('button',{name:'Update companion',exact:true})).toBeVisible();
  await expect(board.getByText('Reported work',{exact:true})).toBeVisible();
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  const search=board.getByRole('searchbox');await search.fill('/nav');
  const settings=board.getByRole('checkbox',{name:'Recorded usage inspection',exact:true});await settings.uncheck();
  const original=await settings.elementHandle();
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{updated:boolean}}).workspaceNavigationState.updated=true;});
  await page.clock.runFor(5000);
  await expect(board.getByText('Refreshed work',{exact:true})).toBeVisible();
  await expect(search).toHaveValue('/nav');await expect(settings).not.toBeChecked();
  if(phone)await page.getByRole('button',{name:'Close hosts',exact:true}).click();
  else await modes.getByRole('button',{name:'Connections',exact:true}).click();
  await expect(board).toBeHidden();
  const commands=()=>page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['agent_snapshot','agent_approvals','get_companion_settings','board_keep_awake_status'].includes(command)));
  const before=await commands();await page.clock.runFor(11000);expect(await commands()).toEqual(before);
  if(phone){await expect(page.getByRole('button',{name:'Open hosts',exact:true})).toBeFocused();await page.getByRole('button',{name:'Open hosts',exact:true}).click();}
  await modes.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await expect(board).toBeVisible();await expect(search).toHaveValue('/nav');await expect(settings).not.toBeChecked();
  await expect(board.locator('.companion-install button')).toBeHidden();
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  expect((await commands()).filter(command=>command==='get_companion_settings')).toHaveLength(before.filter(command=>command==='get_companion_settings').length);
  await search.scrollIntoViewIfNeeded();
  expect(await board.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('agent-navigation.png')});
  if(phone){await search.focus();await page.keyboard.press('Escape');await expect(board).toBeHidden();await expect(page.getByRole('button',{name:'Open hosts',exact:true})).toBeFocused();}
});

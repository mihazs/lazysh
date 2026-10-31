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
    const calls:string[]=[];const state={updated:false,installed:false,missing:false,holdTree:false,navigations:[] as unknown[]};Object.assign(window,{workspaceNavigationCalls:calls,workspaceNavigationState:state});
    window.nativeFixtureInvoke=async(command,args={})=>{
      calls.push(command);
      if(command==='list_hosts')return [{id:'nav-host',name:'Navigation host',hostname:'fixture.invalid',username:'fixture',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic SSH UI fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'owned-navigation-ssh'};
      if(command==='attach_multiplexer'){if(args.sessionId!=='owned-navigation-ssh'||args.kind!=='herdr'||args.name!=='default')throw new Error('Wrong Herdr adoption target');return {sessionId:'owned-navigation-herdr'};}
      if(command==='herdr_chat'){if(args.sessionId!=='owned-navigation-herdr')throw new Error('Wrong Herdr display');state.navigations.push(args.action);return {kind:'navigated'};}
      if(command==='multiplexer_sessions')return [{name:'default'}];
      if(command==='herdr_tree'){const tree={workspaces:[{workspace_id:'w1',label:'Development',focused:true,agent_status:'idle'}],tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'Codex tasks',number:1,focused:true,agent_status:'idle'}],panes:[{focused:true,agent_status:'idle',pane_id:'w1:p1',workspace_id:'w1',tab_id:'w1:t1',terminal_id:'codex-terminal',cwd:'/nav/codex'}],agents:[{terminal_id:'codex-terminal',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',name:'codex-builder',agent:'codex',agent_status:'idle'}]};if(state.holdTree)return new Promise(resolve=>{Object.assign(window,{finishHerdrRead:()=>{state.holdTree=false;resolve(tree);}});});return tree;}
      if(command==='agent_snapshot' && state.missing)throw new Error('Owned fixture companion unavailable');
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
  if(phone)await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
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
      if(phone)expect(layout.scrolls).toBe(false);
      const last=views.getByRole('button').last();await last.scrollIntoViewIfNeeded();await expect(last).toBeInViewport();
    }
  }
  await page.screenshot({path:testInfo.outputPath('session-toolbar.png')});
  await views.evaluate(node=>{for(const button of node.querySelectorAll('button'))button.style.fontSize='';});
  await views.getByRole('button').first().scrollIntoViewIfNeeded();
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  const board=page.getByRole('region',{name:'Agent activity',exact:true});await expect(board).toHaveCount(1);
  await page.clock.runFor(200);
  await expect(board.getByRole('button',{name:'Install companion',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>command==='install_companion'))).toEqual([]);
  await board.getByRole('button',{name:'Install companion',exact:true}).click();
  await expect(board.getByText('Installed host companion 1.0.0.',{exact:true})).toBeVisible();
  await expect(board.getByRole('button',{name:'Update companion',exact:true})).toBeVisible();
  await expect(board.getByText('Reported work',{exact:true})).toBeVisible();
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  const live=page.getByRole('region',{name:'Herdr navigation',exact:true});
  await expect(live.getByText('codex-builder',{exact:true})).toBeVisible();
  await expect(live.getByRole('heading',{name:'Idle · 1',exact:true})).toBeVisible();
  const steadyRow=live.getByRole('button',{name:/^codex-builder/}),originalRow=await steadyRow.elementHandle();
  const opacity=await steadyRow.evaluate(node=>getComputedStyle(node).opacity);
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{holdTree:boolean}}).workspaceNavigationState.holdTree=true;});
  await page.clock.runFor(5000);
  await expect.poll(()=>page.evaluate(()=>typeof (window as unknown as {finishHerdrRead?:()=>void}).finishHerdrRead)).toBe('function');
  expect(await originalRow!.evaluate(node=>node.isConnected&&node===document.querySelector('.herdr-navigation-row'))).toBe(true);
  expect(await steadyRow.evaluate(node=>({disabled:(node as HTMLButtonElement).disabled,opacity:getComputedStyle(node).opacity}))).toEqual({disabled:false,opacity});
  await expect(live.getByText('Reading Herdr workspaces…',{exact:true})).toHaveCount(0);
  await page.evaluate(()=>(window as unknown as {finishHerdrRead:()=>void}).finishHerdrRead());
  await live.getByRole('button',{name:/^codex-builder/}).scrollIntoViewIfNeeded();
  expect((await live.getByRole('button',{name:/^codex-builder/}).boundingBox())!.x).toBeGreaterThanOrEqual(13);
  await page.screenshot({path:testInfo.outputPath('herdr-live-discovery.png')});
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{missing:boolean}}).workspaceNavigationState.missing=true;});
  await board.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(board.getByRole('alert')).toHaveText('Owned fixture companion unavailable');
  await expect(live.getByText('codex-builder',{exact:true})).toBeVisible();
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{missing:boolean}}).workspaceNavigationState.missing=false;});
  await board.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(board.getByText('Reported work',{exact:true})).toBeVisible();
  const search=board.getByRole('searchbox',{name:'Search reported agents',exact:true});await search.fill('/nav');
  const settings=board.getByRole('checkbox',{name:'Recorded usage inspection',exact:true});await settings.uncheck();
  const original=await settings.elementHandle();
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{updated:boolean}}).workspaceNavigationState.updated=true;});
  await page.clock.runFor(5000);
  await expect(board.getByText('Refreshed work',{exact:true})).toBeVisible();
  await expect(search).toHaveValue('/nav');await expect(settings).not.toBeChecked();
  if(phone)await page.getByRole('button',{name:'Close hosts',exact:true}).click();
  else await modes.getByRole('button',{name:'Connections',exact:true}).click();
  await expect(board).toBeHidden();
  const commands=()=>page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['agent_snapshot','agent_approvals','get_companion_settings','board_keep_awake_status','multiplexer_sessions','herdr_tree'].includes(command)));
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
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  await expect(live.getByRole('heading',{name:'Spaces',exact:true})).toBeVisible();
  const collapse=live.getByRole('button',{name:'Expand or collapse Development',exact:true});
  await collapse.click();await expect(live.getByText('codex-builder',{exact:true})).toBeHidden();
  await collapse.click();await expect(live.getByText('codex-builder',{exact:true})).toBeVisible();
  await live.getByRole('searchbox').fill('codex');
  await expect(live.getByText('Development',{exact:true})).toBeVisible();
  await expect(live.getByText('Codex tasks',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('herdr-spaces.png')});
  expect(await live.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await live.getByRole('button',{name:/^codex-builder/}).click();
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {workspaceNavigationState:{navigations:unknown[]}}).workspaceNavigationState.navigations)).toEqual([{kind:'navigate',name:'default',target:{kind:'pane',workspace:'w1',tab:'w1:t1',pane:'w1:p1',terminal:'codex-terminal'}}]);
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['herdr_action','write_stdin'].includes(command)))).toEqual([]);
});

test('mobile terminal keeps one compact header and reaches every session control through More',async({page},testInfo)=>{
  await installNativeBridge(page);
  await page.addInitScript(()=>{
    let next=0;
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'focus-host'}]));
    window.nativeFixtureInvoke=async(command)=>{
      if(command==='list_hosts')return [{id:'focus-host',name:'Focus workstation with a long host name',hostname:'fixture.invalid',username:'fixture',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic workspace fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:`focus-session-${++next}`};
      if(['resize','ack','write_stdin','disconnect','cancel_credential_auth'].includes(command))return;
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected compact workspace request: ${command}`);
    };
  });
  await page.goto('/');
  const phone=testInfo.project.name==='phone';
  async function connectHost(){
    if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
    await page.getByRole('button',{name:'Connect to Focus workstation with a long host name',exact:true}).click();
    await page.getByRole('textbox',{name:'Password',exact:true}).fill('synthetic-only');
    await page.getByRole('button',{name:'Connect',exact:true}).click();
  }
  const startup=page.locator('.workspace > .workspace-restore');
  const startupRow=startup.locator('.workspace-restore-row');
  const widths=phone?[320,393,412]:[1280];
  for(const width of widths)for(const font of [1,1.5,2]){
    await page.setViewportSize({width,height:844});
    await startupRow.evaluate((element,scale)=>{element.style.fontSize=`${11*scale}px`;for(const button of element.querySelectorAll('button'))button.style.fontSize='inherit';},font);
    const restoreButton=(await startupRow.getByRole('button',{name:'Restore previous workspace',exact:true}).boundingBox())!;
    const info=(await startupRow.getByRole('button',{name:'Workspace details',exact:true}).boundingBox())!;
    const dismiss=(await startupRow.getByRole('button',{name:'Dismiss',exact:true}).boundingBox())!;
    expect(restoreButton.x+restoreButton.width).toBeLessThanOrEqual(info.x);
    expect(info.x+info.width).toBeLessThanOrEqual(dismiss.x);
    expect(info.width).toBe(44);expect(info.height).toBe(44);expect(dismiss.width).toBe(44);expect(dismiss.height).toBe(44);
    expect(info.y+info.height/2).toBe(dismiss.y+dismiss.height/2);
    expect(await startup.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
  }
  await startupRow.evaluate(element=>{element.style.fontSize='';for(const button of element.querySelectorAll('button'))button.style.fontSize='';});
  await page.setViewportSize({width:phone?393:1280,height:844});
  const collapsed=(await startup.boundingBox())!.height;
  expect(await startup.locator('.workspace-restore-help').count()).toBe(0);
  await startupRow.getByRole('button',{name:'Workspace details',exact:true}).click();
  await expect(startup.getByText('Uses saved credentials; tmux and Herdr reattach. Open Zellij sessions from Sessions.',{exact:true})).toBeVisible();
  expect((await startup.boundingBox())!.height).toBeGreaterThan(collapsed);
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('restore-details.png')});
  await startupRow.getByRole('button',{name:'Workspace details',exact:true}).click();
  await page.screenshot({path:testInfo.outputPath('compact-restore.png')});
  await connectHost();
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  const canvas=await page.locator('.terminal-canvas:visible').elementHandle();
  const header=page.locator('.workspace-header');
  const strip=page.locator('.session-toolbar');
  const tabs=page.locator('.session-tabs');
  const restore=page.locator('.workspace > .workspace-restore');
  if(phone){
    for(const width of [393,412]) for(const height of [844,420]){
      await page.setViewportSize({width,height});
      await expect(strip).toBeHidden();await expect(tabs).toBeHidden();await expect(restore).toBeHidden();
      expect((await header.boundingBox())!.height).toBe(44);
      expect((await page.locator('.session-body').boundingBox())!.y).toBe(44);
      for(const name of ['Open hosts','Switch terminal session','Workspace tools']){
        const bounds=(await page.getByRole('button',{name,exact:true}).boundingBox())!;
        expect(bounds.height).toBeGreaterThanOrEqual(44);expect(bounds.width).toBeGreaterThanOrEqual(44);
        expect(bounds.x).toBeGreaterThanOrEqual(0);expect(bounds.x+bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y).toBeGreaterThanOrEqual(0);expect(bounds.y+bounds.height).toBeLessThanOrEqual(44);
      }
      for(const name of ['esc','tab']){
        const key=page.locator('.terminal-keys:visible').getByRole('button',{name,exact:true});
        await expect(key).toBeInViewport();
        const bounds=(await key.boundingBox())!;expect(bounds.y+bounds.height).toBeLessThanOrEqual(height);
      }
    }
    await page.setViewportSize({width:393,height:844});
    const protocol=await page.context().newCDPSession(page);
    await protocol.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:62}});
    await expect(header).toHaveCSS('padding-top','62px');
    expect((await header.boundingBox())!.height).toBe(106);
    for(const name of ['Open hosts','Switch terminal session','Workspace tools']){
      const bounds=(await page.getByRole('button',{name,exact:true}).boundingBox())!;
      expect(bounds.y).toBeGreaterThanOrEqual(62);expect(bounds.y+bounds.height).toBeLessThanOrEqual(106);
    }
    await protocol.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0}});
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    const more=page.getByRole('dialog',{name:'Workspace tools',exact:true});
    const sessionViews=more.getByRole('navigation',{name:'Session views',exact:true});
    expect(await sessionViews.getByRole('button').count()).toBeGreaterThan(8);
    for(const button of await sessionViews.getByRole('button').all()){
      await button.scrollIntoViewIfNeeded();expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await more.getByRole('button',{name:'New connection',exact:true}).click();
    await expect(more).toHaveCount(0);await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await expect(more.getByRole('button',{name:'End Focus workstation with a long host name connection',exact:true})).toBeVisible();
    await expect(more.getByRole('button',{name:'Restore previous workspace',exact:true})).toBeVisible();
    await more.getByRole('button',{name:'Dismiss',exact:true}).click();
    await expect(more.getByRole('region',{name:'Restore previous workspace',exact:true})).toHaveCount(0);
    await more.getByRole('button',{name:'Preferences',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Preferences',exact:true})).toBeVisible();await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await more.getByRole('button',{name:'Attach',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Attach to this host',exact:true})).toBeVisible();
    await expect(strip).toBeVisible();await expect(tabs).toBeVisible();
    await strip.getByRole('button',{name:'Terminal',exact:true}).click();
    await expect(strip).toBeHidden();expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('compact-terminal.png')});
  }else{
    await expect(header).toBeVisible();await expect(strip).toBeVisible();await expect(tabs).toBeVisible();await expect(restore).toBeVisible();
    expect((await header.boundingBox())!.height).toBe(63);
  }
  if(phone){
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await page.getByRole('dialog',{name:'Workspace tools',exact:true}).getByRole('button',{name:'Default multiplexer',exact:true}).click();
    const editor=page.getByRole('dialog',{name:'Edit host',exact:true});
    const defaultMux=editor.getByRole('combobox',{name:'Default multiplexer',exact:true});
    await expect(defaultMux).toBeFocused();await expect(defaultMux).toBeInViewport();
    await defaultMux.selectOption('herdr');
    await editor.getByLabel('Default multiplexer session',{exact:true}).fill('unsaved-work');
    await editor.getByRole('button',{name:'Close Edit host',exact:true}).click();
    expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
    await expect(tabs.getByRole('tab',{includeHidden:true})).toHaveCount(1);
  }
  await connectHost();
  await expect(page.getByRole('tab')).toHaveCount(2);await expect(tabs).toBeVisible();
  await page.getByRole('button',{name:'Switch terminal session',exact:true}).click();
  const switcher=page.getByRole('dialog',{name:'Switch terminal session',exact:true});
  await expect(switcher.locator('.session-choice')).toHaveCount(2);
  await switcher.locator('.session-choice').first().focus();await page.keyboard.press('Enter');
  await expect(switcher).toHaveCount(0);
  expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
  if(phone){
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await page.getByRole('dialog',{name:'Workspace tools',exact:true}).getByRole('button',{name:'End Focus workstation with a long host name connection',exact:true}).click();
    await expect(page.locator('.session-tabs [role=tab]')).toHaveCount(1);
    await expect(tabs).toBeHidden();await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  }
});

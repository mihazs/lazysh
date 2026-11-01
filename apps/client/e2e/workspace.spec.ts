import {installNativeBridge} from './fixtures/nativeBridge';
import { expect, test, type Page } from '@playwright/test';
import {readFileSync} from 'node:fs';

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
    await openWorkspaceGroup(page,'application');
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
  await connection.locator('.connection-options > summary').click();
  const transport=connection.getByRole('combobox',{name:'Transport',exact:true});
  await expect(transport).toHaveValue('mosh');
  await expect(transport).toBeEnabled();
  await transport.selectOption('ssh');
  await expect(transport).toHaveValue('ssh');
  await transport.selectOption('auto');
  await expect(transport.locator('option:checked')).toHaveText('Auto (Mosh, then SSH)');
  await transport.selectOption('mosh');
  await expect(connection.getByText(/Enter tmux session my-new-workspace directly after connecting/)).toBeVisible();
  await expect(connection.getByText(/Direct multiplexer entry supports SSH or Mosh/)).toBeVisible();
  await connection.getByLabel('Password',{exact:true}).fill('browser-only-draft');
  await page.screenshot({path:testInfo.outputPath('default-multiplexer-connect.png')});
});

async function openWorkspaceGroup(page:Page,group:'more'|'connections'|'application'){
  const selector={more:'workspace-more-tools',connections:'workspace-connection-actions',application:'workspace-application-options'}[group];
  await page.getByRole('dialog',{name:'Workspace tools',exact:true}).locator(`details.${selector} > summary`).click();
}

async function installWorkspaceNavigation(page:Page,geometry=false){
  await installNativeBridge(page);
  await page.addInitScript((geometry)=>{
    const calls:string[]=[];const state={updated:false,installed:false,missing:false,holdTree:false,agentCount:1,empty:false,hooksConfigured:false,hookActions:[] as string[],navigations:[] as unknown[]};Object.assign(window,{workspaceNavigationCalls:calls,workspaceNavigationState:state});
    window.nativeFixtureInvoke=async(command,args={})=>{
      calls.push(command);
      if(command==='list_hosts')return [{id:'nav-host',name:'Navigation host',hostname:'fixture.invalid',username:'fixture',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic SSH UI fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'owned-navigation-ssh'};
      if(command==='attach_multiplexer'){if(args.sessionId!=='owned-navigation-ssh'||args.kind!=='herdr'||args.name!=='default')throw new Error('Wrong Herdr adoption target');return {sessionId:'owned-navigation-herdr'};}
      if(command==='herdr_action'){if(args.sessionId!=='owned-navigation-herdr'||args.name!=='default')throw new Error('Wrong Herdr display');state.navigations.push(args.action);return;}
      if(command==='multiplexer_sessions')return [{name:'default'}];
      if(command==='herdr_tree'){const tree={workspaces:[{workspace_id:'w1',label:geometry?'HERDR_'+'a'.repeat(32):'Development',focused:true,agent_status:geometry?'unknown':'idle'}],tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:geometry?'1':'Codex tasks',number:1,focused:true,agent_status:geometry?'unknown':'idle'}],panes:[{focused:true,agent_status:geometry?'unknown':'idle',pane_id:'w1:p1',workspace_id:'w1',tab_id:'w1:t1',terminal_id:'codex-terminal',cwd:geometry?'/tmp/lazysh-h-abcdef':'/nav/codex'}],agents:[{terminal_id:'codex-terminal',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',name:geometry?null:'codex-builder',agent:'codex',agent_status:geometry?'unknown':'idle'}]};if(state.agentCount>1){
        const pane=tree.panes[0],agent=tree.agents[0];
        tree.panes=Array.from({length:state.agentCount},(_,i)=>({...pane,pane_id:`w1:p${i+1}`,terminal_id:`codex-terminal-${i+1}`,focused:i===0}));
        tree.agents=tree.panes.map((pane,i)=>({...agent,pane_id:pane.pane_id,terminal_id:pane.terminal_id,name:`codex-builder-${i+1}`}));
      }if(state.holdTree)return new Promise(resolve=>{Object.assign(window,{finishHerdrRead:()=>{state.holdTree=false;resolve(tree);}});});return tree;}
      if(command==='agent_snapshot' && state.missing)throw new Error('Owned fixture companion unavailable');
      if(command==='install_companion'){
        if(args.sessionId!=='owned-navigation-ssh'||Object.keys(args).sort().join(',')!=='progress,sessionId')throw new Error('Unexpected installer arguments');
        (args.progress as {onmessage:(value:unknown)=>void}).onmessage({stage:'uploading'});state.installed=true;
        return {schemaVersion:1,status:'installed',version:'1.0.0',path:'/owned/lazysh/companion/lazysh-agent',cleanup:'complete'};
      }
      if(command==='agent_snapshot'){
        if(geometry || state.empty)return {schemaVersion:1,sessions:[]};
        if(!state.installed)throw {message:'Synthetic missing host companion'};
        return {schemaVersion:1,sessions:[{sessionId:'reported-context',agent:'Claude Code',project:'/nav/project',state:'working',updatedAt:'2026-10-29T12:00:00Z',summary:state.updated?'Refreshed work':'Reported work',paneId:'%7',eventCount:3}]};
      }
      if(command==='companion_hook_discovery'){
        if(args.sessionId!=='owned-navigation-ssh'||Object.keys(args).join(',')!=='sessionId')throw new Error('Wrong discovery source');
        return {schemaVersion:1,supported:true,managedSetupSupported:true,truncated:false,agents:[
          {agent:'codex',setup:'managed',executable:{path:'/owned/bin/codex',source:'path'},profiles:[{path:'/owned/profile',source:'CODEX_HOME',state:'directory'}]},
          {agent:'claude',setup:'managed',executable:null,profiles:[{path:'/owned/other-profile',source:'default',state:'directory'}]},
          ...['droid','gemini','cursor','opencode'].map(agent=>({agent,setup:'managed',executable:{path:`/owned/bin/${agent}`,source:'path'},profiles:[{path:`/owned/${agent} profile`,source:'HOME',state:'directory'}]})),
          {agent:'cline',setup:'manual',executable:{path:'/owned/bin/cline',source:'path'},profiles:[]},
          {agent:'aider',setup:'healthOnly',executable:{path:'/owned/bin/aider',source:'path'},profiles:[]},
        ]};
      }
      if(command==='companion_hooks'){
        const request=args.request as {agent:string;action:string;profileRoot:string;expectedPlan?:string};
        if(args.sessionId!=='owned-navigation-ssh' || request.agent!=='codex' || request.profileRoot!=='/owned/profile')throw new Error('Wrong owned hook inspection target');
        state.hookActions.push(request.action);
        if(request.action==='status')return {schemaVersion:1,supported:true,state:state.hooksConfigured?'configured':null,installPlan:'a'.repeat(64),removePlan:'b'.repeat(64),trust:'notChecked',reporting:'notChecked'};
        if(request.action==='install' && request.expectedPlan==='a'.repeat(64)){state.hooksConfigured=true;return {schemaVersion:1,outcome:{status:'configured'},trust:'notChecked',reporting:'notChecked'};}
        throw new Error('Uninspected hook mutation');
      }
      if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
      if(command==='get_companion_settings')return {schemaVersion:1,revision:4,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
      if(command==='board_keep_awake_status')return {available:geometry,active:false,reason:'Synthetic keep-awake unavailable',epoch:'0/11111111-1111-4111-8111-111111111111',ticket:1};
      if(command==='apple_status_capability')return {available:false,reason:'Synthetic status unavailable'};
      if(['cancel_credential_auth','adopt_session','resize','ack_output','disconnect'].includes(command)||command.startsWith('plugin:event|'))return;
      throw new Error(`Unexpected navigation fixture request: ${command}`);
    };
  },geometry);
}

async function openClockedNavigation(page:Page) {
  await page.clock.install();await installWorkspaceNavigation(page);await page.goto('/');
}

async function connectPasswordHost(page:Page,name='Navigation host'){
  await page.getByRole('button',{name:`Connect to ${name}`,exact:true}).click();
  await page.getByRole('textbox',{name:'Password',exact:true}).fill('synthetic-only');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
}

const nativeWorkspaceSource=readFileSync(new URL('../src-tauri/gen/android/app/src/androidTest/java/app/lazysh/client/NativeWorkspaceTest.kt',import.meta.url),'utf8');

function nativeWorkspaceVisibility(selector:string,touchable=false){
  const body=/private fun workspaceElementVisible\(selector: String, touchable: Boolean = false\) = """([\s\S]*?)"""/.exec(nativeWorkspaceSource)?.[1];
  if(!body)throw new Error('Native workspace visibility contract changed');
  return body.replace('${JSONObject.quote(selector)}',()=>JSON.stringify(selector)).replaceAll('$touchable',String(touchable));
}

function nativeHerdrNavigationRow(label:string,context?:string){
  const condition=/val match = if \(context == null\) "([^"]+)" else "([^"]+)"/.exec(nativeWorkspaceSource);
  const row=/val row = "([^"\n]+herdr-navigation-row[^"\n]+)"/.exec(nativeWorkspaceSource);
  if(!condition||!row)throw new Error('Native Herdr row selector contract changed');
  const match=condition[context===undefined?1:2].replaceAll('$targetLabel',()=>label).replaceAll('$context',()=>context??'');
  return 'xpath='+row[1].replace('$match',()=>match);
}

function nativeHerdrNavigationReady(label:string,context?:string){
  const body=/awaitDocument\(scenario, "shared Herdr navigation target ready", """([\s\S]*?)"""\)/.exec(nativeWorkspaceSource)?.[1];
  if(!body)throw new Error('Native Herdr readiness contract changed');
  return body.replace('${JSONObject.quote(row)}',()=>JSON.stringify(nativeHerdrNavigationRow(label,context).slice('xpath='.length)));
}

test('one connected agent sidebar suspends hidden activity and preserves its drafts',async({page},testInfo)=>{
  await openClockedNavigation(page);
  const phone=testInfo.project.name==='phone';
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const modes=page.getByRole('navigation',{name:'Workspace navigation',exact:true});
  await expect(modes.getByRole('button',{name:'Connections',exact:true})).toHaveAttribute('aria-current','page');
  await connectPasswordHost(page);
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
  const setup=board.getByRole('button',{name:'Setup',exact:true});
  await expect(setup).toHaveAttribute('aria-expanded','true');
  await setup.click();
  await expect(setup).toHaveAttribute('aria-expanded','false');
  await expect(board.getByRole('region',{name:'Host companion settings',exact:true})).toBeHidden();
  await setup.click();
  await expect(board.getByRole('button',{name:'Update companion',exact:true})).toBeVisible();
  await setup.click();
  await expect(board.getByText('Reported work',{exact:true})).toBeVisible();
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  const live=page.getByRole('region',{name:'Herdr navigation',exact:true});
  await expect(live.getByText('codex-builder',{exact:true})).toBeVisible();
  const serverSetup=live.locator('.herdr-server-setup');
  await expect(serverSetup).not.toHaveAttribute('open');
  await expect(live.getByRole('combobox',{name:'Herdr server',exact:true})).toBeHidden();
  await serverSetup.locator('summary').click();
  await expect(live.getByRole('combobox',{name:'Herdr server',exact:true})).toHaveValue('default');
  await serverSetup.locator('summary').click();
  if(phone)await page.setViewportSize({width:393,height:844});
  await page.locator('.workspace-navigation-scroll').evaluate(node=>{node.scrollTop=0;});
  await expect(live.getByRole('button',{name:/^codex-builder/})).toBeInViewport({ratio:0.75});
  await page.screenshot({path:testInfo.outputPath('healthy-agents-first-row.png')});
  await expect(live.getByRole('heading',{name:'Idle · 1',exact:true})).toBeVisible();
  await expect(page.locator(nativeHerdrNavigationRow('codex-builder','Development / Codex tasks / /nav/codex'))).toHaveCount(1);
  await expect(page.locator(nativeHerdrNavigationRow('codex-builder','Idle'))).toHaveCount(0);
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
  await setup.click();
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
  const installer=board.getByRole('button',{name:'Update companion',exact:true,includeHidden:true});
  await expect(installer).toHaveCount(1);await expect(installer).toBeHidden();
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  expect((await commands()).filter(command=>command==='get_companion_settings')).toHaveLength(before.filter(command=>command==='get_companion_settings').length);
  await search.scrollIntoViewIfNeeded();
  expect(await board.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('agent-navigation.png')});
  if(phone){await search.focus();await page.keyboard.press('Escape');await expect(board).toBeHidden();await expect(page.getByRole('button',{name:'Open hosts',exact:true})).toBeFocused();}
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  await expect(live.getByRole('heading',{name:'Spaces',exact:true})).toBeVisible();
  await expect(page.locator(nativeHerdrNavigationRow('Development'))).toHaveCount(1);
  const collapse=live.getByRole('button',{name:'Expand or collapse Development',exact:true});
  await collapse.click();await expect(live.getByText('codex-builder',{exact:true})).toBeHidden();
  await collapse.click();await expect(live.getByText('codex-builder',{exact:true})).toBeVisible();
  await live.getByRole('searchbox').fill('codex');
  await expect(live.getByText('Development',{exact:true})).toBeVisible();
  await expect(live.getByText('Codex tasks',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('herdr-spaces.png')});
  expect(await live.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.locator(nativeHerdrNavigationRow('codex-builder')).click();
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {workspaceNavigationState:{navigations:unknown[]}}).workspaceNavigationState.navigations)).toEqual([{type:'focusPane',target:'w1:p1'}]);
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['herdr_chat','write_stdin'].includes(command)))).toEqual([]);
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{holdTree:boolean}}).workspaceNavigationState.holdTree=true;delete (window as unknown as {finishHerdrRead?:()=>void}).finishHerdrRead;});
  if(phone){
    await page.getByRole('button',{name:'Switch terminal session',exact:true}).click();
    await page.getByRole('dialog',{name:'Switch terminal session',exact:true}).locator('.session-choice').filter({has:page.getByText('Navigation host',{exact:true})}).click();
  }else await page.getByRole('tab',{name:'Navigation host',exact:true}).click();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  await expect(live.getByText('Shared focus changes focus for other connections to this server.',{exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>typeof (window as unknown as {finishHerdrRead?:()=>void}).finishHerdrRead)).toBe('function');
  expect(await page.evaluate(nativeHerdrNavigationReady('Codex tasks'))).toBe(false);
  await page.evaluate(()=>(window as unknown as {finishHerdrRead:()=>void}).finishHerdrRead());
  await expect.poll(()=>page.evaluate(nativeHerdrNavigationReady('Codex tasks'))).toBe(true);
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
    await connectPasswordHost(page,'Focus workstation with a long host name');
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
  const closeHosts="button[aria-label='Close hosts']";
  await expect.poll(()=>page.evaluate(nativeWorkspaceVisibility(closeHosts))).toBe(false);
  if(phone){
    await page.getByRole('button',{name:'Open hosts',exact:true}).click();
    await expect.poll(()=>page.evaluate(nativeWorkspaceVisibility(closeHosts,true))).toBe(true);
    await page.getByRole('button',{name:'Close hosts',exact:true}).click();
    await expect.poll(()=>page.evaluate(nativeWorkspaceVisibility(closeHosts))).toBe(false);
  }
  const canvas=await page.locator('.terminal-canvas:visible').elementHandle();
  const header=page.locator('.workspace-header');
  const strip=page.locator('.session-toolbar');
  const tabs=page.locator('.session-tabs');
  const restore=page.locator('.workspace > .workspace-restore');
  const actions=header.locator('.terminal-actions');
  await expect(actions.getByRole('button')).toHaveCount(2);
  expect(await page.locator('.terminal-toolbar-toggle').count()).toBe(0);
  await actions.getByRole('button',{name:'Compose',exact:true}).click();
  await page.getByLabel('Compose text',{exact:true}).fill('Review this draft');
  const composer=page.locator('.terminal-compose');
  for(const name of ['Paste draft','Close composer']) {
    const button=composer.getByRole('button',{name,exact:true});
    expect(await button.textContent()).toBe(''); await expect(button.locator('svg')).toHaveCount(1);
  }
  if(phone){
    for(const width of [393,412]) for(const height of [844,420]){
      await page.setViewportSize({width,height});
      await expect(strip).toBeHidden();await expect(tabs).toBeHidden();await expect(restore).toBeHidden();
      expect((await header.boundingBox())!.height).toBe(44);
      expect((await page.locator('.session-body').boundingBox())!.y).toBe(44);
      const text=(await composer.getByRole('textbox',{name:'Compose text',exact:true}).boundingBox())!;
      const buttons=(await composer.locator('.terminal-compose-actions').boundingBox())!;
      expect(text.x+text.width).toBeLessThanOrEqual(buttons.x);
      expect(buttons.y+buttons.height).toBeLessThanOrEqual(height);
      const withKeys=(await page.locator('.terminal-canvas:visible').boundingBox())!.height;
      await actions.getByRole('button',{name:'Hide terminal keys',exact:true}).click();
      expect((await page.locator('.terminal-canvas:visible').boundingBox())!.height).toBeGreaterThan(withKeys);
      await actions.getByRole('button',{name:'Show terminal keys',exact:true}).click();
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
    await page.screenshot({path:testInfo.outputPath('compact-composer.png')});
    await composer.getByRole('button',{name:'Close composer',exact:true}).click();
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
    expect(await sessionViews.getByRole('button').allTextContents()).toEqual(['Terminal','Agents','Files','Sessions','Usage','Attach']);
    for(const button of await sessionViews.getByRole('button').all()){
      await button.scrollIntoViewIfNeeded();expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await openWorkspaceGroup(page,'more');
    const secondary=more.getByRole('navigation',{name:'More tools',exact:true});
    for(const button of await secondary.getByRole('button').all()){await button.scrollIntoViewIfNeeded();expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);}
    await openWorkspaceGroup(page,'more');
    await openWorkspaceGroup(page,'connections');
    await more.getByRole('button',{name:'New connection',exact:true}).click();
    await expect(more).toHaveCount(0);await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await expect(more.getByRole('button',{name:'End Focus workstation with a long host name connection',exact:true})).toBeVisible();
    await openWorkspaceGroup(page,'connections');
    await expect(more.getByRole('button',{name:'Restore previous workspace',exact:true})).toBeVisible();
    await more.getByRole('button',{name:'Dismiss',exact:true}).click();
    await expect(more.getByRole('region',{name:'Restore previous workspace',exact:true})).toHaveCount(0);
    await openWorkspaceGroup(page,'application');
    await more.getByRole('button',{name:'Preferences',exact:true}).click();
    await expect(page.getByRole('dialog',{name:'Preferences',exact:true})).toBeVisible();await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await more.getByRole('button',{name:'Attach',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Attach to this host',exact:true})).toBeVisible();
    await expect(strip).toBeHidden();await expect(tabs).toBeHidden();
    await page.getByRole('button',{name:'Return to terminal',exact:true}).click();
    await expect(strip).toBeHidden();expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('compact-terminal.png')});
  }else{
    await page.screenshot({path:testInfo.outputPath('desktop-composer.png')});
    await composer.getByRole('button',{name:'Close composer',exact:true}).click();
    await expect(header).toBeVisible();await expect(strip).toBeVisible();await expect(tabs).toBeVisible();await expect(restore).toBeVisible();
    expect((await header.boundingBox())!.height).toBe(63);
  }
  if(phone){
    await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
    await openWorkspaceGroup(page,'connections');
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

for(const action of ['dom','playwright'] as const)test(`live Herdr navigation stays touchable in a short drawer with ${action} actions`,async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await page.setViewportSize({width:phone?411:1280,height:phone?659:600});
  await installWorkspaceNavigation(page,true);
  await page.goto('/');
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  if(phone)await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  const agents=page.getByRole('button',{name:'Agents',exact:true});
  if(action==='dom')await agents.evaluate(node=>(node as HTMLElement).click());else await agents.click();
  const context='HERDR_'+'a'.repeat(32)+' / 1 / /tmp/lazysh-h-abcdef';
  const assets=new URL('../src-tauri/gen/android/app/src/androidTest/assets/',import.meta.url);
  const oracle=readFileSync(new URL('owned-visible-herdr.js',assets),'utf8');
  const viewport=readFileSync(new URL('owned-keyboard-viewport.js',assets),'utf8');
  await expect.poll(()=>page.evaluate(({oracle,context})=>new Function('document','context',oracle+";return ownedLiveHerdrNavigation(document,'default',context);")(document,context),{oracle,context})).toBe(true);
  const row=page.locator('.herdr-navigation:not([hidden]) .herdr-navigation-row');
  const original=await row.elementHandle();
  for(const height of (phone?[659,400]:[600])){
    await page.setViewportSize({width:phone?411:1280,height});
    await row.evaluate(node=>node.scrollIntoView());
    await expect.poll(()=>page.evaluate(({oracle,viewport,context})=>{
      const live=new Function('document','context',oracle+";return ownedLiveHerdrNavigation(document,'default',context);")(document,context);
      const card=document.querySelector('.herdr-navigation:not([hidden]) .herdr-navigation-row');
      const labels=[card?.querySelector('strong'),card?.querySelector(':scope > small'),card?.querySelector('span > small')];
      if(!live||!card||labels.some(label=>!label))return false;
      const ranges=labels.map(label=>{const range=document.createRange();range.selectNodeContents(label!);return range;});
      return new Function('viewport','rectangles',viewport+';return ownedKeyboardViewportContains(viewport,rectangles);')(window.visualViewport,[card.getBoundingClientRect(),...ranges.map(range=>range.getBoundingClientRect())])&&
        ranges.every((range,index)=>Array.from(range.getClientRects()).every(rect=>{const hit=document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2);return hit===labels[index]||labels[index]!.contains(hit);}));
    },{oracle,viewport,context})).toBe(true);
    expect(await original!.evaluate(node=>node.isConnected&&node===document.querySelector('.herdr-navigation-row'))).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`herdr-drawer-${height}.png`)});
  }
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['herdr_chat','write_stdin','attach_multiplexer','herdr_action'].includes(command)))).toEqual([]);
});


test('empty Activity opens inspected hook repair without inventing reports',async({page},testInfo)=>{
  await installWorkspaceNavigation(page,true);
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  const board=page.getByRole('region',{name:'Agent activity',exact:true});
  await expect(board.getByRole('button',{name:'Setup',exact:true})).toHaveAttribute('aria-expanded','false');
  await board.getByRole('button',{name:'Agent hook setup',exact:true}).click();
  const provider=board.getByRole('combobox',{name:'Hook provider',exact:true});
  const setup=board.locator('details.companion-install[aria-label="Agent hook setup"] > summary');
  await expect(setup).toBeFocused();await expect(setup).toBeInViewport();
  const actions=()=>page.evaluate(()=>(window as unknown as {workspaceNavigationState:{hookActions:string[]}}).workspaceNavigationState.hookActions);
  expect(await actions()).toEqual([]);
  await expect(board.getByRole('button',{name:'Install or update hooks',exact:true})).toHaveCount(0);
  await expect(provider).toHaveValue('');
  const detected=board.getByRole('list',{name:'Detected host agents',exact:true});
  const codex=detected.getByRole('button',{name:/Codex.*Installed executable/});
  await expect(codex).toHaveAttribute('aria-pressed','false');
  await expect(detected.getByRole('button',{name:/Claude Code.*Executable not detected/})).toBeEnabled();
  await expect(detected.getByRole('button',{name:/Cline.*Manual setup/})).toBeDisabled();
  await expect(detected.getByRole('button',{name:/Aider.*Callback health only/})).toBeDisabled();
  await expect(board.getByRole('button',{name:'Inspect setup',exact:true})).toBeDisabled();
  expect(await detected.getByRole('listitem').count()).toBeGreaterThanOrEqual(6);
  expect(await detected.evaluate(node=>node.scrollHeight>node.clientHeight&&node.clientHeight<=260)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('detected-agent-list.png')});
  await codex.click();await expect(provider).toHaveValue('codex');
  await expect(board.getByRole('button',{name:'Inspect setup',exact:true})).toBeFocused();
  await expect(board.getByRole('button',{name:'Inspect setup',exact:true})).toBeInViewport({ratio:1});
  await expect(board.getByLabel('Host profile directory',{exact:true})).toHaveValue('/owned/profile');
  expect(await actions()).toEqual([]);
  for(const row of await detected.getByRole('button').all())expect((await row.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:testInfo.outputPath('detected-agent-selection.png')});
  await board.getByRole('button',{name:'Inspect setup',exact:true}).click();
  await expect(board.getByText('Hooks need setup or repair.',{exact:true})).toBeVisible();
  expect(await actions()).toEqual(['status']);
  await board.getByRole('button',{name:'Install or update hooks',exact:true}).click();
  await expect(board.getByText('Hooks configured. Live reporting has not been verified.',{exact:true})).toBeVisible();
  await expect(board.getByText('Start a new Codex session with this profile, open /hooks to review the lazysh hooks, then start a turn. Disabled hooks stay disabled.',{exact:true})).toBeVisible();
  expect(await actions()).toEqual(['status','install','status']);
  await expect(board.locator('.agent-card')).toHaveCount(0);
  expect(await board.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  const source=await page.request.get('/src/AgentPanel.tsx');
  expect(await source.text()).toContain('setHookSetupRequest');
  await page.screenshot({path:testInfo.outputPath('empty-activity-hook-setup.png')});
});

test('usage returns to its exact terminal and Agents context without expanding mobile chrome',async({page},testInfo)=>{
  await installWorkspaceNavigation(page);
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  const canvas=page.locator('.terminal-canvas').first();const original=await canvas.elementHandle();
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await page.getByRole('textbox',{name:'Compose text',exact:true}).fill('owned retained terminal draft');
  await page.getByRole('button',{name:'Open AI account usage',exact:true}).click();
  const context=page.getByRole('navigation',{name:'Tool navigation',exact:true});
  await expect(context).toBeVisible();
  await expect(page.getByRole('region',{name:'AI account usage',exact:true})).toBeVisible();
  if(testInfo.project.name==='phone'){
    await expect(page.locator('.session-toolbar')).toBeHidden();
    await expect(page.locator('.session-tabs')).toBeHidden();
    expect(await page.locator('.workspace-header').evaluate(node=>node.getBoundingClientRect().height)).toBeLessThanOrEqual(45);
  }
  await page.screenshot({path:testInfo.outputPath('contextual-usage.png')});
  await context.getByRole('button',{name:'Back',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Compose text',exact:true})).toHaveValue('owned retained terminal draft');
  expect(await canvas.evaluate((node,prior)=>node===prior,original)).toBe(true);
  await page.getByRole('button',{name:'Close composer',exact:true}).click();
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const sidebar=page.getByRole('complementary',{name:'Hosts and connections',exact:true});
  await sidebar.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await sidebar.getByRole('button',{name:'Open usage from navigation',exact:true}).click();
  await context.getByRole('button',{name:'Back',exact:true}).click();
  await expect(sidebar.getByRole('button',{name:'Agents navigation',exact:true})).toHaveAttribute('aria-current','page');
  await expect.poll(async()=>{const bounds=await sidebar.boundingBox();return !!bounds&&bounds.x>=0&&bounds.x+bounds.width<=page.viewportSize()!.width;}).toBe(true);
  const calls=await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls);
  expect(calls.filter(command=>command==='connect')).toHaveLength(1);
  expect(calls.filter(command=>command==='disconnect'||command==='write_stdin')).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('contextual-back-agents.png')});
});

for(const shorter of [false,true])test(`Activity scroll returns to the same mobile drawer owner (shorter=${shorter})`,async({page},testInfo)=>{
  test.skip(shorter && testInfo.project.name!=='phone','Mobile restoration clamp');
  await openClockedNavigation(page);const phone=testInfo.project.name==='phone';
  if(phone)await page.setViewportSize({width:393,height:852});
  await page.evaluate(()=>{const state=(window as unknown as {workspaceNavigationState:{installed:boolean;agentCount:number}}).workspaceNavigationState;state.installed=true;state.agentCount=80;});
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);if(phone)await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  const sidebar=page.getByRole('complementary',{name:'Hosts and connections',exact:true});
  const scroller=sidebar.locator('.workspace-navigation-scroll'),board=sidebar.getByRole('region',{name:'Agent activity',exact:true});
  await expect(sidebar.locator('.herdr-navigation-row')).toHaveCount(80);
  await expect(board.getByText('Reported work',{exact:true})).toHaveCount(1);
  const original=await board.elementHandle();await board.getByRole('heading',{name:'Agent activity',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('activity-before-usage.png'),animations:'disabled'});
  const before=await scroller.evaluate(node=>node.scrollTop);expect(before).toBeGreaterThan(2000);
  await sidebar.getByRole('button',{name:'Open usage from navigation',exact:true}).click();
  if(shorter)await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{agentCount:number}}).workspaceNavigationState.agentCount=1;});
  await page.getByRole('navigation',{name:'Tool navigation',exact:true}).getByRole('button',{name:'Back',exact:true}).click();
  await expect(sidebar.locator('.herdr-navigation-row')).toHaveCount(shorter?1:80);
  const after=await scroller.evaluate(node=>node.scrollTop),retained=await original!.evaluate(node=>node.isConnected);
  console.log(JSON.stringify({project:testInfo.project.name,before,after,retained}));
  await page.screenshot({path:testInfo.outputPath('activity-after-return.png'),animations:'disabled'});
  expect(retained).toBe(true);expect(after).toBe(shorter?await scroller.evaluate((node,top)=>Math.min(top,node.scrollHeight-node.clientHeight),before):before);
});


for(const empty of [false,true])test(`top Activity jump reaches ${empty?'empty':'reported'} activity behind many live agents without changing owners`,async({page},testInfo)=>{
  await openClockedNavigation(page);
  const phone=testInfo.project.name==='phone';if(phone)await page.setViewportSize({width:393,height:852});
  await page.evaluate(empty=>{const state=(window as unknown as {workspaceNavigationState:{installed:boolean;agentCount:number;empty:boolean}}).workspaceNavigationState;state.installed=true;state.agentCount=80;state.empty=empty;},empty);
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  const canvas=page.locator('.terminal-canvas').first(),originalCanvas=await canvas.elementHandle();
  if(phone)await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await page.getByRole('button',{name:'Agents',exact:true}).click();
  const sidebar=page.getByRole('complementary',{name:'Hosts and connections',exact:true});
  const jumps=sidebar.getByRole('navigation',{name:'Agent sections',exact:true});
  const activity=sidebar.getByRole('group',{name:'Reported agent activity',exact:true});
  const board=activity.getByRole('region',{name:'Agent activity',exact:true}),originalBoard=await board.elementHandle();
  const live=sidebar.getByRole('region',{name:'Herdr navigation',exact:true});
  await expect(live.locator('.herdr-navigation-row')).toHaveCount(80);
  await expect(live).toHaveAttribute('aria-busy','false');await expect(board.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  if(empty)await expect(board.getByRole('button',{name:'Agent hook setup',exact:true})).toHaveCount(1);
  else await expect(board.getByText('Reported work',{exact:true})).toHaveCount(1);
  const scroller=sidebar.locator('.workspace-navigation-scroll');
  await expect(board.getByRole('heading',{name:'Agent activity',exact:true})).not.toBeInViewport();
  const calls=()=>page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls);
  const before=await calls(),windowScroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
  const jumpActivity=jumps.getByRole('button',{name:'Reported agent activity',exact:true});
  await expect(jumpActivity).toBeInViewport({ratio:0.9});
  if(phone)await jumpActivity.tap();else{await jumpActivity.focus();await page.keyboard.press('Enter');}
  await expect(activity).toBeFocused();await expect(board.getByRole('heading',{name:'Agent activity',exact:true})).toBeInViewport({ratio:0.9});
  expect(await scroller.evaluate(node=>node.scrollTop)).toBeGreaterThan(2000);
  expect(await page.evaluate(()=>({x:scrollX,y:scrollY}))).toEqual(windowScroll);expect(await calls()).toEqual(before);
  await expect(jumps.getByRole('button',{name:'Live Herdr agents',exact:true})).toBeInViewport({ratio:0.9});
  await page.screenshot({path:testInfo.outputPath('direct-activity.png'),animations:'disabled'});
  const search=board.getByRole('searchbox',{name:'Search reported agents',exact:true});await search.fill('/nav');
  await board.getByRole('button',{name:'Setup',exact:true}).click();
  const settings=board.getByRole('checkbox',{name:'Recorded usage inspection',exact:true});await settings.uncheck();
  await board.getByRole('button',{name:'Setup',exact:true}).click();
  await jumps.getByRole('button',{name:'Live Herdr agents',exact:true}).click();
  await expect(sidebar.getByRole('group',{name:'Live Herdr agents',exact:true})).toBeFocused();
  expect(await scroller.evaluate(node=>node.scrollTop)).toBe(0);
  await expect(live.locator('.herdr-navigation-row').first()).toBeInViewport({ratio:0.75});
  await jumpActivity.click();await expect(search).toHaveValue('/nav');
  await sidebar.getByRole('button',{name:'Open usage from navigation',exact:true}).click();
  await page.getByRole('navigation',{name:'Tool navigation',exact:true}).getByRole('button',{name:'Back',exact:true}).click();
  await expect(sidebar.getByRole('button',{name:'Agents navigation',exact:true})).toHaveAttribute('aria-current','page');
  // The independent #665 restoration preserves the offset; jump controls remain directly reachable.
  await expect(jumpActivity).toBeInViewport({ratio:0.9});await expect(search).toHaveValue('/nav');
  await jumpActivity.click();
  await board.getByRole('button',{name:'Setup',exact:true}).click();await expect(settings).not.toBeChecked();
  expect(await originalBoard!.evaluate(node=>node.isConnected)).toBe(true);expect(await originalCanvas!.evaluate(node=>node.isConnected)).toBe(true);
  const after=await calls();expect(after.filter(command=>['disconnect','write_stdin','install_companion','companion_hooks','attach_multiplexer','herdr_action'].includes(command))).toEqual([]);
  expect(after.filter(command=>command==='connect')).toHaveLength(1);
  expect(after.filter(command=>command==='get_companion_settings')).toHaveLength(before.filter(command=>command==='get_companion_settings').length);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('Workspace tools is a short default sheet with explicit reachable expansions at 393px',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Measured mobile sheet');
  await page.setViewportSize({width:393,height:852});
  await installWorkspaceNavigation(page);await page.goto('/');
  await page.getByRole('button',{name:'Open hosts',exact:true}).click();await connectPasswordHost(page);
  const canvas=page.locator('.terminal-canvas:visible');
  await expect(canvas).toHaveCount(1);await expect(canvas.locator('.xterm-screen')).toBeVisible();
  await expect(page.getByText('Opening terminal…',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Workspace tools',exact:true});
  const primary=dialog.getByRole('navigation',{name:'Session views',exact:true});
  await expect(primary.getByRole('button')).toHaveText(['Terminal','Agents','Files','Sessions','Usage','Attach']);
  await expect(dialog.locator('details[open]')).toHaveCount(0);
  const metrics=await dialog.evaluate(node=>({height:node.getBoundingClientRect().height,content:node.scrollHeight,viewport:node.clientHeight}));
  expect(metrics.height).toBeLessThan(600);expect(metrics.content).toBeLessThanOrEqual(metrics.viewport+1);
  const end=dialog.getByRole('button',{name:'End Navigation host connection',exact:true});
  for(const target of [...await primary.getByRole('button').all(),end]){
    const box=(await target.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(852);
    expect(await target.evaluate(node=>{const box=node.getBoundingClientRect();return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('button')===node;})).toBe(true);
  }
  await page.screenshot({path:testInfo.outputPath('workspace-tools-default-393.png')});
  await testInfo.attach('default-sheet-measurement',{body:JSON.stringify({viewport:{width:393,height:852},...metrics}),contentType:'application/json'});
  for(const group of ['more','connections','application'] as const)await openWorkspaceGroup(page,group);
  await expect(dialog.getByRole('button',{name:'Transcript',exact:true})).toBeVisible();
  await page.setViewportSize({width:393,height:393});
  await dialog.evaluate(node=>{for(const control of node.querySelectorAll<HTMLElement>('button, summary'))control.style.fontSize='24px';});
  const content=dialog.locator('.workspace-tools-content');
  expect(await content.evaluate(node=>node.scrollHeight>node.clientHeight)).toBe(true);
  expect(await dialog.evaluate(node=>node.scrollHeight<=node.clientHeight+1)).toBe(true);
  await end.scrollIntoViewIfNeeded();await expect(end).toBeInViewport({ratio:1});
  expect((await end.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const close=dialog.getByRole('button',{name:'Close Workspace tools',exact:true});
  await expect(dialog.getByRole('heading',{name:'Workspace tools',exact:true})).toBeInViewport({ratio:.9});
  await expect(close).toBeInViewport({ratio:.9});
  await page.screenshot({path:testInfo.outputPath('workspace-tools-expanded-short-large-text.png')});
  await close.click();await expect(dialog).toHaveCount(0);await expect(canvas).toHaveCount(1);
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await page.evaluate(()=>window.dispatchEvent(new Event('lazysh-workspace-back',{cancelable:true})));
  await expect(dialog).toHaveCount(0);await expect(canvas).toHaveCount(1);
  const calls=await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls);
  expect(calls.filter(command=>command==='disconnect'||command==='write_stdin')).toEqual([]);
});

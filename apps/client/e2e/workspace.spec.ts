import {workspaceControl,openPreferenceCategory,closePreferences,openToolsPageWith} from './fixtures/workspaceControl';
import {controlContrast} from './fixtures/controlContrast';
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

const toolPageNames={session:'Session views',more:'More tools',connections:'Connections',application:'Application options'};
async function openWorkspaceGroup(page:Page,group:keyof typeof toolPageNames){
  const dialog=page.getByRole('dialog',{name:'Workspace tools',exact:true});
  await expect(dialog).toBeVisible();
  const tab=dialog.getByRole('tab',{name:toolPageNames[group],exact:true});
  // Without a session the sheet has one page and no page tabs.
  if(!await tab.count())return;
  await tab.click();await expect(tab).toHaveAttribute('aria-selected','true');
}

async function installWorkspaceNavigation(page:Page,geometry=false,sessionNames?:string[]){
  await installNativeBridge(page);
  await page.clock.install();
  await page.addInitScript(({geometry,sessionNames})=>{
    const calls:string[]=[];const state={updated:false,installed:false,missing:false,holdTree:false,holdReport:false,connects:0,agentCount:1,visualStates:false,reportCount:1,empty:false,hooksConfigured:false,hookDiscoveryVersions:[] as number[],hookActions:[] as string[],navigations:[] as unknown[]};Object.assign(window,{workspaceNavigationCalls:calls,workspaceNavigationState:state});
    window.nativeFixtureInvoke=async(command,args={})=>{
      calls.push(command);
      if(command==='list_hosts'){const hosts=[{id:'nav-host',name:'Navigation host',hostname:'fixture.invalid',username:'fixture',port:22},{id:'other-nav-host',name:'Other navigation host',hostname:'other-fixture.invalid',username:'fixture',port:22}];return sessionNames?sessionNames.map((name,index)=>({...hosts[index%2],id:`crowded-host-${index}`,name})):hosts;}
      if(command==='local_capability')return {available:false,reason:'Synthetic SSH UI fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect'){const index=++state.connects;return {sessionId:index===1?'owned-navigation-ssh':index===2||!sessionNames?'other-navigation-ssh':`additional-navigation-ssh-${index}`};}
      if(command==='attach_multiplexer'){if(args.sessionId!=='owned-navigation-ssh'||args.kind!=='herdr'||args.name!=='default')throw new Error('Wrong Herdr adoption target');return {sessionId:'owned-navigation-herdr'};}
      if(command==='herdr_action'){if(args.sessionId!=='owned-navigation-herdr'||args.name!=='default')throw new Error('Wrong Herdr display');state.navigations.push(args.action);return;}
      if(command==='multiplexer_sessions')return [{name:'default'}];
      if(command==='herdr_tree'){const tree={workspaces:[{workspace_id:'w1',label:geometry?'HERDR_'+'a'.repeat(32):'Development',focused:true,agent_status:geometry?'unknown':'idle'}],tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:geometry?'1':'Codex tasks',number:1,focused:true,agent_status:geometry?'unknown':'idle'}],panes:[{focused:true,agent_status:geometry?'unknown':'idle',pane_id:'w1:p1',workspace_id:'w1',tab_id:'w1:t1',terminal_id:'codex-terminal',cwd:geometry?'/tmp/lazysh-h-abcdef':'/nav/codex'}],agents:[{terminal_id:'codex-terminal',workspace_id:'w1',tab_id:'w1:t1',pane_id:'w1:p1',name:geometry?null:'codex-builder',agent:'codex',agent_status:geometry?'unknown':'idle',agent_session:{source:'herdr:codex',agent:'codex',kind:'id',value:'r'.repeat(256)}}]};if(state.agentCount>1){
        const pane=tree.panes[0],agent=tree.agents[0];
        tree.panes=Array.from({length:state.agentCount},(_,i)=>({...pane,pane_id:`w1:p${i+1}`,terminal_id:`codex-terminal-${i+1}`,focused:i===0}));
        tree.agents=tree.panes.map((pane,i)=>({...agent,pane_id:pane.pane_id,terminal_id:pane.terminal_id,name:`codex-builder-${i+1}`}));
      }if(state.visualStates){tree.agents=tree.agents.map((agent,index)=>({...agent,agent_status:index%3===0?'blocked':index%3===1?'working':'done'}));tree.panes=tree.panes.map((pane,index)=>({...pane,agent_status:tree.agents[index].agent_status}));}if(state.holdTree)return new Promise(resolve=>{Object.assign(window,{finishHerdrRead:()=>{state.holdTree=false;resolve(tree);}});});return tree;}
      if(command==='agent_snapshot' && state.missing)throw new Error('Owned fixture companion unavailable');
      if(command==='install_companion'){
        if(args.sessionId!=='owned-navigation-ssh'||Object.keys(args).sort().join(',')!=='progress,sessionId')throw new Error('Unexpected installer arguments');
        const status=state.installed?'reused':'installed';(args.progress as {onmessage:(value:unknown)=>void}).onmessage({stage:'checkingInstalled'});state.installed=true;
        return {schemaVersion:1,status,version:'1.0.0',path:'/owned/lazysh/companion/lazysh-agent',cleanup:'complete'};
      }
      if(command==='agent_snapshot'){
        if(geometry || state.empty)return {schemaVersion:1,sessions:[]};
        if(!state.installed)throw {message:'Synthetic missing host companion'};
        if(args.sessionId==='other-navigation-ssh')return {schemaVersion:1,sessions:[]};
        const report={schemaVersion:1,sessions:[{sessionId:'r'.repeat(256),agent:'Codex',project:'/nav/project',state:'working',updatedAt:'2026-10-29T12:00:00Z',summary:state.updated?'Refreshed work':'Reported work',paneId:'%7',eventCount:3}]};
        if(state.holdReport)return new Promise(resolve=>{Object.assign(window,{finishOldReport:()=>{state.holdReport=false;resolve(report);}});});
        return {...report,sessions:Array.from({length:Math.min(80,Math.max(1,state.reportCount))},(_,index)=>({...report.sessions[0],sessionId:index===0?report.sessions[0].sessionId:`owned-report-${index}`,project:index===0?report.sessions[0].project:`/nav/project-${index}`}))};
      }
      if(command==='companion_hook_discovery'){
        const schemaVersion=args.schemaVersion===undefined?1:args.schemaVersion;
        if(args.sessionId!=='owned-navigation-ssh'||Object.keys(args).some(key=>!['sessionId','schemaVersion'].includes(key))||(schemaVersion!==1&&schemaVersion!==2&&schemaVersion!==3))throw new Error('Wrong discovery source');
        state.hookDiscoveryVersions.push(schemaVersion);
        return {schemaVersion,supported:true,managedSetupSupported:true,truncated:false,agents:[
          {agent:'codex',setup:'managed',executable:{path:'/owned/bin/codex',source:'path'},profiles:[{path:'/owned/profile',source:'CODEX_HOME',state:'directory'}]},
          {agent:'claude',setup:'managed',executable:null,profiles:[{path:'/owned/other-profile',source:'default',state:'directory'}]},
          ...['droid','gemini','cursor','opencode','cline'].map(agent=>({agent,setup:'managed',executable:{path:`/owned/bin/${agent}`,source:'path'},profiles:[{path:`/owned/${agent} profile`,source:'HOME',state:'directory'}]})),
          {agent:'kimi',setup:'manual',executable:{path:'/owned/bin/kimi',source:'path'},profiles:[]},
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
  },{geometry,sessionNames});
}

async function openClockedNavigation(page:Page) {
  await page.clock.install();await installWorkspaceNavigation(page);await page.goto('/');
}

async function connectPasswordHost(page:Page,name='Navigation host'){
  await page.getByRole('button',{name:`Connect to ${name}`,exact:true}).click();
  await page.getByRole('textbox',{name:'Password',exact:true}).fill('synthetic-only');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
}

async function openConnectedAgents(page:Page,phone:boolean){
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await (await workspaceControl(page,'Agents' )).click();
}

async function selectAgentSection(page:Page,section:'live'|'activity') {
  await page.getByRole('navigation',{name:'Agent sections',exact:true}).getByRole('button',{name:section==='live'?'Live Herdr agents':'Reported agent activity',exact:true}).click();
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
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
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
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['agent_snapshot','agent_approvals','get_companion_settings','board_keep_awake_status'].includes(command)))).toEqual([]);
  await (await workspaceControl(page,'Agents' )).click();
  await selectAgentSection(page,'activity');
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
  await selectAgentSection(page,'live');
  const live=page.getByRole('region',{name:'Herdr navigation',exact:true});
  await expect(live.getByText('codex-builder',{exact:true})).toBeVisible();
  const serverSetup=live.locator('.herdr-server-setup');
  await expect(serverSetup).toBeHidden();
  await expect(live.getByRole('combobox',{name:'Herdr server',exact:true})).toBeHidden();
  await live.getByRole('button',{name:'Herdr server',exact:true}).click();
  await expect(live.getByRole('combobox',{name:'Herdr server',exact:true})).toHaveValue('default');
  await live.getByRole('button',{name:'Back',exact:true}).click();
  if(phone){
    await page.setViewportSize({width:393,height:852});
    const navigation=await page.locator('.sidebar').boundingBox();
    expect(navigation?.x).toBe(0);expect(navigation?.width).toBe(393);
    const actions=live.locator('header button:visible');
    for(const action of await actions.all()){
      const bounds=(await action.boundingBox())!;
      expect(bounds.width).toBeGreaterThanOrEqual(44);expect(bounds.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.locator('.workspace-navigation-scroll').evaluate(node=>{node.scrollTop=0;});
  const firstLiveAgent=live.getByRole('button',{name:/^codex-builder/});
  await expect(firstLiveAgent).toBeInViewport({ratio:0.75});
  if(phone)expect((await firstLiveAgent.boundingBox())!.y).toBeLessThan(400);
  await page.screenshot({path:testInfo.outputPath('healthy-agents-first-row.png')});
  if(phone){
    for(const width of [320,600]){
      await page.setViewportSize({width,height:420});
      await live.evaluate(node=>{node.style.fontSize='20px';});
      await firstLiveAgent.scrollIntoViewIfNeeded();
      expect(await page.locator('.sidebar').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
      await expect(firstLiveAgent).toBeInViewport({ratio:0.75});
      await expect(page.getByRole('button',{name:'Return to terminal',exact:true})).toBeInViewport();
    }
    await live.evaluate(node=>{node.style.fontSize='';});
    await page.setViewportSize({width:393,height:852});
    await page.locator('.workspace-navigation-scroll').evaluate(node=>{node.scrollTop=0;});
    await page.emulateMedia({forcedColors:'active',reducedMotion:'reduce'});
    await expect(page.locator('.sidebar > .workspace-navigation-modes')).toHaveCSS('backdrop-filter','none');
    await expect(page.getByRole('button',{name:'Return to terminal',exact:true})).toBeVisible();
    await page.emulateMedia({forcedColors:'none',reducedMotion:'no-preference'});
    const protocol=await page.context().newCDPSession(page);
    await protocol.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:62,bottom:34}});
    expect((await page.getByRole('button',{name:'Return to terminal',exact:true}).boundingBox())!.y).toBeGreaterThanOrEqual(62);
    await expect(firstLiveAgent).toBeInViewport({ratio:0.75});
    await page.screenshot({path:testInfo.outputPath('agents-safe-area-393.png')});
    await protocol.send('Emulation.setSafeAreaInsetsOverride',{insets:{top:0,bottom:0}});
  }else{
    await page.setViewportSize({width:768,height:1024});
    const context=(await page.locator('.sidebar').boundingBox())!;
    expect(context.width).toBeGreaterThanOrEqual(300);expect(context.width).toBeLessThanOrEqual(420);
    expect((await page.locator('main.workspace').boundingBox())!.width).toBeGreaterThan(400);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('agents-tablet-768.png')});
    await page.setViewportSize({width:1280,height:850});
  }

  await expect(live.getByRole('heading',{name:'Idle · 1',exact:true})).toBeVisible();
  const details=live.locator('details').filter({has:page.getByText('Reported session',{exact:true})});
  await expect(details).not.toHaveAttribute('open');
  await details.locator('summary').click();
  await expect(details.getByText('/nav/project',{exact:true})).toBeVisible();
  await expect(details.getByText('Unverified reference; may be stale.',{exact:true})).toBeVisible();
  expect(await details.locator('..').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('herdr-reported-session.png')});
  await details.locator('summary').click();
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationState:{navigations:unknown[]}}).workspaceNavigationState.navigations)).toEqual([]);
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['herdr_action','herdr_chat','write_stdin','attach_multiplexer'].includes(command)))).toEqual([]);
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
  await selectAgentSection(page,'activity');
  await board.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(board.getByRole('alert')).toHaveText('Owned fixture companion unavailable');
  await selectAgentSection(page,'live');
  await expect(live.getByText('codex-builder',{exact:true})).toBeVisible();
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{missing:boolean}}).workspaceNavigationState.missing=false;});
  await selectAgentSection(page,'activity');
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
  if(phone)await page.getByRole('button',{name:'Return to terminal',exact:true}).click();
  else await modes.getByRole('button',{name:'Connections',exact:true}).click();
  await expect(board).toBeHidden();
  const commands=()=>page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['agent_snapshot','agent_approvals','get_companion_settings','board_keep_awake_status','multiplexer_sessions','herdr_tree'].includes(command)));
  const before=await commands();await page.clock.runFor(11000);expect(await commands()).toEqual(before);
  if(phone){await expect(page.getByRole('button',{name:'Open hosts',exact:true})).toBeFocused();await page.getByRole('button',{name:'Open hosts',exact:true}).click();}
  await modes.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await selectAgentSection(page,'activity');
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
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await selectAgentSection(page,'activity');
  await expect(board).toBeVisible();
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{holdReport:boolean}}).workspaceNavigationState.holdReport=true;});
  await selectAgentSection(page,'activity');
  await board.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof (window as unknown as {finishOldReport?:()=>void}).finishOldReport)).toBe('function');
  await modes.getByRole('button',{name:'Connections',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Other navigation host',exact:true}).click();
  await page.getByRole('textbox',{name:'Password',exact:true}).fill('synthetic-only');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await live.locator('.herdr-report-reference > summary').click();
  await expect(live.getByText('No matching report',{exact:true})).toBeVisible();
  await page.evaluate(()=>(window as unknown as {finishOldReport:()=>void}).finishOldReport());
  await expect(live.getByText('No matching report',{exact:true})).toBeVisible();
  await expect(live.locator('details').getByText('/nav/project',{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['herdr_chat','write_stdin'].includes(command)))).toEqual([]);
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{holdTree:boolean}}).workspaceNavigationState.holdTree=true;delete (window as unknown as {finishHerdrRead?:()=>void}).finishHerdrRead;});
  if(phone){
    await page.getByRole('button',{name:'Return to terminal',exact:true}).click();
    await page.getByRole('button',{name:'Switch terminal session',exact:true}).click();
    await page.getByRole('dialog',{name:'Switch terminal session',exact:true}).locator('.session-choice').filter({has:page.getByText('Navigation host',{exact:true})}).click();
  }else await page.getByRole('tab',{name:'Navigation host',exact:true}).click();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  await expect(live.getByLabel('Changes focus for other connections.',{exact:true})).toBeVisible();
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
  const closeHosts=nativeWorkspaceSource.match(/private fun endOwnedConnection[\s\S]*?val closeHosts = "([^"\n]+)"/)![1];
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
  for(const name of ['Send','Close composer']) {
    const button=composer.getByRole('button',{name,exact:true});
    expect(await button.textContent()).toBe(name==='Send'?'Send':''); await expect(button.locator('svg')).toHaveCount(1);
  }
  if(phone){
    for(const width of [393,412]) for(const height of [844,420]){
      await page.setViewportSize({width,height});
      await expect(strip).toBeHidden();await expect(tabs).toBeHidden();await expect(restore).toBeHidden();
      expect((await header.boundingBox())!.height).toBe(44);
      expect((await page.locator('.session-body').boundingBox())!.y).toBe(44);
      const buttons=(await composer.locator('.terminal-compose-actions').boundingBox())!;
      expect(buttons.y+buttons.height).toBeLessThanOrEqual(height);
    }
    await page.setViewportSize({width:393,height:844});
    await page.screenshot({path:testInfo.outputPath('compact-composer.png')});
    await composer.getByRole('button',{name:'Close composer',exact:true}).click();
    for(const width of [393,412]) for(const height of [844,420]){
      await page.setViewportSize({width,height});
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
    expect(await sessionViews.getByRole('button').allTextContents()).toEqual(['Workspaces','Terminal','Agents','Files','Sessions','Usage','Attach']);
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
    await openWorkspaceGroup(page,'session');
    await more.getByRole('button',{name:'Attach',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Attach to this host',exact:true})).toBeVisible();
    await expect(strip).toBeHidden();await expect(tabs).toBeHidden();
    await page.getByRole('button',{name:'Return to terminal',exact:true}).click();
    await expect(strip).toBeHidden();expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('compact-terminal.png')});
  }else{
    await page.screenshot({path:testInfo.outputPath('desktop-composer.png')});
    await composer.getByRole('button',{name:'Close composer',exact:true}).click();
    await expect(header).toBeVisible();await expect(strip).toHaveCount(0);await expect(tabs).toBeVisible();await expect(restore).toBeVisible();
    await expect(header.getByRole('button',{name:'Workspace tools',exact:true})).toBeVisible();
    expect((await header.boundingBox())!.height).toBe(54);
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
  await openConnectedWorkspaceTools(page,phone);
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
      const group=card?.closest('section[aria-label]');
      const labels=[card?.querySelector('strong'),group?.getAttribute('aria-label')===card?.querySelector(':scope > small')?.textContent?group?.querySelector(':scope > h4'):null,card?.querySelector('span > small')];
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
  await openConnectedAgents(page,testInfo.project.name==='phone');
  await selectAgentSection(page,'activity');
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
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationState:{hookDiscoveryVersions:number[]}}).workspaceNavigationState.hookDiscoveryVersions)).toEqual([3]);
  await expect(detected.getByRole('button',{name:/Claude Code.*Executable not detected/})).toBeEnabled();
  await expect(detected.getByRole('button',{name:/Kimi.*Manual setup/})).toBeDisabled();
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
  await page.evaluate(()=>{const state=(window as unknown as {workspaceNavigationState:{installed:boolean;agentCount:number;reportCount:number}}).workspaceNavigationState;state.installed=true;state.agentCount=80;state.reportCount=80;});
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await (await workspaceControl(page,'Agents' )).click();
  await selectAgentSection(page,'activity');
  const sidebar=page.getByRole('complementary',{name:'Hosts and connections',exact:true});
  const scroller=sidebar.locator('.workspace-navigation-scroll'),board=sidebar.getByRole('region',{name:'Agent activity',exact:true});
  await expect(sidebar.locator('.herdr-navigation-row')).toHaveCount(80);
  await expect(board.getByText('Reported work',{exact:true})).toHaveCount(80);
  const original=await board.elementHandle();await board.locator('.agent-report-row').last().scrollIntoViewIfNeeded();
  await page.screenshot({path:testInfo.outputPath('activity-before-usage.png'),animations:'disabled'});
  const before=await scroller.evaluate(node=>node.scrollTop);expect(before).toBeGreaterThan(2000);
  await sidebar.getByRole('button',{name:'Open usage from navigation',exact:true}).click();
  if(shorter)await page.evaluate(()=>{const state=(window as unknown as {workspaceNavigationState:{agentCount:number;reportCount:number}}).workspaceNavigationState;state.agentCount=1;state.reportCount=1;});
  await page.getByRole('navigation',{name:'Tool navigation',exact:true}).getByRole('button',{name:'Back',exact:true}).click();
  await expect(sidebar.locator('.herdr-navigation-row')).toHaveCount(shorter?1:80);
  const after=await scroller.evaluate(node=>node.scrollTop),retained=await original!.evaluate(node=>node.isConnected);
  console.log(JSON.stringify({project:testInfo.project.name,before,after,retained}));
  await page.screenshot({path:testInfo.outputPath('activity-after-return.png'),animations:'disabled'});
  expect(retained).toBe(true);expect(after).toBe(shorter?await scroller.evaluate((node,top)=>Math.min(top,node.scrollHeight-node.clientHeight),before):before);
});


for(const empty of [false,true])test(`Activity view reaches ${empty?'empty':'reported'} activity separately from many live agents without changing owners`,async({page},testInfo)=>{
  await openClockedNavigation(page);
  const phone=testInfo.project.name==='phone';if(phone)await page.setViewportSize({width:393,height:852});
  await page.evaluate(empty=>{const state=(window as unknown as {workspaceNavigationState:{installed:boolean;agentCount:number;empty:boolean}}).workspaceNavigationState;state.installed=true;state.agentCount=80;state.empty=empty;},empty);
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  const canvas=page.locator('.terminal-canvas').first(),originalCanvas=await canvas.elementHandle();
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await (await workspaceControl(page,'Agents' )).click();
  const sidebar=page.getByRole('complementary',{name:'Hosts and connections',exact:true});
  const jumps=sidebar.getByRole('navigation',{name:'Agent sections',exact:true});
  const activity=sidebar.getByRole('group',{name:'Reported agent activity',exact:true,includeHidden:true});
  const board=activity.getByRole('region',{name:'Agent activity',exact:true,includeHidden:true}),originalBoard=await board.elementHandle();
  const live=sidebar.getByRole('region',{name:'Herdr navigation',exact:true});
  await expect(live.locator('.herdr-navigation-row')).toHaveCount(80);
  await expect(live).toHaveAttribute('aria-busy','false');
  const scroller=sidebar.locator('.workspace-navigation-scroll');
  await expect(board.getByRole('heading',{name:'Agent activity',exact:true})).not.toBeInViewport();
  const calls=()=>page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls);
  const before=await calls(),windowScroll=await page.evaluate(()=>({x:scrollX,y:scrollY}));
  const jumpActivity=jumps.getByRole('button',{name:'Reported agent activity',exact:true});
  await expect(jumpActivity).toBeInViewport({ratio:0.9});
  if(phone)await jumpActivity.tap();else{await jumpActivity.focus();await page.keyboard.press('Enter');}
  await expect(activity).toBeFocused();await expect(sidebar.getByRole('heading',{name:'Agents',exact:true})).toBeInViewport({ratio:0.9});
  await expect(board.getByRole('searchbox',{name:'Search reported agents',exact:true})).toBeInViewport({ratio:0.9});
  expect(await scroller.evaluate(node=>node.scrollTop)).toBe(0);
  await expect(board.getByRole('button',{name:'Refresh',exact:true})).toBeEnabled();
  if(empty)await expect(board.getByRole('button',{name:'Agent hook setup',exact:true})).toHaveCount(1);
  else await expect(board.getByText('Reported work',{exact:true})).toHaveCount(1);
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

/** Host actions must be on screen, inside their list and own their centre without waiting for motion. */
function hostActionTargets(page:Page,labels:string[]) {
  return page.evaluate(labels=>labels.map(label=>{
    const button=document.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`)!,box=button.getBoundingClientRect(),list=button.closest('.host-list')!.getBoundingClientRect();
    const hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
    return {label,inList:box.left>=list.left&&box.right<=list.right,inViewport:box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight,size:box.width>=44&&box.height>=44,owned:hit===button||button.contains(hit),disabled:button.disabled};
  }),labels);
}
const touchable=(labels:string[])=>labels.map(label=>({label,inList:true,inViewport:true,size:true,owned:true,disabled:false}));

test('reopened phone hosts expose touchable host actions immediately and a closed drawer takes no hits',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone drawer geometry');
  await page.setViewportSize({width:412,height:915});
  await installWorkspaceNavigation(page);await page.goto('/');
  for(const name of ['Navigation host','Other navigation host']){await page.getByRole('button',{name:'Open hosts',exact:true}).click();await connectPasswordHost(page,name);}
  await expect(page.locator('.session-tabs [role=tab]')).toHaveCount(2);
  await (await workspaceControl(page,'End Other navigation host connection')).click();
  await expect(page.locator('.session-tabs [role=tab]')).toHaveCount(1);
  await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  // Sampled without waiting for motion.
  const labels=['Edit Navigation host','Edit Other navigation host','Delete Other navigation host'];
  expect(await hostActionTargets(page,labels)).toEqual(touchable(labels));
  await expect(page.getByRole('button',{name:'Delete Navigation host',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Delete Other navigation host',exact:true}).tap();
  const confirm=page.getByRole('dialog',{name:'Delete host',exact:true});
  await expect(confirm).toBeVisible();await page.keyboard.press('Escape');await expect(confirm).toHaveCount(0);
  await page.getByRole('button',{name:'Close hosts',exact:true}).tap();
  expect(await page.evaluate(()=>[0.25,0.5,0.9].every(fraction=>!document.elementFromPoint(innerWidth/2,innerHeight*fraction)?.closest('.sidebar')))).toBe(true);
  const calls=await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls);
  expect(calls.filter(command=>command==='delete_host'||command==='write_stdin')).toEqual([]);
});

test('a long saved host keeps its actions touchable after a fresh load at the Android emulator viewport',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone drawer geometry');
  const name='Instrumentation 3f6c2b8e-4d71-4f0a-9a52-7c1e0b9d4e21';
  await page.setViewportSize({width:411,height:731});
  await installWorkspaceNavigation(page,false,[name]);await page.goto('/');await page.reload();
  await expect(page.getByRole('button',{name:`Connect to ${name}`,exact:true})).toBeAttached();
  await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const labels=[`Edit ${name}`,`Delete ${name}`];
  expect(await hostActionTargets(page,labels)).toEqual(touchable(labels));
  await page.getByRole('button',{name:`Delete ${name}`,exact:true}).tap();
  await expect(page.getByRole('dialog',{name:'Delete host',exact:true})).toBeVisible();
});

/** Connect the fixture host from the real host list and open Workspace tools over its terminal. */
async function openConnectedWorkspaceTools(page:Page,phone:boolean){
  await page.goto('/');
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
}

/** No page turn or sheet action may disconnect the session or type into its terminal. */
async function expectNoTerminalInput(page:Page){
  const calls=await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls);
  expect(calls.filter(command=>command==='disconnect'||command==='write_stdin')).toEqual([]);
}

/** Drag across the tool pages with a finger on a phone and with the mouse on desktop. */
async function swipeToolPages(page:Page,direction:'next'|'previous',phone:boolean){
  const box=(await page.locator('.workspace-tools-track').boundingBox())!;
  const y=box.y+Math.min(box.height/2,60),[from,to]=direction==='next'?[.85,.15]:[.15,.85];
  const at=(fraction:number)=>({x:box.x+box.width*fraction,y});
  if(!phone){
    await page.mouse.move(at(from).x,y);await page.mouse.down();
    for(let step=1;step<=8;step++)await page.mouse.move(at(from+(to-from)*step/8).x,y);
    await page.mouse.up();return;
  }
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[at(from)]});
  for(let step=1;step<=12;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[at(from+(to-from)*step/12)]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await cdp.detach();
}

test('Workspace tools swipe between labelled carousel pages and remember the last page',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await installWorkspaceNavigation(page);
  await openConnectedWorkspaceTools(page,phone);
  const dialog=page.getByRole('dialog',{name:'Workspace tools',exact:true});
  const carousel=dialog.getByRole('region',{name:'Workspace tool pages',exact:true});
  await expect(carousel).toHaveAttribute('aria-roledescription','carousel');
  const tabs=carousel.getByRole('tablist',{name:'Workspace tool pages',exact:true}).getByRole('tab');
  await expect(tabs).toHaveCount(4);
  expect(await tabs.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-label')))).toEqual(['Session views','More tools','Connections','Application options']);
  const panel=carousel.getByRole('tabpanel');
  const shows=async(label:string,selected:number)=>{
    await expect(panel).toHaveCount(1);await expect(panel).toHaveAttribute('aria-label',label);
    await expect(panel).toHaveAttribute('aria-roledescription','page');
    expect(await tabs.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-selected')))).toEqual([0,1,2,3].map(index=>String(index===selected)));
    await expect(carousel.getByRole('heading',{name:label.split(',')[0],exact:true})).toBeVisible();
    // The shown page fills the track, so no other page can be tapped by accident.
    await expect.poll(()=>panel.evaluate(node=>{const page=node.getBoundingClientRect(),track=node.parentElement!.getBoundingClientRect();return Math.abs(page.left-track.left)<2&&Math.abs(page.right-track.right)<2;})).toBe(true);
  };
  await shows('Session views, 1 of 4',0);
  await expect(dialog.getByRole('button',{name:'Transcript',exact:true})).toHaveCount(0);
  await expect(carousel.getByRole('button',{name:'Previous tools page',exact:true})).toBeDisabled();
  for(const target of [...await tabs.all(),carousel.getByRole('button',{name:'Next tools page',exact:true})]){
    const box=(await target.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.width).toBeGreaterThanOrEqual(24);
  }
  await swipeToolPages(page,'next',phone);
  await shows('More tools, 2 of 4',1);
  const transcript=dialog.getByRole('button',{name:'Transcript',exact:true});
  await expect(transcript).toBeInViewport({ratio:1});
  await swipeToolPages(page,'next',phone);
  await shows('Connections, 3 of 4',2);
  await swipeToolPages(page,'previous',phone);
  await shows('More tools, 2 of 4',1);
  await page.screenshot({path:testInfo.outputPath('workspace-tools-carousel.png')});
  // Arrow keys move between page tabs, with focus following the selected page.
  await tabs.nth(1).focus();await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(2)).toBeFocused();await shows('Connections, 3 of 4',2);
  await page.keyboard.press('End');await expect(tabs.nth(3)).toBeFocused();await shows('Application options, 4 of 4',3);
  await expect(carousel.getByRole('button',{name:'Next tools page',exact:true})).toBeDisabled();
  await carousel.getByRole('button',{name:'Previous tools page',exact:true}).click();await shows('Connections, 3 of 4',2);
  await tabs.nth(1).click();await shows('More tools, 2 of 4',1);
  await transcript.click();await expect(dialog).toHaveCount(0);
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await shows('More tools, 2 of 4',1);
  await expect(transcript).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expectNoTerminalInput(page);
});

test('Workspace tools is a short default sheet whose tool pages stay reachable at 393px',async({page},testInfo)=>{
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
  await expect(primary.getByRole('button')).toHaveText(['Workspaces','Terminal','Agents','Files','Sessions','Usage','Attach']);
  await expect(dialog.locator('details')).toHaveCount(0);
  const metrics=await dialog.evaluate(node=>({height:node.getBoundingClientRect().height,content:node.scrollHeight,viewport:node.clientHeight}));
  expect(metrics.height).toBeLessThan(600);expect(metrics.content).toBeLessThanOrEqual(metrics.viewport+1);
  const end=dialog.getByRole('button',{name:'End Navigation host connection',exact:true});
  for(const target of [...await primary.getByRole('button').all(),end]){
    const box=(await target.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(852);
    expect(await target.evaluate(node=>{const box=node.getBoundingClientRect();return document.elementFromPoint(box.x+box.width/2,box.y+box.height/2)?.closest('button')===node;})).toBe(true);
  }
  const contrast=await dialog.evaluate(controlContrast);
  expect(contrast.filter(item=>item.ratio<4.5)).toEqual([]);
  const material=await dialog.evaluate(node=>({background:getComputedStyle(node).backgroundColor,blur:getComputedStyle(node).backdropFilter}));
  expect(material.blur).toContain('blur(16px)');
  const media=await page.context().newCDPSession(page);
  await media.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-transparency',value:'reduce'}]});
  await expect(dialog).toHaveCSS('backdrop-filter','none');
  expect(await dialog.evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe(material.background);
  await media.send('Emulation.setEmulatedMedia',{features:[]});
  await page.screenshot({path:testInfo.outputPath('workspace-tools-default-393.png')});
  await testInfo.attach('default-sheet-measurement',{body:JSON.stringify({viewport:{width:393,height:852},...metrics}),contentType:'application/json'});
  await openWorkspaceGroup(page,'more');
  await expect(dialog.getByRole('button',{name:'Transcript',exact:true})).toBeInViewport({ratio:1});
  await openWorkspaceGroup(page,'application');
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
  await expectNoTerminalInput(page);
});

test('Workspaces prioritizes current app sessions and discloses healthy server setup',async({page},testInfo)=>{
  await openClockedNavigation(page);const phone=testInfo.project.name==='phone';
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  const original=await page.locator('.terminal-canvas:visible').elementHandle();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page,'Other navigation host');
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const modes=page.getByRole('navigation',{name:'Workspace navigation',exact:true});
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  const sessions=page.getByRole('group',{name:'Live app sessions',exact:true});
  const live=page.getByRole('region',{name:'Herdr navigation',exact:true});
  if(phone)await page.locator('.workspace-session-summary').click();
  await expect(sessions.getByRole('button')).toHaveCount(2);
  await page.evaluate(()=>(window as unknown as {workspaceNavigationState:{installed:boolean}}).workspaceNavigationState.installed=true);
  const activity=page.getByRole('region',{name:'Agent activity',exact:true,includeHidden:true});
  const reader=await activity.elementHandle(),terminal=await page.locator('.terminal-canvas:visible').elementHandle();
  await modes.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await selectAgentSection(page,'activity');
  const draft=activity.getByRole('searchbox',{name:'Search reported agents',exact:true});await draft.fill('preserved query');
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  expect(await reader!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await terminal!.evaluate(node=>node.isConnected)).toBe(true);
  await modes.getByRole('button',{name:'Agents navigation',exact:true}).click();
  await selectAgentSection(page,'activity');
  await expect(draft).toHaveValue('preserved query');
  expect(await reader!.evaluate(node=>node===document.querySelector('.agent-panel'))).toBe(true);
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  const first=sessions.getByRole('button').first(),second=sessions.getByRole('button').last();
  await expect(second).toHaveAttribute('aria-current','location');
  expect(await sessions.evaluate(node=>!!(node.compareDocumentPosition(document.querySelector('.herdr-navigation')!)&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  expect((await sessions.boundingBox())!.y).toBeLessThan((await live.boundingBox())!.y);
  await first.focus();await page.keyboard.press('Tab');await expect(second).toBeFocused();
  await page.keyboard.press('Tab');await expect(live.getByRole('button',{name:'Herdr server',exact:true})).toBeFocused();
  const setup=live.locator('.herdr-server-setup');
  await expect(setup).toBeHidden();
  await expect(live.getByRole('combobox',{name:'Herdr server',exact:true})).toBeHidden();
  const summary=live.getByLabel('Changes focus for other connections.',{exact:true});await expect(summary).toBeVisible();await summary.click();
  const warning=live.getByText('Shared focus changes focus for other connections to this server.',{exact:true});
  await expect(warning).toHaveCount(1);await expect(warning).toBeVisible();
  await page.keyboard.press('Escape');await expect(warning).toBeHidden();await expect(summary).toBeFocused();
  await summary.click();await expect(warning).toBeVisible();
  await live.getByRole('button',{name:'Herdr server',exact:true}).click();
  await expect(live.getByRole('combobox',{name:'Herdr server',exact:true})).toHaveValue('default');
  await expect(warning).toHaveCount(1);await live.getByRole('button',{name:'Back',exact:true}).click();
  await first.click();
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  await expect(sessions.getByRole('button').first()).toHaveAttribute('aria-current','location');
  await expect(live.getByText('fixture@fixture.invalid',{exact:true})).toBeVisible();
  const commands=await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls);
  expect(commands.filter(command=>command==='connect')).toHaveLength(2);
  expect(commands.filter(command=>['herdr_action','attach_multiplexer','write_stdin','disconnect'].includes(command))).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('workspace-session-priority.png')});
  await page.evaluate(()=>{
    const original=window.nativeFixtureInvoke;
    window.nativeFixtureInvoke=async(command,args)=>command==='multiplexer_sessions'?[{name:'default'},{name:'review'}]:original(command,args);
  });
  await live.getByRole('button',{name:'Refresh Herdr tree',exact:true}).click();
  const selector=live.getByRole('combobox',{name:'Herdr server',exact:true});
  await expect(setup).toBeVisible();
  await expect(selector).toBeVisible();await expect(selector).toHaveValue('');
  await expect(live.locator('.herdr-navigation-tree')).toHaveCount(0);await expect(warning).toHaveCount(0);
  await selector.selectOption('default');await expect(setup).toBeHidden();await expect(summary).toBeVisible();
  await page.evaluate(()=>{
    const original=window.nativeFixtureInvoke;
    Object.assign(window,{restoreNavigationReader:()=>{window.nativeFixtureInvoke=original;}});
    window.nativeFixtureInvoke=async(command,args)=>{if(command==='herdr_tree')throw new Error('Synthetic navigation unavailable');return original(command,args);};
  });
  await live.getByRole('button',{name:'Refresh Herdr tree',exact:true}).click();
  await expect(live.getByRole('status')).toContainText('Synthetic navigation unavailable');
  await expect(setup).toBeVisible();await expect(selector).toBeVisible();await expect(warning).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('workspace-unhealthy-setup.png')});
  await page.evaluate(()=>Reflect.get(window,'restoreNavigationReader')());
  await live.getByRole('button',{name:'Refresh Herdr tree',exact:true}).click();
  await expect(setup).toBeHidden();
  await page.getByRole('button',{name:'Open session manager',exact:true}).click();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  for(const [locale,action,status] of [
    ['pt-BR','Abrir gerenciador de sessões','O gerenciador de sessões está aberto na área de trabalho.'],
    ['es','Abrir gestor de sesiones','El gestor de sesiones está abierto en el área de trabajo.'],
    ['en','Open session manager','The session manager is open in the workspace.'],
  ]){
    await page.evaluate(async locale=>{const {uiI18n}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);},locale);
    await expect(page.getByRole('button',{name:action,exact:true})).toBeVisible();
    await expect(page.getByRole('status').filter({hasText:status})).toBeVisible();
  }
  for(const width of (phone?[320,600]:[768,1280])){
    await page.setViewportSize({width,height:420});
    await modes.evaluate(node=>{for(const button of node.querySelectorAll('button'))button.style.fontSize='20px';});
    expect(await modes.evaluate(node=>Array.from(node.querySelectorAll('button')).every(button=>{
      const bounds=button.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(button);
      return bounds.height>=44&&Array.from(range.getClientRects()).every(rect=>rect.left>=bounds.left&&rect.right<=bounds.right);
    }))).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});


function nativeCompanionReadiness(action:string,initialOutcome:string){
  const method=nativeWorkspaceSource.slice(nativeWorkspaceSource.indexOf('fun verifyCompanionInstallation()'));
  const panel=/val panel = "([^"]+)"/.exec(method)![1];
  const code=/val companionReadinessObservation = """([\s\S]*?)"""/.exec(method)![1];
  const visible=/private fun workspaceButtonVisible[^\n]* = """([\s\S]*?)"""/.exec(nativeWorkspaceSource)![1]
    .replace('${JSONObject.quote("$scope button")}',JSON.stringify(panel+' button')).replace('${JSONObject.quote(text)}',JSON.stringify(action));
  const values=[
    ['${JSONObject.quote(panel)}',JSON.stringify(panel)],['${JSONObject.quote("$panel > .tool-bar > button")}',JSON.stringify(panel+' > .tool-bar > button')],
    ['${workspaceButtonVisible(panel, action)}',visible],['${workspaceElementVisible(panel)}',nativeWorkspaceVisibility(panel)],
    ['${workspaceElementVisible("$panel > .tool-bar > button", true)}',nativeWorkspaceVisibility(panel+' > .tool-bar > button',true)],
    ['${JSONObject.quote(action)}',JSON.stringify(action)],['${JSONObject.quote(if(reused) "installed" else "idle")}',JSON.stringify(initialOutcome)],
    ...['phases','failures'].map(name=>['${JSONArray('+name+')}',JSON.stringify(JSON.parse('['+new RegExp('val '+name+' = setOf\\(([^)]*)\\)').exec(method)![1]+']'))])
  ];
  let expression=code;for(const [key,value] of values)expression=expression.split(key).join(value);
  return {panel,expression};
}

test('native companion action stays owned during installed and reused results',async({page},testInfo)=>{
  if(testInfo.project.name==='phone')await page.setViewportSize({width:411,height:659});
  await openClockedNavigation(page);
  await openConnectedAgents(page,testInfo.project.name==='phone');await page.clock.runFor(200);
  const nativeCaller=nativeWorkspaceSource.slice(nativeWorkspaceSource.indexOf('fun verifyCompanionInstallation()'));
  const activity=/val companionActivity = "([^"]+)"/.exec(nativeCaller)?.[1];
  if(activity)await page.locator(activity).click();
  await expect(page.locator(nativeCompanionReadiness('Install companion','idle').panel)).toBeVisible();
  const initial=nativeCompanionReadiness('Install companion','idle');
  await page.evaluate(()=>{
    const panel=document.querySelector('details.companion-install[data-install-outcome]')!;
    const foreign=panel.cloneNode(true) as HTMLDetailsElement;foreign.hidden=false;foreign.open=true;
    Object.assign(foreign.style,{position:'fixed',top:'0',left:'0',width:'160px',height:'120px',overflow:'hidden',zIndex:'10000'});
    document.body.append(foreign);Reflect.set(window,'nativeForeignCompanion',foreign);
    panel.closest<HTMLElement>('.workspace-navigation-agents')!.hidden=true;
  });
  await expect(page.locator('body > details.companion-install')).toBeVisible();
  expect(await page.evaluate(initial.expression)).toMatchObject({panelPresent:false,expectedActionVisible:false,matchingExpectedActionEnabled:false});
  await page.evaluate(()=>{document.querySelector<HTMLElement>('.workspace-navigation-agents')!.hidden=false;Reflect.get(window,'nativeForeignCompanion').remove();});
  await expect(page.locator(initial.panel)).toBeVisible();
  await page.evaluate(()=>{(window as unknown as {workspaceNavigationState:{holdReport:boolean}}).workspaceNavigationState.holdReport=true;});
  const records:unknown[]=[];
  for(const [action,before,after] of [['Install companion','idle','installed'],['Update companion','installed','reused']]){
    const contract=nativeCompanionReadiness(action,before);
    if(after==='reused'){
      await page.locator(contract.panel+' > .tool-bar > button').first().evaluate(button=>button.scrollIntoView());
      records.push({action:'before delayed readiness',observation:await page.evaluate(contract.expression)});
      await page.evaluate(()=>Reflect.get(window,'finishOldReport')());await page.clock.runFor(200);
      records.push({action:'after delayed readiness before rescroll',observation:await page.evaluate(contract.expression),geometry:await page.locator('details[data-install-outcome] > .tool-bar > button').evaluate(button=>({top:button.getBoundingClientRect().top,bottom:button.getBoundingClientRect().bottom,hit:document.elementFromPoint(button.getBoundingClientRect().left+button.getBoundingClientRect().width/2,button.getBoundingClientRect().top+button.getBoundingClientRect().height/2)?.tagName}))});
    }
    const button=page.getByRole('button',{name:action,exact:true});
    await expect(button).toBeEnabled();await button.scrollIntoViewIfNeeded();
    records.push({action,observation:await page.evaluate(contract.expression),matches:await page.locator(contract.panel+' > .tool-bar > button').count(),geometry:await button.evaluate(node=>{const r=node.getBoundingClientRect();const hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {top:r.top,bottom:r.bottom,hit:hit?.tagName,hitClass:hit?.getAttribute('class'),hitIsTarget:!!hit&&node.contains(hit),hitIsNavigation:!!hit?.closest('.workspace-navigation-modes')};})});
    await button.click();await page.clock.runFor(200);
    await expect(page.locator('details[data-install-outcome]')).toHaveAttribute('data-install-outcome',after);
  }
  await testInfo.attach('native-companion-ownership',{body:JSON.stringify(records),contentType:'application/json'});
  const actions=records.filter((record):record is {action:string;matches:number;observation:Record<string,unknown>}=>!!record&&typeof record==='object'&&'matches' in record);
  expect(actions).toHaveLength(2);
  for(const record of actions){
    expect(record.matches).toBe(1);
    expect(record.observation).toMatchObject({expectedActionVisible:true,matchingExpectedActionEnabled:true,outcomeExpected:true,
      panelPresent:true,panelVisible:true,detailsOpen:true,directActionPresent:true,directActionVisible:true,directActionEnabled:true,
      labelKind:record.action==='Install companion'?'install':'update',failure:'none'});
  }
  expect(await page.locator('.terminal-canvas').count()).toBe(1);
  expect(await page.locator('[role=tab]').count()).toBe(1);
});

for(const width of [393,1200])test(`sidebar mode labels stay whole and reachable at ${width}px with enlarged text`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:852});await page.goto('/');
  for(const locale of ['en','pt-BR','es']) {
    await (await workspaceControl(page,await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return t('appPreferences');}))).click();
    if(locale==='en') {
      await openPreferenceCategory(page,'Appearance');
      await page.locator('[data-settings-page="appearance"]').evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished));});
      await page.screenshot({path:testInfo.outputPath(`appearance-${width}.png`)});
    }
    await openPreferenceCategory(page,'Language');
    await page.locator('[data-settings-page="language"] select').selectOption(locale);
    await closePreferences(page);
    if(width<=600) {
      await page.locator('.mobile-menu:visible').click();
      const sidebar=page.locator('.sidebar');await expect(sidebar).toHaveClass(/sidebar-open/);
      await sidebar.evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished));});
    }
    const modes=page.locator('.workspace-navigation-modes');
    for(const enlarged of [false,true]) {
      const measurements=await modes.evaluate((node,enlarged)=>{
        const buttons=Array.from(node.querySelectorAll('button'));
        for(const button of buttons)button.style.fontSize=enlarged?'22px':'';
        return buttons.map(button=>{
          const box=button.getBoundingClientRect(),walker=document.createTreeWalker(button,NodeFilter.SHOW_TEXT);let splitWord=false;
          for(let text=walker.nextNode();text;text=walker.nextNode())for(const word of text.textContent!.matchAll(/\S+/g)) {
            const range=document.createRange();range.setStart(text,word.index!);range.setEnd(text,word.index!+word[0].length);
            if(range.getClientRects().length>1)splitWord=true;
          }
          return {text:button.textContent,splitWord,overflow:button.scrollWidth>button.clientWidth+1,height:box.height,width:box.width,left:box.left,right:box.right};
        });
      },enlarged);
      if(locale==='en'&&!enlarged)await page.screenshot({path:testInfo.outputPath(`navigation-${width}.png`)});
      expect(measurements).toHaveLength(3);
      for(const button of measurements) {
        expect(button.splitWord,`${locale} enlarged=${enlarged} ${button.text}`).toBe(false);
        expect(button.overflow,`${locale} ${button.text}`).toBe(false);
        expect(button.height).toBeGreaterThanOrEqual(44);expect(button.width).toBeGreaterThanOrEqual(44);expect(button.left).toBeGreaterThanOrEqual(0);expect(button.right).toBeLessThanOrEqual(width);
      }
      expect(await modes.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    }
    await modes.locator('button').evaluateAll(buttons=>buttons.forEach(button=>button.style.fontSize=''));
    if(await page.locator('.sidebar-close:visible').count())await page.locator('.sidebar-close:visible').click();
  }
});


test('a space menu in the real Workspaces sidebar closes alone on Escape and Android back',async({page},testInfo)=>{
  await openClockedNavigation(page);const phone=testInfo.project.name==='phone';
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  // A new desktop terminal takes focus once it is ready; let it settle so it cannot close the menu under test.
  if(!phone)await expect(page.getByRole('textbox',{name:'Terminal input',exact:true})).toBeFocused();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('navigation',{name:'Workspace navigation',exact:true}).getByRole('button',{name:'Workspaces',exact:true}).click();
  const live=page.getByRole('region',{name:'Herdr navigation',exact:true});
  const more=live.getByRole('button',{name:'More actions for Development',exact:true});
  const menu=page.getByRole('menu',{name:'More actions for Development',exact:true});
  for(const close of ['Escape','back'] as const) {
    await more.click();
    await expect(menu.getByRole('menuitem',{name:'New worktree from Development',exact:true})).toBeFocused();
    if(close==='Escape')await page.keyboard.press('Escape');
    else await page.evaluate(()=>window.dispatchEvent(new Event('lazysh-workspace-back',{cancelable:true})));
    await expect(menu,close).toHaveCount(0);
    await expect(live,close).toBeVisible();
    await expect(more,close).toBeFocused();await expect(more).toHaveAttribute('aria-expanded','false');
  }
  // With the menu closed, Escape keeps its sidebar meaning on phones.
  if(phone){await page.keyboard.press('Escape');await expect(live).toBeHidden();await expect(page.getByRole('button',{name:'Open hosts',exact:true})).toBeFocused();}
});

test('Workspaces keeps three long app sessions compact while mobile pane choices stay in view',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';await page.setViewportSize({width:phone?393:1200,height:852});
  const names=['Desktop development with a long connection name','Desktop development with a long connection name / review','Desktop development with a long connection name / review / agents'];
  await installWorkspaceNavigation(page,true,names);await page.goto('/');
  for(const name of names){if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();await connectPasswordHost(page,name);}
  const terminal=await page.locator('.terminal-canvas:visible').elementHandle();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  const modes=page.getByRole('navigation',{name:'Workspace navigation',exact:true});await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  const live=page.getByRole('region',{name:'Herdr navigation',exact:true});await expect(live.locator('.herdr-navigation-row').first()).toBeVisible();
  const chrome=()=>modes.evaluate(node=>({mode:node.closest('aside')?.getAttribute('data-navigation'),buttons:Array.from(node.querySelectorAll('button')).map(button=>({text:button.textContent,current:button.getAttribute('aria-current'),hover:button.matches(':hover'),focus:button.matches(':focus-visible'),background:getComputedStyle(button).backgroundColor}))}));
  const beforeNeutral=await chrome();await page.mouse.move((phone?393:1200)-1,851);
  await modes.evaluate(async node=>{await Promise.all(node.getAnimations({subtree:true}).map(animation=>animation.finished));});
  const afterNeutral=await chrome();expect(afterNeutral.mode).toBe('workspaces');
  expect(afterNeutral.buttons.filter(button=>button.current==='page').map(button=>button.text)).toEqual(['Workspaces']);
  await testInfo.attach('workspace-mode-receipt',{body:JSON.stringify({beforeNeutral,afterNeutral}),contentType:'application/json'});
  console.info('Workspace mode receipt',JSON.stringify({phone,beforeNeutral,afterNeutral}));
  await page.screenshot({path:testInfo.outputPath('three-session-workspaces.png')});
  const sessions=page.getByRole('group',{name:'Live app sessions',exact:true,includeHidden:true});
  await expect(sessions.getByRole('button',{includeHidden:true})).toHaveCount(3);
  if(phone){
    const pane=live.locator('.herdr-navigation-tree > li > ul > li > ul .herdr-navigation-row').first();
    await page.setViewportSize({width:393,height:640});
    await page.screenshot({path:testInfo.outputPath('three-session-short-workspaces.png')});
    await expect(pane).toBeInViewport({ratio:1});
    await page.setViewportSize({width:393,height:852});
    const summary=page.locator('.workspace-session-summary');await expect(summary).toHaveAttribute('aria-expanded','false');
    for(const locale of ['pt-BR','es','en']) {
      const label=await page.evaluate(async locale=>{const {uiI18n,t}=await import('/src/i18n/core.ts');await uiI18n.changeLanguage(locale);return t('navigationLiveSessions');},locale);
      await expect(summary).toContainText(label);
      await summary.evaluate(node=>{node.style.fontSize='20px';});
      const box=(await summary.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.width).toBeGreaterThanOrEqual(44);expect(box.x+box.width).toBeLessThanOrEqual(393);
      expect(await summary.evaluate(node=>node.scrollWidth<=node.clientWidth+1)).toBe(true);
    }
    await summary.evaluate(node=>{node.style.fontSize='';});
    await expect(sessions).toBeHidden();await summary.focus();await page.keyboard.press('Enter');
    await expect(sessions).toBeVisible();await expect(summary).toHaveAttribute('aria-expanded','true');
    await page.keyboard.press('Tab');await expect(sessions.getByRole('button').first()).toBeFocused();
  }else await expect(sessions).toBeVisible();
  await expect(sessions.getByRole('button').last()).toHaveAttribute('aria-current','location');
  await sessions.getByRole('button').first().click();
  expect(await terminal!.evaluate(node=>node.isConnected)).toBe(true);
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await modes.getByRole('button',{name:'Workspaces',exact:true}).click();
  await expect(sessions.getByRole('button').first()).toHaveAttribute('aria-current','location');
  await expect(live.getByText('fixture@fixture.invalid',{exact:true})).toBeVisible();
  if(phone)await expect(page.locator('.workspace-session-summary')).toHaveAttribute('aria-expanded','true');
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['disconnect','write_stdin','attach_multiplexer','herdr_action'].includes(command)))).toEqual([]);
});

test('agent Live and Activity views keep one pending approval reachable without sending input',async({page},info)=>{
  await installWorkspaceNavigation(page);await page.goto('/');
  await page.evaluate(()=>{
    window.workspaceNavigationState.installed=true;
    const original=window.nativeFixtureInvoke;
    window.nativeFixtureInvoke=async(command,args,options)=>command==='agent_approvals'?{schemaVersion:1,requests:[{
      id:'b714333f-82b1-4ee0-a383-6fd6dc1eca01',expectedHash:'a'.repeat(64),agent:'claude',sessionId:'pending-agent',project:'/owned/review',paneId:'%7',toolName:'Bash',toolInput:{command:'git status'},createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300000).toISOString(),
    }]}:original(command,args,options);
  });
  await openConnectedAgents(page,info.project.name==='phone');
  const allow=page.getByRole('button',{name:'Allow this request',exact:true});
  await expect(allow).toBeVisible();await expect(allow).toHaveCount(1);
  const live=page.getByRole('button',{name:'Live Herdr agents',exact:true});
  const activity=page.getByRole('button',{name:'Reported agent activity',exact:true});
  await expect(live).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('searchbox',{name:'Search reported agents',exact:true})).toBeHidden();
  await activity.click();await expect(activity).toHaveAttribute('aria-pressed','true');
  await expect(allow).toBeVisible();await expect(allow).toHaveCount(1);
  await expect(page.getByRole('searchbox',{name:'Search reported agents',exact:true})).toBeVisible();
  await live.click();await expect(live).toHaveAttribute('aria-pressed','true');await expect(allow).toBeVisible();
  const calls=await page.evaluate(()=>window.workspaceNavigationCalls);
  expect(calls).not.toContain('write_stdin');expect(calls).not.toContain('resolve_agent_approval');
});

test('recorded Codex conversation stays readable in a constrained connected workspace and preserves its draft on refresh',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';await page.setViewportSize(phone?{width:393,height:852}:{width:1200,height:800});
  await installWorkspaceNavigation(page);await page.clock.resume();
  await page.addInitScript(()=>{
    const original=window.nativeFixtureInvoke;
    window.nativeFixtureInvoke=async(command,args,options)=>{
      if(command!=='agent_transcript')return original(command,args,options);
      if(args.sessionId!=='owned-navigation-ssh'||args.agent!=='codex'||args.view!=='conversation'||args.offset!==0)throw new Error('Wrong recorded conversation source');
      const count=String(args.path).includes('fork')?6:4;
      return {schemaVersion:1,agent:'codex',view:'active_branch',hasMore:false,nextOffset:100,messages:Array.from({length:count},(_,i)=>({id:`recorded-${i}`,role:i%2?'assistant':'user',blocks:[{type:'text',text:`Recorded synthetic turn ${i+1}.`}]}))};
    };
  });
  await page.goto('/');if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);const originalTerminal=await page.locator('.terminal-canvas').elementHandle();
  if(phone){await page.getByRole('button',{name:'Workspace tools',exact:true}).click();await openWorkspaceGroup(page,'more');}
  await (await workspaceControl(page,'Transcript' )).click();
  await page.getByRole('combobox',{name:'Agent',exact:true}).selectOption('codex');
  await page.getByRole('combobox',{name:'View',exact:true}).selectOption('conversation');
  const region=page.getByRole('region',{name:'Conversation messages',exact:true});
  for(const [path,count]of [['/fixture/parent.jsonl',4],['/fixture/fork.jsonl',6]] as const){
    await page.getByLabel('Transcript path',{exact:true}).fill(path);await page.getByRole('button',{name:'Open transcript',exact:true}).click();
    await expect(region.locator('.chat-message')).toHaveCount(count);
    await expect(region.locator('.chat-message p')).toHaveText(Array.from({length:count},(_,i)=>`Recorded synthetic turn ${i+1}.`));
    expect(await region.locator('h4').evaluateAll(elements=>elements.map(e=>(e as HTMLElement).innerText))).toEqual(Array.from({length:count},(_,i)=>i%2?'Assistant':'User'));
    const geometry=await region.evaluate(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight}));
    await testInfo.attach(`conversation-${count}-geometry`,{body:JSON.stringify(geometry),contentType:'application/json'});
    await page.screenshot({path:testInfo.outputPath(`conversation-${count}.png`)});
    expect(geometry.height).toBeGreaterThan(0);expect(geometry.clientHeight).toBeGreaterThan(0);
    await region.scrollIntoViewIfNeeded();await region.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
    await expect(region.locator('.chat-message').first()).toBeInViewport();
    await page.screenshot({path:testInfo.outputPath(`conversation-${count}-readable.png`)});
  }
  const draft=page.getByRole('textbox',{name:'Draft for this terminal',exact:true});await draft.fill('Recorded conversation draft remains unsubmitted');
  if(phone) {
    await page.setViewportSize({width:393,height:550});await page.evaluate(()=>{document.documentElement.style.zoom='1.35';});
    try {
      await draft.scrollIntoViewIfNeeded();
      const stage=(await page.getByRole('button',{name:'Stage in terminal',exact:true}).boundingBox())!;
      const footer=(await page.locator('.workspace-footer').boundingBox())!;
      expect(stage.y+stage.height).toBeLessThanOrEqual(footer.y);
    } finally {
      await page.evaluate(()=>{document.documentElement.style.zoom='';});await page.setViewportSize({width:393,height:852});
    }
  }
  await region.evaluate(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'));});
  await page.getByRole('button',{name:'Refresh new messages',exact:true}).click();
  await expect(page.getByRole('button',{name:'Refresh new messages',exact:true})).toBeEnabled();
  expect(await region.evaluate(e=>e.scrollTop)).toBe(0);await expect(draft).toHaveValue('Recorded conversation draft remains unsubmitted');
  await page.getByRole('button',{name:'Stage in terminal',exact:true}).click();
  await expect(page.locator('.terminal-compose textarea')).toHaveValue('Recorded conversation draft remains unsubmitted');
  expect(await originalTerminal!.evaluate(e=>e.isConnected)).toBe(true);
  expect(await page.evaluate(()=>(window as unknown as {workspaceNavigationCalls:string[]}).workspaceNavigationCalls.filter(command=>['write_stdin','attach_multiplexer','herdr_chat'].includes(command)))).toEqual([]);
});


test('focused work destinations retain the terminal and expose every contextual tool without input',async({page},info)=>{
  await installWorkspaceNavigation(page);await page.goto('/');
  const phone=info.project.name==='phone';
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await connectPasswordHost(page);
  const canvas=await page.locator('.terminal-canvas:visible').elementHandle();
  await expect(page.getByRole('navigation',{name:'Session views',exact:true})).toHaveCount(0);
  const tools=page.getByRole('button',{name:'Workspace tools',exact:true});await tools.click();
  const dialog=page.getByRole('dialog',{name:'Workspace tools',exact:true});
  await expect(dialog.getByRole('tab',{name:'Session views',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(dialog.getByRole('button',{name:'Preferences',exact:true})).toHaveCount(0);
  await (await workspaceControl(page,'Preferences')).click();
  await expect(page.getByRole('dialog',{name:'Preferences',exact:true})).toBeVisible();
  await page.keyboard.press('Escape');await expect(tools).toBeFocused();await tools.click();
  for(const name of ['Workspaces','Terminal','Agents','Files','Sessions','Usage','Attach','Apple status','Transcript','Diff','Preview','Dictate','Devices']) {
    await openToolsPageWith(page,name);
    const action=dialog.getByRole('button',{name,exact:true});await action.scrollIntoViewIfNeeded();await expect(action).toBeInViewport({ratio:1});
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);await expect(tools).toBeFocused();
  await page.evaluate(()=>Object.assign((window as any).workspaceNavigationState,{installed:true,agentCount:6,visualStates:true,reportCount:20}));
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('navigation',{name:'Workspace navigation',exact:true}).getByRole('button',{name:'Agents navigation',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeVisible();
  const live=page.getByRole('region',{name:'Herdr navigation',exact:true});
  await expect(live.locator('[data-agent-status=blocked]')).toHaveCount(2);
  await expect(live.locator('[data-agent-status=working]')).toHaveCount(2);
  expect((await live.locator('[data-agent-status=blocked]').first().boundingBox())!.y).toBeLessThan((await live.locator('[data-agent-status=working]').first().boundingBox())!.y);
  await selectAgentSection(page,'activity');
  const back=page.locator('.workspace-destination-heading').getByRole('button',{name:'Return to terminal',exact:true});
  await expect(page.getByRole('heading',{name:'Agents',exact:true})).toBeInViewport();await expect(back).toBeInViewport({ratio:1});
  await expect(page.getByRole('searchbox',{name:'Search reported agents',exact:true})).toBeVisible();
  await page.locator('.workspace-navigation-scroll').evaluate(node=>{node.scrollTop=node.scrollHeight;});
  await expect(back).toBeInViewport({ratio:1});await back.click();
  await expect(phone?page.getByRole('button',{name:'Open hosts',exact:true}):page.getByRole('navigation',{name:'Workspace navigation',exact:true}).getByRole('button',{name:'Connections',exact:true})).toBeFocused();
  expect(await page.locator('.terminal-canvas:visible').evaluate((node,original)=>node===original,canvas)).toBe(true);
  const calls=await page.evaluate(()=>(window as any).workspaceNavigationCalls as string[]);
  expect(calls.filter(name=>['write_stdin','disconnect','herdr_action','attach_multiplexer'].includes(name))).toEqual([]);
});

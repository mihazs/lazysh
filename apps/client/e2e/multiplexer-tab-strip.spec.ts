import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {forgetKeyboardRequests,keyboardRequests,trackKeyboardRequests} from './fixtures/keyboardRequests';

type Kind='herdr'|'zellij'|'tmux';
type Fixture={calls:{command:string;args:Record<string,unknown>}[]};
declare global {interface Window {stripFixture:Fixture}}

const strip=(page:Page,kind:Kind)=>page.getByRole('group',{name:`${kind} tabs`,exact:true});
const chips=(page:Page,kind:Kind)=>strip(page,kind).locator('.mux-chip');
const sent=(page:Page,...commands:string[])=>page.evaluate(commands=>window.stripFixture.calls.filter(call=>commands.includes(call.command)),commands);
const box=async(locator:ReturnType<Page['locator']>)=>(await locator.boundingBox())!;

/** A display attached to a multiplexer (restored by the app; Zellij is mounted directly) whose tabs the fixture serves and changes the way the real CLI would. */
async function open(page:Page,kind:Kind,{width=415,tabs=3,appTheme='forest',tabStrip,topBar}:{width?:number;tabs?:number;appTheme?:string;tabStrip?:'on'|'off';topBar?:boolean}={}) {
  await page.setViewportSize({width,height:900});
  await installNativeBridge(page);
  await trackKeyboardRequests(page);
  await page.addInitScript(({kind,tabs,appTheme,tabStrip,topBar})=>{
    if(topBar!==undefined)localStorage.setItem('lazysh.show-top-bar.v1',String(topBar));
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'box',attached:{kind,name:'work'}}]));
    if(!sessionStorage.getItem('seeded')){
      sessionStorage.setItem('seeded','1');
      localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,appTheme,theme:appTheme==='paper'?'paper':'forest',...(tabStrip?{tabStrip}:{})}));
    }
    const fixture:Fixture={calls:[]};window.stripFixture=fixture;
    // Which tab the multiplexer has focused; a selection moves it, as the real multiplexer would.
    let focused=0,workspace='w1';
    const names=Array.from({length:tabs},(_,index)=>['deploy','logs','editor','notes','build'][index]??`tab ${index+1}`);
    const herdrTree=()=>({
      workspaces:[{workspace_id:'w1',label:'Development',focused:workspace==='w1',agent_status:'working'},{workspace_id:'w2',label:'Operations',focused:workspace==='w2',agent_status:'blocked'}],
      tabs:names.map((label,index)=>({workspace_id:workspace,tab_id:`${workspace}:t${index+1}`,label,number:index+1,focused:index===focused,agent_status:index===0?'working':index===1?'blocked':index===2?'done':'idle'})),
      panes:[]});
    const tmuxSnapshot=()=>({generation:'g'.repeat(36),current:{sessionId:'$1',windowId:`@${focused+1}`},sessions:[{id:'$1',name:'work',restoreName:'work',windows:names.map((name,index)=>({id:`@${index+1}`,index,name}))}]});
    const screen=(args:Record<string,unknown>)=>{(args.events as {onmessage:(event:unknown)=>void}).onmessage({type:'data',data:Array.from(new TextEncoder().encode('dev@box:~$ '))});};
    window.nativeFixtureInvoke=async(command,args={})=>{
      const answers:Record<string,unknown>={
        list_hosts:[{id:'box',name:'Agent box',hostname:'box.invalid',port:22,username:'dev',fingerprint:'SHA256:fixture',credentialsStored:true}],
        local_capability:{available:false,reason:'Tab strip fixture'},apple_status_capability:{available:false,reason:'Tab strip fixture'},
        agent_snapshot:{schemaVersion:1,sessions:[]},transport_capabilities:{mosh:false,et:false},connect:{sessionId:'strip-shell'}};
      if(command in answers)return answers[command];
      if(command.startsWith('plugin:event|'))return 1;
      if(command==='multiplexer_tree')return {tmuxAvailable:true,herdrAvailable:true,zellijAvailable:true,tools:[{kind,version:'9',support:'full',missing:[]}],sessions:[]};
      if(command==='attach_multiplexer'||command==='attach_tmux'){screen(args);return {sessionId:'strip-display'};}
      if(['resize','ack_output','disconnect','write_stdin','probe_connections','cancel_credential_auth','has_credentials','adopt_session'].includes(command)){fixture.calls.push({command,args});return;}
      fixture.calls.push({command,args});
      if(command==='multiplexer_sessions')return [{name:'work'}];
      if(command==='herdr_tree')return herdrTree();
      if(command==='herdr_action'){
        const action=args.action as {type:string;target:string;label:string};
        if(action.type==='renameTab')names[Number(action.target.split(':t')[1])-1]=action.label;
        else if(action.type==='createTab')names.push(action.label);
        else if(action.type==='focusWorkspace'){workspace=action.target;focused=0;}
        else focused=Number(action.target.split(':t')[1])-1;
        return;
      }
      if(command==='zellij_tabs')return names.map((name,position)=>({position,name,active:position===focused}));
      if(command==='zellij_action'){
        const action=args.action as {type:string;index:number;name:string};
        // Zellij focuses the tab it creates.
        if(action.type==='newTab'){names.push(action.name);focused=names.length-1;}else focused=action.index-1;
        return;
      }
      if(command==='tmux_action'){
        const action=args.action as {type:string;target:string;name:string};
        if(action.type==='renameWindow')names[Number(action.target.slice(1))-1]=action.name;else names.push(action.name);
        return;
      }
      if(command==='tmux_jump_snapshot')return tmuxSnapshot();
      if(command==='tmux_jump'){focused=Number(String(args.windowId).slice(1))-1;return tmuxSnapshot();}
      throw new Error(`Tab strip fixture does not provide ${command}`);
    };
  },{kind,tabs,appTheme,tabStrip,topBar});
  await page.goto('/');
  if(kind==='zellij')await page.evaluate(async()=>{const fixture=await import('/e2e/fixtures/TabStripHarness.tsx');fixture.mountTabStripHarness('zellij','work','strip-display');});
  else await page.locator('.workspace-restore').getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
}

for(const kind of ['herdr','zellij','tmux'] as const)test(`${kind}: the strip lists the tabs, switches through the guarded command, keeps the keyboard closed and does not resize the terminal`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Auto shows the strip on phones.');
  await open(page,kind);
  await expect(chips(page,kind)).toHaveCount(3);
  await expect(chips(page,kind).nth(0)).toHaveAttribute('aria-current','true');
  // Session tabs are the only tabs of the workspace: the strip adds none (this single session shows no tab row of its own).
  await expect(page.getByRole('tab')).toHaveCount(0);
  const row=await box(strip(page,kind)),terminal=await box(page.locator('.terminal-canvas:visible'));
  expect(row.height).toBeGreaterThanOrEqual(40);
  expect(row.y+row.height,'the strip is above the terminal rows').toBeLessThanOrEqual(terminal.y+0.5);
  for(const chip of await chips(page,kind).all())expect((await box(chip)).height,'a 40 px touch target').toBeGreaterThanOrEqual(40);
  await forgetKeyboardRequests(page);
  const resizes=(await sent(page,'resize')).length;
  await chips(page,kind).nth(1).tap();
  await expect(chips(page,kind).nth(1)).toHaveAttribute('aria-current','true');
  await expect(chips(page,kind).nth(0)).not.toHaveAttribute('aria-current','true');
  const command=await sent(page,kind==='herdr'?'herdr_action':kind==='zellij'?'zellij_action':'tmux_jump');
  expect(command.map(call=>call.args)).toEqual([kind==='herdr'
    ?{sessionId:'strip-display',name:'work',action:{type:'focusTab',target:'w1:t2'}}
    :kind==='zellij'?{sessionId:'strip-display',name:'work',action:{type:'goToTab',index:2}}
    :{sessionId:'strip-display',generation:'g'.repeat(36),targetSessionId:'$1',windowId:'@2'}]);
  // Typed commands only: nothing reaches the host as input, the soft keyboard never asked to open and the grid kept its size.
  expect(await sent(page,'write_stdin')).toEqual([]);
  await page.waitForTimeout(300);
  expect(await keyboardRequests(page)).toEqual([]);
  expect((await sent(page,'resize')).length).toBe(resizes);
  expect((await box(page.locator('.terminal-canvas:visible'))).height).toBe(terminal.height);
  // Tapping the chip that is already active sends nothing.
  await chips(page,kind).nth(1).tap();
  expect(await sent(page,kind==='herdr'?'herdr_action':kind==='zellij'?'zellij_action':'tmux_jump')).toHaveLength(1);
});

test('the strip takes exactly its own height from the terminal, and Off removes it',async({page,context},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone layout.');
  await open(page,'zellij');
  const withStrip=await box(page.locator('.terminal-canvas:visible')),row=await box(strip(page,'zellij'));
  const off=await context.newPage();
  await open(off,'zellij',{tabStrip:'off'});
  await expect(strip(off,'zellij')).toHaveCount(0);
  expect(Math.round((await box(off.locator('.terminal-canvas:visible'))).height-withStrip.height)).toBe(Math.round(row.height));
  expect(await sent(off,'zellij_tabs')).toHaveLength(0);
});

test('Auto hides the strip for a single tab and Always shows it, on desktop too',async({page,context},testInfo)=>{
  const width=testInfo.project.name==='phone'?415:1280;
  await open(page,'zellij',{tabs:1,width});
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
  await page.waitForTimeout(500);
  await expect(strip(page,'zellij')).toHaveCount(0);
  const forced=await context.newPage();
  await open(forced,'zellij',{tabs:1,width,tabStrip:'on'});
  await expect(chips(forced,'zellij')).toHaveCount(1);
  await expect(chips(forced,'zellij').first()).toHaveAttribute('aria-current','true');
});

test('Herdr: the workspace chip lists every workspace with agent state, switches workspace, and keeps the active tab in view',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone layout.');
  await open(page,'herdr',{tabs:12});
  const workspace=page.getByRole('button',{name:'Workspaces: Development, Needs attention',exact:true});
  await expect(workspace).toBeVisible();
  await workspace.tap();
  const list=page.getByRole('group',{name:'Workspaces',exact:true});
  await expect(list.getByRole('button')).toHaveText(['Development','Operations']);
  await expect(list.getByRole('button',{name:'Operations, tab 2 of 2, Needs attention'})).toBeVisible();
  // The list drops over the terminal: nothing resizes.
  const terminal=await box(page.locator('.terminal-canvas:visible'));
  await list.getByRole('button',{name:/^Operations/}).tap();
  await expect(list).toHaveCount(0);
  await expect.poll(async()=>(await sent(page,'herdr_action')).map(call=>call.args.action)).toEqual([{type:'focusWorkspace',target:'w2'}]);
  await expect(page.getByRole('button',{name:'Workspaces: Operations',exact:true})).toBeVisible();
  expect((await box(page.locator('.terminal-canvas:visible'))).height).toBe(terminal.height);
  // A tab far along the row is brought into view when it is selected from elsewhere: select the last chip.
  const last=chips(page,'herdr').last();
  await last.scrollIntoViewIfNeeded();
  await last.tap();
  await expect(last).toHaveAttribute('aria-current','true');
  const view=await box(strip(page,'herdr').locator('.mux-tabs')),active=await box(last);
  expect(active.x).toBeGreaterThanOrEqual(view.x-1);
  expect(active.x+active.width).toBeLessThanOrEqual(view.x+view.width+1);
  expect(await keyboardRequests(page)).toEqual([]);
});

test('without the top bar (the side menu replaces it) the strip is the first row of the terminal chrome and still switches tabs',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','The top bar only goes away on phones.');
  await open(page,'herdr',{topBar:false});
  await expect(page.locator('.workspace-header')).toBeHidden();
  await expect(chips(page,'herdr')).toHaveCount(3);
  const row=await box(strip(page,'herdr')),terminal=await box(page.locator('.terminal-canvas:visible'));
  expect(row.y,'directly under the status bar, where the top bar was').toBeLessThanOrEqual(2);
  expect(row.y+row.height).toBeLessThanOrEqual(terminal.y+0.5);
  await forgetKeyboardRequests(page);
  await chips(page,'herdr').nth(2).tap();
  await expect(chips(page,'herdr').nth(2)).toHaveAttribute('aria-current','true');
  expect((await sent(page,'herdr_action')).map(call=>call.args.action)).toEqual([{type:'focusTab',target:'w1:t3'}]);
  await page.waitForTimeout(300);
  expect(await keyboardRequests(page)).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('tab-strip-no-top-bar.png'),clip:{x:0,y:0,width:415,height:260}});
});

for(const [appTheme,mode] of [['forest','dark'],['paper','light']] as const)test(`Herdr strip at 415 px, ${mode}`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone layout.');
  await open(page,'herdr',{tabs:5,appTheme});
  await expect(chips(page,'herdr')).toHaveCount(5);
  await page.waitForTimeout(300);
  await page.screenshot({path:testInfo.outputPath(`tab-strip-${mode}.png`),clip:{x:0,y:0,width:415,height:260}});
  const row=strip(page,'herdr');
  // Contrast between a chip label and the strip surface stays readable in both themes.
  const ratio=await row.evaluate(node=>{
    const channel=(value:string)=>{const [r,g,b]=(value.match(/[\d.]+/g)??[]).slice(0,3).map(Number).map(part=>{const v=part/255;return v<=0.03928?v/12.92:((v+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;};
    const active=node.querySelector('.mux-chip[data-active]')!;
    const a=channel(getComputedStyle(active).color),b=channel(getComputedStyle(node).backgroundColor);
    return (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
  });
  expect(ratio).toBeGreaterThanOrEqual(4.5);
});

const prompt=(page:Page)=>page.getByRole('form');
const hold=(chip:ReturnType<Page['locator']>)=>chip.dispatchEvent('pointerdown',{pointerType:'touch',button:0,clientX:20,clientY:20});

for(const kind of ['herdr','zellij','tmux'] as const)test(`${kind}: the plus creates a tab through the typed command, switches to it, and only its name prompt opens the keyboard`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone layout.');
  await open(page,kind);
  const terminal=await box(page.locator('.terminal-canvas:visible'));
  await forgetKeyboardRequests(page);
  await strip(page,kind).getByRole('button',{name:'New tab',exact:true}).tap();
  await expect(prompt(page)).toBeVisible();
  // The prompt drops over the terminal: it takes no layout space.
  expect((await box(page.locator('.terminal-canvas:visible'))).height).toBe(terminal.height);
  expect(await keyboardRequests(page)).toEqual(['INPUT']);
  await prompt(page).getByLabel('Name').fill('release');
  await prompt(page).getByRole('button',{name:'Save'}).tap();
  await expect(prompt(page)).toHaveCount(0);
  await expect(chips(page,kind)).toHaveCount(4);
  await expect(chips(page,kind).last()).toHaveAttribute('aria-current','true');
  await expect(chips(page,kind).last()).toHaveAttribute('title','release');
  const created=await sent(page,kind==='herdr'?'herdr_action':kind==='zellij'?'zellij_action':'tmux_action');
  expect(created[0].args).toEqual(kind==='herdr'?{sessionId:'strip-display',name:'work',action:{type:'createTab',workspace:'w1',label:'release',directory:'.'}}
    :kind==='zellij'?{sessionId:'strip-display',name:'work',action:{type:'newTab',name:'release',directory:'.'}}
    :{sessionId:'strip-display',action:{type:'createWindow',target:'$1',name:'release',directory:'.'}});
  expect(await sent(page,'write_stdin')).toEqual([]);
  expect((await box(page.locator('.terminal-canvas:visible'))).height).toBe(terminal.height);
});

for(const [appTheme,mode] of [['forest','dark'],['paper','light']] as const)test(`Herdr name prompt at 415 px, ${mode}`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone layout.');
  await open(page,'herdr',{tabs:5,appTheme});
  await strip(page,'herdr').getByRole('button',{name:'New tab',exact:true}).tap();
  await prompt(page).getByLabel('Name').fill('release');
  await page.waitForTimeout(300);
  await page.screenshot({path:testInfo.outputPath(`tab-strip-prompt-${mode}.png`),clip:{x:0,y:0,width:415,height:340}});
  // The plus stays at the end of the row, the prompt fits the screen, and every control is a 44 px target.
  const row=await box(strip(page,'herdr')),add=await box(strip(page,'herdr').getByRole('button',{name:'New tab',exact:true})),form=await box(prompt(page));
  expect(add.width).toBeGreaterThanOrEqual(44);
  expect(add.x+add.width).toBeLessThanOrEqual(row.x+row.width+1);
  expect(form.x).toBeGreaterThanOrEqual(0);
  expect(form.x+form.width).toBeLessThanOrEqual(415);
  for(const control of await prompt(page).locator('input,button').all())expect((await box(control)).height).toBeGreaterThanOrEqual(44);
});

test('a long press renames a Herdr tab and does not select it; a short tap still selects',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch long press.');
  await open(page,'herdr');
  await hold(chips(page,'herdr').nth(1));
  await expect(prompt(page)).toBeVisible();
  await expect(prompt(page).getByLabel('Name')).toHaveValue('logs');
  await prompt(page).getByLabel('Name').fill('api');
  await page.keyboard.press('Enter');
  await expect(chips(page,'herdr').nth(1)).toHaveAttribute('title','api');
  expect((await sent(page,'herdr_action')).map(call=>call.args.action)).toEqual([{type:'renameTab',target:'w1:t2',label:'api'}]);
  await chips(page,'herdr').nth(2).tap();
  await expect(chips(page,'herdr').nth(2)).toHaveAttribute('aria-current','true');
});

test('a Zellij chip has no rename (the multiplexer layer has no command for it), and a tmux window renames from the context menu',async({page,context},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Phone layout.');
  await open(page,'zellij');
  await hold(chips(page,'zellij').nth(1));
  await page.waitForTimeout(700);
  await expect(prompt(page)).toHaveCount(0);
  const tmux=await context.newPage();
  await open(tmux,'tmux');
  await chips(tmux,'tmux').nth(2).click({button:'right'});
  await expect(prompt(tmux)).toBeVisible();
  await tmux.getByRole('button',{name:'Cancel'}).tap();
  await expect(prompt(tmux)).toHaveCount(0);
  await chips(tmux,'tmux').nth(2).click({button:'right'});
  await prompt(tmux).getByLabel('Name').fill('vim');
  await tmux.getByRole('button',{name:'Save'}).tap();
  await expect(chips(tmux,'tmux').nth(2)).toHaveAttribute('title','vim');
  expect((await sent(tmux,'tmux_action')).map(call=>call.args.action)).toEqual([{type:'renameWindow',target:'@3',name:'vim'}]);
});

test('on desktop a right click renames a Herdr tab and the plus creates one',async({page},testInfo)=>{
  test.skip(testInfo.project.name==='phone','Desktop pointer.');
  await open(page,'herdr',{width:1280,tabStrip:'on'});
  await chips(page,'herdr').nth(1).click({button:'right'});
  await prompt(page).getByLabel('Name').fill('api');
  await page.keyboard.press('Enter');
  await expect(chips(page,'herdr').nth(1)).toHaveAttribute('title','api');
  await strip(page,'herdr').getByRole('button',{name:'New tab',exact:true}).click();
  await prompt(page).getByLabel('Name').fill('release');
  await prompt(page).getByRole('button',{name:'Save'}).click();
  await expect(chips(page,'herdr')).toHaveCount(4);
  await expect(chips(page,'herdr').last()).toHaveAttribute('aria-current','true');
});

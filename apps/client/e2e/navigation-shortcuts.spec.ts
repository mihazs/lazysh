import {expect,test,type Page,type TestInfo} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {installLocalTerminal} from './fixtures/localTerminal';

type Call={command:string;args:Record<string,unknown>};
declare global {interface Window {navigationCalls:Call[]}}

/** Connects one synthetic SSH host through the real App; no shell runs, and every native request is recorded. */
async function openConnectedTerminal(page:Page,testInfo:TestInfo,toolbar?:string[]) {
  await installNativeBridge(page);
  await page.addInitScript(toolbar=>{
    const calls:Call[]=[];window.navigationCalls=calls;
    if(toolbar)localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,toolbar}));
    window.nativeFixtureInvoke=async(command,args={})=>{
      calls.push({command,args});
      if(command==='list_hosts')return [{id:'navigation-host',name:'Navigation host',hostname:'fixture.invalid',username:'fixture',port:22}];
      if(command==='local_capability')return {available:false,reason:'Synthetic navigation fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:'navigation-ssh'};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='agent_approvals')return {schemaVersion:1,requests:[]};
      if(command==='multiplexer_sessions')return [];
      if(command==='get_companion_settings')return {schemaVersion:1,revision:1,transcriptDiscoveryEnabled:true,recordedUsageEnabled:true,deviceToolsEnabled:true};
      if(command==='board_keep_awake_status')return {available:false,active:false,reason:'Synthetic keep-awake unavailable',epoch:'0/11111111-1111-4111-8111-111111111111',ticket:1};
      if(command==='apple_status_capability')return {available:false,reason:'Synthetic status unavailable'};
      if(['write_stdin','resize','ack_output','disconnect','cancel_credential_auth'].includes(command)||command.startsWith('plugin:'))return command.startsWith('plugin:event|')?1:undefined;
      throw new Error(`Unsupported synthetic navigation request: ${command}`);
    };
  },toolbar);
  await page.goto('/');
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Navigation host',exact:true}).click();
  await page.getByRole('textbox',{name:'Password',exact:true}).fill('synthetic-only');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
}

const heading=(page:Page)=>page.locator('.workspace-destination-heading h2');
const mode=(page:Page,name:'Connections'|'Workspaces'|'Agents navigation')=>page.getByRole('navigation',{name:'Workspace navigation',exact:true}).getByRole('button',{name,exact:true});
/** Input that reached the synthetic shell; navigation never types into it. */
const typed=(page:Page)=>page.evaluate(()=>window.navigationCalls.filter(call=>call.command==='write_stdin').map(call=>call.args.data));

/** The view is open for the connection: its heading shows and, on a phone, the drawer covers the terminal. */
async function expectOpen(page:Page,phone:boolean,name:'Agents'|'Workspaces') {
  await expect(heading(page)).toHaveText(name);
  await expect(mode(page,name==='Agents'?'Agents navigation':'Workspaces')).toHaveAttribute('aria-current','page');
  if(phone)await expect(page.locator('.sidebar')).toHaveClass(/sidebar-open/);
}
/** Vertical two-finger swipes across the visible terminal, through real touch input. */
async function twoFingerSwipes(page:Page,phone:boolean) {
  const cdp=await page.context().newCDPSession(page);
  if(!phone)await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const swipe=async(dy:number)=>{
    const box=(await page.locator('.terminal-canvas:visible').boundingBox())!;
    const x=box.x+box.width/2,y=box.y+box.height/2;
    const fingers=(offset:number)=>[{x:x-40,y:y+offset,id:0},{x:x+40,y:y+offset,id:1}];
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:fingers(0)});
    for(let step=1;step<=8;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:fingers(dy*step/8)});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  return {swipe,cdp};
}
/** Back at the terminal: the phone drawer is closed, and a wide sidebar shows Connections again. */
async function expectTerminal(page:Page,phone:boolean) {
  if(phone){await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar-open/);await expect(heading(page)).not.toBeInViewport();}
  else {await expect(heading(page)).toHaveCount(0);await expect(mode(page,'Connections')).toHaveAttribute('aria-current','page');}
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeInViewport();
}

test('Ctrl+Shift+A and Ctrl+Shift+W open Agents and Workspaces from the focused terminal and return on a second press',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Hardware keyboard chords');
  await openConnectedTerminal(page,testInfo);
  const terminal=page.locator('.terminal-canvas:visible .xterm-helper-textarea');
  for(const [key,name] of [['A','Agents'],['W','Workspaces']] as const){
    await page.locator('.terminal-canvas:visible').click();
    await expect(terminal).toBeFocused();
    await page.keyboard.press(`Control+Shift+${key}`);
    await expectOpen(page,false,name);
    await page.keyboard.press(`Control+Shift+${key}`);
    await expectTerminal(page,false);
  }
  // The chords never reach the shell, while the shell keeps the unshifted Ctrl+A.
  expect(await typed(page)).toEqual([]);
  await page.locator('.terminal-canvas:visible').click();
  await page.keyboard.press('Control+A');
  await expect.poll(()=>typed(page)).toEqual(['\x01']);
  await expectTerminal(page,false);
});

test('the command palette lists the Agents and Workspaces chords',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Hardware keyboard hints');
  await openConnectedTerminal(page,testInfo);
  await page.keyboard.press('Control+Shift+P');
  const palette=page.getByRole('listbox',{name:'Commands',exact:true});
  for(const [label,chord] of [['Agents','Ctrl+Shift+A'],['Workspaces','Ctrl+Shift+W']]){
    const option=palette.getByRole('option').filter({has:page.getByText(label,{exact:true})});
    await expect(option.locator('kbd')).toHaveText(chord);
    // Assistive technology hears the chord as a shortcut, not as part of the option's name.
    await expect(option).toHaveAttribute('aria-keyshortcuts',chord.replace('Ctrl','Control'));
    await expect(option).not.toHaveAccessibleName(new RegExp(chord.replaceAll('+','\\+')));
  }
  // Inside the palette's own field the chord is not taken.
  await page.keyboard.press('Control+Shift+A');
  await expect(page.getByRole('combobox',{name:'Search hosts, sessions and commands',exact:true})).toBeFocused();
  await expect(heading(page)).toHaveCount(0);
});

test('two-finger swipes up and down in a plain terminal open Agents and Workspaces',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await openConnectedTerminal(page,testInfo);
  const {swipe,cdp}=await twoFingerSwipes(page,phone);
  for(const [dy,name] of [[-120,'Agents'],[120,'Workspaces']] as const){
    await swipe(dy);
    await expectOpen(page,phone,name);
    // The phone drawer covers the terminal, so its back control returns; on a wide screen the same swipe does.
    if(phone)await page.locator('.workspace-destination-heading').getByRole('button',{name:'Return to terminal',exact:true}).tap();
    else await swipe(dy);
    await expectTerminal(page,phone);
  }
  expect(await typed(page)).toEqual([]);
  await cdp.detach();
});

test('Agents and Workspaces toolbar keys open their views and return',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await openConnectedTerminal(page,testInfo,['esc','agents','workspaces']);
  const keys=page.locator('.terminal-keys:visible');
  for(const name of ['Agents','Workspaces'] as const){
    await keys.getByRole('button',{name,exact:true}).click();
    await expectOpen(page,phone,name);
    if(phone)await page.locator('.workspace-destination-heading').getByRole('button',{name:'Return to terminal',exact:true}).click();
    else await keys.getByRole('button',{name,exact:true}).click();
    await expectTerminal(page,phone);
  }
  expect(await typed(page)).toEqual([]);
});

test('in a local terminal, which has no Agents, the Agents chord and swipe stay with the shell',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await installLocalTerminal(page);
  await page.goto('/');
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const canvas=page.locator('.terminal-canvas:visible');
  await expect(canvas.locator('.xterm-screen')).toBeVisible();
  if(!phone){
    await canvas.click();
    // Unclaimed, the chord stays an ordinary terminal keypress: it reaches the terminal's own handlers unprevented, and nothing opens.
    const reached=page.evaluate(()=>new Promise(resolve=>{
      const input=document.querySelector('.terminal-canvas .xterm-helper-textarea')!;
      const seen=(event:Event)=>{if((event as KeyboardEvent).key.toLowerCase()!=='a')return;input.removeEventListener('keydown',seen);resolve({prevented:event.defaultPrevented});};
      input.addEventListener('keydown',seen);
    }));
    await page.keyboard.press('Control+Shift+A');
    expect(await reached).toEqual({prevented:false});
    await expect(heading(page)).toHaveCount(0);
  }
  const {swipe,cdp}=await twoFingerSwipes(page,phone);
  await swipe(-120);
  await page.waitForTimeout(300);
  await expect(heading(page)).toHaveCount(0);
  await expect(canvas.locator('.xterm-screen')).toBeInViewport();
  await cdp.detach();
});

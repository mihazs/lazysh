import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {forgetKeyboardRequests,keyboardRequests,trackKeyboardRequests} from './fixtures/keyboardRequests';
import {touchscreen} from './fixtures/touchscreen';

type Fixture={emit:(text:string)=>void};
declare global {interface Window {herdrHandle:Fixture}}

const handle=(page:Page)=>page.getByRole('button',{name:'Switch Herdr workspace, tab or pane',exact:true});
const keys=(page:Page)=>page.locator('.terminal-keys');
const box=async(locator:ReturnType<Page['locator']>)=>(await locator.boundingBox())!;

/** A restored display whose screen the test writes: attached to Herdr, or an ordinary shell the user may start herdr in by hand. */
async function open(page:Page,{attached=true}={}) {
  await page.setViewportSize({width:415,height:900});
  await installNativeBridge(page);
  await trackKeyboardRequests(page);
  await page.addInitScript(({attached})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify([{hostId:'box',...(attached?{attached:{kind:'herdr',name:'default'}}:{})}]));
    const screen=(args:Record<string,unknown>)=>{
      const channel=args.events as {onmessage:(event:unknown)=>void};
      window.herdrHandle={emit:text=>channel.onmessage({type:'data',data:Array.from(new TextEncoder().encode(text))})};
    };
    window.nativeFixtureInvoke=async(command,args={})=>{
      if(command.startsWith('plugin:event|'))return 1;
      if(command==='list_hosts')return [{id:'box',name:'Agent box',hostname:'box.invalid',port:22,username:'dev',fingerprint:'SHA256:fixture',credentialsStored:true}];
      if(command==='local_capability')return {available:false,reason:'Handle fixture'};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Handle fixture'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='connect'){if(!attached)screen(args);return {sessionId:'handle-shell'};}
      if(command==='multiplexer_tree')return {tmuxAvailable:false,herdrAvailable:true,zellijAvailable:false,tools:[{kind:'herdr',version:'0.9.5',support:'full',missing:[]}],sessions:[]};
      if(command==='multiplexer_sessions')return [{name:'default'}];
      if(command==='herdr_tree')return {workspaces:[{workspace_id:'w1',label:'Development',focused:true,agent_status:'idle'}],tabs:[{workspace_id:'w1',tab_id:'w1:t1',label:'Codex tasks',number:1,focused:true,agent_status:'idle'}],panes:[{focused:true,agent_status:'idle',pane_id:'w1:p1',workspace_id:'w1',tab_id:'w1:t1',terminal_id:'codex-terminal',cwd:'/work'}],agents:[]};
      if(command==='attach_multiplexer'){screen(args);return {sessionId:'handle-herdr'};}
      if(['resize','ack_output','disconnect','write_stdin','probe_connections','cancel_credential_auth','has_credentials','adopt_session'].includes(command))return;
      throw new Error(`Handle fixture does not provide ${command}`);
    };
  },{attached});
  await page.goto('/');
  await page.locator('.workspace-restore').getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>typeof window.herdrHandle?.emit)).toBe('function');
}

/** Herdr's phone layout as it draws it, below `history` lines of earlier output the terminal keeps. */
const draw=async(page:Page,history:number)=>{
  await page.evaluate(history=>{
    const lines=Array.from({length:history},(_,line)=>`HISTORY_${String(line).padStart(4,'0')}\r\n`).join('');
    // Cursor moves clamp at the last column, which puts the button at the right edge of any width.
    window.herdrHandle.emit(`${lines}\x1b[2J\x1b[H● Development  tab 1\x1b[2;2H1 blocked\x1b[2;999H\x1b[9D│ switch \x1b[6;1Hagent output`);
  },history);
  await expect.poll(()=>page.locator('.terminal-canvas:visible .xterm-rows').innerText()).toContain('agent output');
};
/** Whether the screen's own switch button is on screen. */
const tuiSwitchShown=(page:Page)=>page.locator('.terminal-canvas:visible .xterm-rows').evaluate(rows=>rows.textContent?.includes('│ switch')??false);
/** Moves the reader up into history with a finger, as on the phone. */
async function scrollBack(page:Page,testInfo:Parameters<typeof touchscreen>[1]) {
  const touch=await touchscreen(page,testInfo),canvas=await box(page.locator('.terminal-canvas:visible'));
  const x=canvas.x+canvas.width/2,y=canvas.y+canvas.height/4;
  for(let drag=0;drag<6;drag++)await touch.gesture([{x,y}],[{x,y:y+canvas.height/2}],6);
  await touch.cdp.detach();
}

/** The control is inside the visible viewport, below nothing it could cover and above the toolbar and every terminal row. */
async function expectReachable(page:Page) {
  const control=handle(page);
  await expect(control).toBeVisible();
  await expect(control).toBeInViewport({ratio:1});
  const target=await box(control),canvas=await box(page.locator('.terminal-canvas:visible')),toolbar=await box(keys(page));
  const view=await page.evaluate(()=>({top:window.visualViewport!.offsetTop,bottom:window.visualViewport!.offsetTop+window.visualViewport!.height}));
  expect(target.y).toBeGreaterThanOrEqual(view.top);
  expect(target.y+target.height).toBeLessThanOrEqual(view.bottom);
  expect(target.y+target.height,'above the terminal rows').toBeLessThanOrEqual(canvas.y+0.5);
  expect(target.y+target.height,'above the toolbar').toBeLessThanOrEqual(toolbar.y+0.5);
  expect(target.width).toBeGreaterThanOrEqual(40);
  expect(target.height).toBeGreaterThanOrEqual(40);
  // Nothing sits over it: a tap lands on the control.
  expect(await control.evaluate(node=>{const rect=node.getBoundingClientRect();return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.closest('.herdr-switch-handle')===node;})).toBe(true);
}

test('the Herdr switch stays reachable above the toolbar while the terminal shows its own history',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','The phone header and soft keyboard.');
  await open(page);
  await draw(page,300);
  expect(await tuiSwitchShown(page)).toBe(true);
  await expectReachable(page);
  const before=await box(handle(page));
  await page.screenshot({path:testInfo.outputPath('handle-live.png')});
  await scrollBack(page,testInfo);
  // The terminal's own switch button has scrolled away with the screen it belongs to.
  await expect.poll(()=>tuiSwitchShown(page)).toBe(false);
  await expectReachable(page);
  expect(await box(handle(page))).toEqual(before);
  await page.screenshot({path:testInfo.outputPath('handle-scrolled.png')});
});

for(const [kind,keyboard] of [
  ['a window the keyboard shrinks',async(page:Page,drop:number)=>{const size=page.viewportSize()!;await page.setViewportSize({width:size.width,height:size.height-drop});}],
  ['a visual viewport only the keyboard shrinks',async(page:Page,drop:number)=>{await page.evaluate(drop=>{const viewport=window.visualViewport!;Object.defineProperty(viewport,'height',{configurable:true,value:viewport.height-drop});viewport.dispatchEvent(new Event('resize'));},drop);}],
] as const)test(`the Herdr switch stays reachable above the toolbar with the soft keyboard open in ${kind}`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','The phone header and soft keyboard.');
  await open(page);
  await draw(page,300);
  await keyboard(page,320);
  await page.waitForTimeout(400);
  await expectReachable(page);
  await page.screenshot({path:testInfo.outputPath(`handle-keyboard-${kind.replace(/\W+/g,'-')}.png`)});
  await scrollBack(page,testInfo);
  await expectReachable(page);
});

test('tapping the Herdr switch opens Spaces without raising the soft keyboard, and back returns to the terminal',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','The phone header and soft keyboard.');
  await open(page);
  await draw(page,20);
  await forgetKeyboardRequests(page);
  await handle(page).tap();
  const spaces=page.getByRole('region',{name:'Herdr navigation',exact:true});
  await expect(spaces.getByRole('heading',{name:'Spaces'})).toBeVisible();
  await expect(spaces.getByRole('button',{name:/Development/}).first()).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('handle-spaces.png')});
  await page.getByRole('button',{name:'Return to terminal',exact:true}).tap();
  await expect(spaces).toBeHidden();
  await page.waitForTimeout(400);
  expect(await keyboardRequests(page)).toEqual([]);
  await expectReachable(page);
});

test('a terminal shows the Herdr switch only while Herdr runs in it, however it was started',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','The phone header.');
  await open(page,{attached:false});
  await page.evaluate(()=>window.herdrHandle.emit('dev@box:~$ '));
  await expect(handle(page)).toHaveCount(0);
  // The user starts herdr in a shell lazysh knows nothing about: the switch appears with its screen.
  await draw(page,0);
  await expectReachable(page);
  await page.screenshot({path:testInfo.outputPath('handle-plain-shell-herdr.png')});
  // And it goes when Herdr leaves the screen.
  await page.evaluate(()=>window.herdrHandle.emit('\x1b[2J\x1b[Hdev@box:~$ '));
  await expect(handle(page)).toHaveCount(0);
});

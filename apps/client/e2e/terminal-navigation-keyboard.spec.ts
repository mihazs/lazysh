import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {forgetKeyboardRequests,keyboardRequests,trackKeyboardRequests} from './fixtures/keyboardRequests';
import {touchscreen} from './fixtures/touchscreen';

type Fixture={channels:Record<string,{onmessage:(event:unknown)=>void}>;resizes:{sessionId:string;rows:number}[];editable:boolean[]};
declare global {interface Window {navigation:Fixture}}

// Two restored tmux terminals of one host: the same shape as two Herdr displays of one server.
const workspace=[{hostId:'box',attached:{kind:'tmux',name:'one'}},{hostId:'box',attached:{kind:'tmux',name:'two'}}];
const terminal=(page:Page,name:string)=>page.locator(`.terminal-canvas[aria-label=${JSON.stringify(`Terminal for Agent box / ${name}`)}]`);
const shown=(page:Page)=>page.locator('.terminal-canvas:visible').getAttribute('aria-label');
const rows=(page:Page)=>page.locator('.terminal-canvas:visible .xterm-rows > div').count();
const viewportHeight=(page:Page)=>page.evaluate(()=>window.visualViewport!.height);
const editable=(page:Page)=>page.evaluate(()=>document.activeElement?.matches('input,textarea,select,[contenteditable]')===true);

async function open(page:Page) {
  // The phone the screenshots are taken on.
  if((page.viewportSize()?.width??1280)<=600)await page.setViewportSize({width:415,height:900});
  await installNativeBridge(page);
  await trackKeyboardRequests(page);
  await page.addInitScript(({workspace})=>{
    localStorage.setItem('lazysh.workspace.v1',JSON.stringify(workspace));
    // A two-finger swipe left or right changes terminal, as the plain-terminal defaults do.
    localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,gestures:{left:'nextSession',right:'previousSession'},toolbar:['esc']}));
    const fixture:Fixture={channels:{},resizes:[],editable:[]};
    window.navigation=fixture;
    let sessions=0;
    window.nativeFixtureInvoke=async(command,args={})=>{
      if(command.startsWith('plugin:event|'))return 1;
      if(command==='list_hosts')return [{id:'box',name:'Agent box',hostname:'box.invalid',port:22,username:'dev',fingerprint:'SHA256:fixture',credentialsStored:true}];
      if(command==='local_capability')return {available:false,reason:'Navigation fixture'};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='apple_status_capability')return {available:false,reason:'Navigation fixture'};
      if(command==='connect'||command==='attach_tmux'){
        const sessionId=`native-${++sessions}`;
        if(command==='attach_tmux')fixture.channels[sessionId]=args.events as Fixture['channels'][string];
        return {sessionId};
      }
      if(command==='resize'){fixture.resizes.push({sessionId:String(args.sessionId),rows:Number(args.rows)});return;}
      if(['ack_output','disconnect','write_stdin','probe_connections','cancel_credential_auth','has_credentials'].includes(command))return;
      throw new Error(`Navigation fixture does not provide ${command}`);
    };
    // Samples every frame whether an editable control holds focus, which is what keeps a soft keyboard open.
    const sample=()=>{fixture.editable.push(document.activeElement?.matches('input,textarea,select,[contenteditable]')===true);requestAnimationFrame(sample);};
    requestAnimationFrame(sample);
  },{workspace});
  await page.goto('/');
  await page.locator('.workspace-restore').getByRole('button',{name:'Restore previous workspace',exact:true}).click();
  await expect(terminal(page,'one')).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.navigation.resizes.length)).toBeGreaterThan(0);
  // Let the first fit and its resize settle before measuring.
  await page.waitForTimeout(300);
}

/** Two fingers swiping left, which the preferences above bind to the next session. */
async function swipeToNextTerminal(page:Page,testInfo:Parameters<typeof touchscreen>[1]) {
  const touch=await touchscreen(page,testInfo);
  const box=(await page.locator('.terminal-canvas:visible').boundingBox())!;
  const y=box.y+box.height/2,x=box.x+box.width/2;
  await touch.gesture([{x:x-40,y},{x:x+40,y}],[{x:x-160,y},{x:x-80,y}]);
  await touch.cdp.detach();
}

/** Every way to move to the other terminal. */
const paths:{name:string;to:(page:Page,testInfo:Parameters<typeof touchscreen>[1])=>Promise<unknown>}[]=[
  {name:'the session switcher',to:async page=>{
    await page.getByRole('button',{name:'Switch terminal session',exact:true}).tap();
    await page.locator('.session-choice').filter({hasText:'Agent box / two'}).tap();
  }},
  {name:'the live sessions in the Workspaces drawer',to:async page=>{
    await page.getByRole('button',{name:'Open hosts',exact:true}).tap();
    await page.getByRole('navigation',{name:'Workspace navigation',exact:true}).getByRole('button',{name:'Workspaces',exact:true}).tap();
    const summary=page.locator('.workspace-session-summary');
    if(await summary.count())await summary.tap();
    await page.locator('.workspace-live-sessions').getByRole('button',{name:/Agent box \/ two/}).tap();
  }},
  {name:'a two-finger swipe',to:swipeToNextTerminal},
];

for(const path of paths)test(`moving to another terminal through ${path.name} neither raises the soft keyboard nor changes the grid`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch screens raise a soft keyboard.');
  await open(page);
  const before={rows:await rows(page),height:await viewportHeight(page),shown:await shown(page)};
  await forgetKeyboardRequests(page);
  await path.to(page,testInfo);
  await expect.poll(()=>shown(page)).not.toBe(before.shown);
  await page.waitForTimeout(500);
  expect(await keyboardRequests(page)).toEqual([]);
  expect(await editable(page)).toBe(false);
  expect(await rows(page)).toBe(before.rows);
  expect(await viewportHeight(page)).toBe(before.height);
  // Nothing asked the other terminal's remote screen for a different size than the first one has.
  const sizes=await page.evaluate(()=>window.navigation.resizes.map(resize=>resize.rows));
  expect(new Set(sizes.slice(-2)).size).toBe(1);
  await page.screenshot({path:testInfo.outputPath(`${path.name.replace(/\W+/g,'-')}.png`)});
});

test('a terminal that reconnects after a lost connection does not raise the soft keyboard',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch screens raise a soft keyboard.');
  await open(page);
  await forgetKeyboardRequests(page);
  await page.evaluate(()=>window.navigation.channels['native-2'].onmessage({type:'closed',message:'Connection reset by peer',lost:true}));
  await expect(page.getByRole('region',{name:/Connection lost for/})).toBeVisible();
  await expect(page.getByRole('region',{name:/Connection lost for/})).toHaveCount(0,{timeout:10_000});
  await expect(page.locator('.terminal-canvas:visible')).toHaveCount(1);
  await page.waitForTimeout(500);
  expect(await keyboardRequests(page)).toEqual([]);
  expect(await editable(page)).toBe(false);
});

test('the soft keyboard stays up, without closing in between, when a swipe moves to another terminal',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Touch screens raise a soft keyboard.');
  await open(page);
  const first=await shown(page);
  // A tap in the terminal is the user's request for the keyboard, which then shrinks the window.
  await page.locator('.terminal-canvas:visible').tap();
  await expect.poll(()=>editable(page)).toBe(true);
  const size=page.viewportSize()!;
  await page.setViewportSize({width:size.width,height:size.height-320});
  await page.waitForTimeout(300);
  const keyboard={rows:await rows(page),height:await viewportHeight(page)};
  await page.evaluate(()=>{window.navigation.editable.length=0;});
  await swipeToNextTerminal(page,testInfo);
  await expect.poll(()=>shown(page)).not.toBe(first);
  await page.waitForTimeout(500);
  expect(await editable(page)).toBe(true);
  expect(await page.evaluate(()=>document.activeElement?.closest('.terminal-canvas')?.getAttribute('aria-label'))).toBe(await shown(page));
  expect(await rows(page)).toBe(keyboard.rows);
  expect(await viewportHeight(page)).toBe(keyboard.height);
  // No frame saw the keyboard's input without focus.
  expect(await page.evaluate(()=>window.navigation.editable.every(Boolean))).toBe(true);
  await page.screenshot({path:testInfo.outputPath('keyboard-open-swipe.png')});
});

test('with a mouse and physical keyboard the terminal that is switched to takes keyboard focus',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='desktop','Physical keyboards focus the switched terminal.');
  await open(page);
  await page.getByRole('tab',{name:/Agent box \/ two/}).click();
  await expect.poll(()=>page.evaluate(()=>document.activeElement?.closest('.terminal-canvas')?.getAttribute('aria-label'))).toBe('Terminal for Agent box / two');
});

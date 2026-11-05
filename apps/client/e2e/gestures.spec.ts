import {expect,test,type CDPSession,type Page,type TestInfo} from '@playwright/test';
import {openHistoryWorkspace} from './fixtures/terminalHistory';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';
import type {mountGestureHarness} from './fixtures/GestureHarness';
import type {MultiplexerKind} from '../src/bridge';
declare global {interface Window {gestures:ReturnType<typeof mountGestureHarness>}}
type Point={x:number;y:number};

test.afterEach(async({page})=>{await page.evaluate(()=>window.gestures?.dispose());});

async function mount(page:Page,kind?:MultiplexerKind) {
  await page.evaluate(async kind=>{
    const fixture=await import('/e2e/fixtures/GestureHarness.tsx');
    window.gestures=fixture.mountGestureHarness(kind);
  },kind);
  await expect(page.locator('.terminal-canvas .xterm-screen')).toBeVisible();
}
const recorded=(page:Page)=>page.evaluate(()=>({steps:window.gestures.steps,zellij:window.gestures.zellij,sessions:window.gestures.sessions,errors:window.gestures.errors}));
const fontSize=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')??'{"fontSize":14}').fontSize as number);

/** Real browser touch input; the desktop project emulates a touch screen for the same gestures. */
async function touchscreen(page:Page,testInfo:TestInfo) {
  const cdp=await page.context().newCDPSession(page);
  if(testInfo.project.name==='desktop')await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:5});
  const send=(type:'touchStart'|'touchMove'|'touchEnd',points:Point[])=>cdp.send('Input.dispatchTouchEvent',{type,touchPoints:points.map((point,id)=>({...point,id}))});
  /** Moves every finger from its start to its end in even steps, then lifts them all. */
  const gesture=async(from:Point[],to:Point[],steps=8)=>{
    await send('touchStart',from);
    for(let step=1;step<=steps;step++)await send('touchMove',from.map((point,index)=>({x:point.x+(to[index].x-point.x)*step/steps,y:point.y+(to[index].y-point.y)*step/steps})));
    await send('touchEnd',[]);
  };
  return {cdp,send,gesture};
}
async function canvasCenter(page:Page):Promise<Point> {
  const box=(await page.locator('.terminal-canvas').boundingBox())!;
  return {x:box.x+box.width/2,y:box.y+box.height/2};
}
async function pinchOut(page:Page,touch:Awaited<ReturnType<typeof touchscreen>>) {
  const {x,y}=await canvasCenter(page);
  await touch.gesture([{x:x-40,y},{x:x+40,y}],[{x:x-110,y},{x:x+110,y}]);
}
/** Lines the harness terminal's viewport sits above the live screen. */
const scrolledBack=(page:Page)=>page.evaluate(()=>{const buffer=window.gestures.terminal.buffer.active;return buffer.baseY-buffer.viewportY;});
/** Fills the scrollback and leaves the reader 50 lines up in history. */
async function readHistory(page:Page) {
  await page.evaluate(()=>new Promise<void>(done=>window.gestures.terminal.write(Array.from({length:200},(_,line)=>`history ${line}\r\n`).join(''),done)));
  await page.evaluate(()=>window.gestures.terminal.scrollLines(-50));
  expect(await scrolledBack(page)).toBe(50);
}
async function swipe(page:Page,touch:Awaited<ReturnType<typeof touchscreen>>,dx:number,dy:number) {
  const {x,y}=await canvasCenter(page);
  await touch.gesture([{x:x-40,y},{x:x+40,y}],[{x:x-40+dx,y:y+dy},{x:x+40+dx,y:y+dy}]);
}

for(const [kind,expected] of [
  ['tmux',{steps:[['\x02','n'],['\x02','p'],['\x02','o'],['\x02',':','select-pane -t :.-','\r'],['\x02','z']],zellij:[]}],
  ['herdr',{steps:[['\x02','n'],['\x02','p'],['\x02','l'],['\x02','h'],['\x02','z']],zellij:[]}],
  ['zellij',{steps:[],zellij:['nextTab','previousTab','nextPane','previousPane','zoomPane'].map(action=>`zellij-work:${action}`)}],
] as const)test(`${kind}: default two-finger swipes change tabs and panes and a pinch zooms the pane`,async({page},testInfo)=>{
  await openHistoryWorkspace(page);
  await mount(page,kind);
  const touch=await touchscreen(page,testInfo);
  const count=async()=>{const {steps,zellij}=await recorded(page);return steps.length+zellij.length;};
  for(const [index,[dx,dy]] of [[-120,0],[120,0],[0,-120],[0,120]].entries()){
    await swipe(page,touch,dx,dy);
    await expect.poll(count).toBe(index+1);
  }
  await pinchOut(page,touch);
  await expect.poll(count).toBe(5);
  expect(await recorded(page)).toEqual({...expected,steps:expected.steps.map(step=>[...step]),zellij:[...expected.zellij],sessions:[],errors:[]});
  // The pane-zoom pinch leaves the text size alone.
  expect(await fontSize(page)).toBe(14);
  await touch.cdp.detach();
});

test('plain terminal: two-finger swipes switch lazysh sessions and a pinch still resizes text',async({page},testInfo)=>{
  await openHistoryWorkspace(page);
  await mount(page);
  const touch=await touchscreen(page,testInfo);
  await swipe(page,touch,-120,0);
  await swipe(page,touch,120,0);
  await expect.poll(async()=>(await recorded(page)).sessions).toEqual(['nextSession','previousSession']);
  await pinchOut(page,touch);
  await expect.poll(()=>fontSize(page)).toBeGreaterThan(14);
  expect(await recorded(page)).toMatchObject({steps:[],zellij:[],errors:[]});
  await touch.cdp.detach();
});

test('double tap and one-finger swipes run their configured actions on a real touch screen',async({page},testInfo)=>{
  await openHistoryWorkspace(page);
  await page.evaluate(async()=>{
    const {defaults,savePreferences}=await import('/src/preferences.ts');
    savePreferences({...defaults,bodyGestures:{...defaults.bodyGestures,doubleTap:'tab',swipeLeft:'escape',swipeRight:'pageDown'}});
  });
  await mount(page);
  const touch=await touchscreen(page,testInfo);
  const at=await canvasCenter(page);
  // A gesture that sends a key returns the reader to the live screen, as keyboard input does.
  await readHistory(page);
  await touch.gesture([at],[{x:at.x-120,y:at.y}]);
  await expect.poll(async()=>(await recorded(page)).steps).toEqual([['\x1b']]);
  expect(await scrolledBack(page)).toBe(0);
  await touch.gesture([at],[{x:at.x+120,y:at.y}]);
  await expect.poll(async()=>(await recorded(page)).steps).toEqual([['\x1b'],['\x1b[6~']]);
  for(let tap=0;tap<2;tap++){await touch.send('touchStart',[at]);await touch.send('touchEnd',[]);}
  await expect.poll(async()=>(await recorded(page)).steps).toEqual([['\x1b'],['\x1b[6~'],['\t']]);
  await touch.cdp.detach();
});

test('a multiplexer pinch can resize text or do nothing instead, and multiplexer actions need an attached terminal',async({page},testInfo)=>{
  await openHistoryWorkspace(page);
  const set=(patch:Record<string,unknown>)=>page.evaluate(async patch=>{
    const {getPreferences,savePreferences}=await import('/src/preferences.ts');
    const current=getPreferences();
    savePreferences({...current,...patch,bodyGestures:{...current.bodyGestures,...(patch.bodyGestures as object)}});
  },patch);
  await set({bodyGestures:{pinch:'fontSize'}});
  await mount(page,'tmux');
  const touch=await touchscreen(page,testInfo);
  await pinchOut(page,touch);
  await expect.poll(()=>fontSize(page)).toBeGreaterThan(14);
  const resized=await fontSize(page);
  await set({bodyGestures:{pinch:'none'}});
  await pinchOut(page,touch);
  await page.waitForTimeout(150);
  expect(await fontSize(page)).toBe(resized);
  expect((await recorded(page)).steps).toEqual([]);
  await page.evaluate(()=>window.gestures.dispose());
  // An explicit multiplexer action on a plain terminal reports instead of typing keys.
  await set({gestures:{left:'zoomPane',right:'auto',up:'auto',down:'auto'}});
  await mount(page);
  await swipe(page,touch,-120,0);
  await expect.poll(async()=>(await recorded(page)).errors).toEqual(['This gesture requires a terminal attached to tmux, Herdr or Zellij through lazysh.']);
  expect(await recorded(page)).toMatchObject({steps:[],sessions:[]});
  await touch.cdp.detach();
});

test('pulling the session header shows the release action and runs the short or long pull',async({page},testInfo)=>{
  await openHistoryWorkspace(page);
  await mount(page,'tmux');
  const touch=await touchscreen(page,testInfo);
  const header=(await page.locator('section header').boundingBox())!;
  const start={x:header.x+header.width/2,y:header.y+header.height/2};
  const status=page.locator('.terminal-pull');
  const pull=async(dy:number,dx=0)=>{
    await touch.send('touchStart',[start]);
    for(let step=1;step<=8;step++)await touch.send('touchMove',[{x:start.x+dx*step/8,y:start.y+dy*step/8}]);
  };
  await pull(90);
  await expect(status).toHaveText('Release for Next multiplexer tab or window');
  await page.screenshot({path:testInfo.outputPath('header-pull-short.png')});
  await touch.send('touchEnd',[]);
  await expect(status).toHaveCount(0);
  await expect.poll(async()=>(await recorded(page)).steps).toEqual([['\x02','n']]);
  await pull(200);
  await expect(status).toHaveText('Release for Next lazysh session');
  // Pulling back above the short depth cancels before release.
  for(let step=1;step<=4;step++)await touch.send('touchMove',[{x:start.x,y:start.y+200-step*45}]);
  await expect(status).toHaveCount(0);
  await touch.send('touchEnd',[]);
  await pull(200);
  await touch.send('touchEnd',[]);
  await expect.poll(async()=>(await recorded(page)).sessions).toEqual(['nextSession']);
  // A sideways drag is not a pull.
  await pull(90,160);
  await expect(status).toHaveCount(0);
  await touch.send('touchEnd',[]);
  await page.waitForTimeout(150);
  expect(await recorded(page)).toEqual({steps:[['\x02','n']],zellij:[],sessions:['nextSession'],errors:[]});
  // With both pulls off the header keeps the browser's own touch handling.
  await page.evaluate(async()=>{
    const {getPreferences,savePreferences}=await import('/src/preferences.ts');
    const current=getPreferences();
    savePreferences({...current,bodyGestures:{...current.bodyGestures,pullShallow:'none',pullDeep:'none'}});
    Reflect.set(window,'headerMovesPrevented',0);
    window.addEventListener('touchmove',event=>{if(event.defaultPrevented)Reflect.set(window,'headerMovesPrevented',Number(Reflect.get(window,'headerMovesPrevented'))+1);});
  });
  await pull(200);
  await touch.send('touchEnd',[]);
  await page.waitForTimeout(150);
  expect(await page.evaluate(()=>Reflect.get(window,'headerMovesPrevented'))).toBe(0);
  expect(await recorded(page)).toEqual({steps:[['\x02','n']],zellij:[],sessions:['nextSession'],errors:[]});
  await touch.cdp.detach();
});

test('a toolbar key runs its long-press action from the keys editor while other keys still repeat when held',async({page},testInfo)=>{
  await openHistoryWorkspace(page);
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Toolbar keys and order',{exact:true}).click();
  const editor=page.locator('.toolbar-editor');
  await editor.getByRole('button',{name:'esc',exact:true}).click();
  const longPress=editor.getByRole('combobox',{name:'Long-press esc',exact:true});
  await longPress.selectOption('zoomPane');
  await page.screenshot({path:testInfo.outputPath('toolbar-long-press-editor.png')});
  await editor.getByRole('button',{name:'tab',exact:true}).click();
  await editor.getByRole('combobox',{name:'Long-press tab',exact:true}).selectOption('custom');
  await editor.getByLabel('Long-press tab chord',{exact:true}).fill('C-b, S-t');
  await editor.getByRole('button',{name:'Save Long-press tab chord',exact:true}).click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).toolbarAlternates)).toEqual({esc:{action:'zoomPane'},tab:{action:'custom',keys:'C-b, S-t'}});
  await page.reload();
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Toolbar keys and order',{exact:true}).click();
  await page.locator('.toolbar-editor').getByRole('button',{name:'esc',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'Long-press esc',exact:true})).toHaveValue('zoomPane');
  await closePreferences(page);

  await mount(page,'tmux');
  const keys=page.getByLabel('Terminal keys',{exact:true});
  const esc=keys.getByRole('button',{name:'esc',exact:true});
  await expect(esc).toHaveAttribute('title','Hold: Zoom multiplexer pane');
  const phone=testInfo.project.name==='phone';
  const touch=phone?await touchscreen(page,testInfo):undefined;
  const hold=async(name:string,ms:number)=>{
    const key=keys.getByRole('button',{name,exact:true});
    await key.scrollIntoViewIfNeeded();
    const box=(await key.boundingBox())!;
    const at={x:box.x+box.width/2,y:box.y+box.height/2};
    if(touch){await touch.send('touchStart',[at]);await page.waitForTimeout(ms);await touch.send('touchEnd',[]);}
    else {await page.mouse.move(at.x,at.y);await page.mouse.down();await page.waitForTimeout(ms);await page.mouse.up();}
  };
  // A reader scrolled into history returns to the live screen, where the multiplexer answers the action.
  await readHistory(page);
  await hold('esc',700);
  await expect.poll(async()=>(await recorded(page)).steps).toEqual([['\x02','z']]);
  expect(await scrolledBack(page)).toBe(0);
  await hold('tab',700);
  await expect.poll(async()=>(await recorded(page)).steps).toEqual([['\x02','z'],['\x02','T']]);
  // A quick press still sends the key itself.
  if(phone)await esc.tap();else await esc.click();
  await expect.poll(async()=>(await recorded(page)).steps).toEqual([['\x02','z'],['\x02','T'],['\x1b']]);
  if(!phone){
    // The context menu runs the long-press action without a hold.
    await esc.click({button:'right'});
    await expect.poll(async()=>(await recorded(page)).steps).toHaveLength(4);
    expect((await recorded(page)).steps[3]).toEqual(['\x02','z']);
  }
  const before=(await recorded(page)).steps.length;
  await hold('Arrow left',800);
  await expect.poll(async()=>(await recorded(page)).steps.length).toBeGreaterThan(before+2);
  expect((await recorded(page)).steps.slice(before).every(step=>step.length===1&&step[0]==='\x1b[D')).toBe(true);
  expect((await recorded(page)).errors).toEqual([]);
  await touch?.cdp.detach();
});

test('gesture settings offer level-aware defaults, multiplexer pinch and header pull depths, and reset to them',async({page})=>{
  await openHistoryWorkspace(page);
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Terminal touch gestures',{exact:true}).click();
  const slots={'Two-finger swipe left':'auto','Two-finger swipe up':'auto','Pinch in tmux, Herdr or Zellij':'auto','Short header pull':'auto','Long header pull':'auto'};
  for(const [name,value] of Object.entries(slots))await expect(page.getByRole('combobox',{name,exact:true})).toHaveValue(value);
  const pinch=page.getByRole('combobox',{name:'Pinch in tmux, Herdr or Zellij',exact:true});
  await expect(pinch.locator('option[value="fontSize"]')).toHaveCount(1);
  await expect(page.getByRole('combobox',{name:'Short header pull',exact:true}).locator('option[value="fontSize"]')).toHaveCount(0);
  await expect(page.getByRole('combobox',{name:'Single tap',exact:true}).locator('option[value="auto"]')).toHaveCount(0);
  await pinch.selectOption('fontSize');
  await page.getByRole('combobox',{name:'Short header pull',exact:true}).selectOption('find');
  await page.getByRole('combobox',{name:'Long header pull',exact:true}).selectOption('custom');
  await page.getByLabel('Long header pull chord',{exact:true}).fill('C-b d');
  await page.getByRole('button',{name:'Save Long header pull chord',exact:true}).click();
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!));
  expect(stored.bodyGestures).toMatchObject({pinch:'fontSize',pullShallow:'find',pullDeep:'custom'});
  expect(stored.gestureChords).toEqual({pullDeep:'C-b d'});
  await page.reload();
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Terminal touch gestures',{exact:true}).click();
  await expect(pinch).toHaveValue('fontSize');
  await expect(page.getByLabel('Long header pull chord',{exact:true})).toHaveValue('C-b d');
  await page.getByRole('button',{name:'Reset gestures',exact:true}).click();
  for(const [name,value] of Object.entries(slots))await expect(page.getByRole('combobox',{name,exact:true})).toHaveValue(value);
});

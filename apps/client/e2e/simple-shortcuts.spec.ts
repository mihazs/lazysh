import {openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';
import { openGestureSettings, saveAdvancedGesture, expectGestureBinding } from './fixtures/gestureSettings';
import {expect,test,type Page} from '@playwright/test';

declare global {interface Window {simpleShortcutCopies:string[];simpleShortcutWrites:string[];simpleShortcutSteps:string[][];simpleShortcutTouchMoves:number;simpleShortcutTouchTarget:Element|null;simpleShortcutOutput:(text:string)=>void;simpleShortcutWriteFailure?:'backpressure'|'input_closed'}}
async function fixture(page:Page) {
  await page.addInitScript(()=>{
    window.simpleShortcutWrites=[];window.simpleShortcutSteps=[];
    Object.defineProperty(window,'isTauri',{value:true});
    Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:Record<string,unknown>={})=>{
      if (command==='desktop_launch_read') return {directoryReceipt:null,hostReceipt:null,notice:null};
      if (command==='ui_locale_status') return {nativeAuthority:false};
      if (command==='app_lock_status') return {initialized:true,supported:false,reason:'Synthetic shortcut access fixture.',enabled:false,locked:false,generation:'0'};
      if (command==='app_lock_ready' || command==='adopt_session') return;
      if (command==='list_hosts') return [];
      if (command === 'app_icon_status') return {available: false, current: 'unknown', reason: 'Alternate Home Screen icons require iOS; synthetic fixture.'};
      if (command==='local_capability') return {available:true,reason:'Synthetic shortcut fixture; no shell runs.'};
      if (command==='local_connect') {
        window.simpleShortcutOutput=text=>(args.events as {onmessage:(event:unknown)=>void}).onmessage({type:'data',data:Array.from(new TextEncoder().encode(text))});
        return {sessionId:'local:shortcut-fixture'};
      }
      if (command==='local_write') {
        const steps=args.steps as string[]|undefined;
        if(steps)window.simpleShortcutSteps.push(steps);
        window.simpleShortcutWrites.push(steps?steps.join(''):args.data as string);
        if(window.simpleShortcutWriteFailure)throw {kind:window.simpleShortcutWriteFailure,message:'Owned queue failure'};
        return;
      }
      if (['local_resize','local_ack','local_disconnect'].includes(command))return;
      if (command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected shortcut fixture command: ${command}`);
    }}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Keyboard chords',{exact:true}).click();
}

async function openExpandedDpad(page:Page,phone:boolean) {
  await fixture(page);
  await page.getByText('Toolbar keys and order',{exact:true}).click();
  await page.getByRole('button',{name:'Add dpad',exact:true}).click();
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await page.getByRole('button',{name:'dpad',exact:true}).click();
}
async function observeDpadPointers(page:Page) {
  await page.evaluate(()=>{const events:unknown[]=[];Reflect.set(window,'dpadEvents',events);for(const type of ['pointerdown','pointermove','pointerup','gotpointercapture','lostpointercapture'])document.addEventListener(type,event=>{const pointer=event as PointerEvent;events.push({type,x:pointer.clientX,y:pointer.clientY,id:pointer.pointerId,primary:pointer.isPrimary,target:(event.target as HTMLElement).className});},true);});
}

test('expanded D-pad pans one held pointer with paced bytes and an idle dead zone',async({page},testInfo)=>{
  await openExpandedDpad(page,testInfo.project.name==='phone');
  const up=page.getByRole('button',{name:'D-pad up',exact:true});
  await up.scrollIntoViewIfNeeded();await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+1000));
  const box=(await up.boundingBox())!,origin={x:box.x+box.width/2,y:box.y+box.height/2};
  const cdp=await page.context().newCDPSession(page);
  const touch=testInfo.project.name==='phone';
  const move=async(x:number,y:number)=>{
    if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y}]});
    else await page.mouse.move(x,y);
    await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'dpadEvents').filter((event:{type:string})=>event.type==='pointermove').at(-1))).toMatchObject({x,y});
  };
  await observeDpadPointers(page);
  const writes=()=>page.evaluate(()=>window.simpleShortcutWrites);
  if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
  else{await page.mouse.move(origin.x,origin.y);await page.mouse.down();}
  await page.clock.runFor(399);expect(await writes()).toEqual([]);
  await page.clock.runFor(1);expect(await writes()).toEqual(['\x1b[A']);
  await move(origin.x+40,origin.y);
  expect(await writes()).toEqual(['\x1b[A']);await page.clock.runFor(80);
  expect(await writes()).toEqual(['\x1b[A','\x1b[C']);
  await move(origin.x,origin.y);await page.clock.runFor(800);
  expect(await writes(),JSON.stringify(await page.evaluate(()=>Reflect.get(window,'dpadEvents')))).toEqual(['\x1b[A','\x1b[C']);
  await move(origin.x,origin.y+40);await page.clock.runFor(80);
  expect(await writes()).toEqual(['\x1b[A','\x1b[C','\x1b[B']);
  if(touch)await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  else await page.mouse.up();
  await page.clock.runFor(1000);expect(await writes()).toEqual(['\x1b[A','\x1b[C','\x1b[B']);
  await expect(up).not.toHaveAttribute('aria-pressed');
  await up.focus();await page.keyboard.press('Enter');
  expect(await writes()).toEqual(['\x1b[A','\x1b[C','\x1b[B','\x1b[A']);
  await page.screenshot({path:testInfo.outputPath('expanded-dpad.png')});
});

test('expanded D-pad rejects a secondary contact and admits a later primary touch',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Requires two real touch contacts.');
  await openExpandedDpad(page,true);await observeDpadPointers(page);
  const up=page.getByRole('button',{name:'D-pad up',exact:true});await up.scrollIntoViewIfNeeded();
  const box=(await up.boundingBox())!,first={id:1,x:5,y:5},second={id:2,x:box.x+box.width/2,y:box.y+box.height/2};
  await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+1000));
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first]});
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[first,second]});
  await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'dpadEvents').filter((event:{type:string})=>event.type==='pointerdown').map((event:{primary:boolean})=>event.primary))).toEqual([true,false]);
  await page.clock.runFor(800);expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.clock.runFor(800);expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...second,id:3}]});
  await page.clock.runFor(400);expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[A']);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.clock.runFor(800);expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[A']);
  const events=await page.evaluate(()=>Reflect.get(window,'dpadEvents')) as Array<{type:string;primary:boolean;id:number;target:string}>;
  const starts=events.filter(event=>event.type==='pointerdown');expect(starts.map(event=>event.primary)).toEqual([true,false,true]);
  for(const type of ['gotpointercapture','lostpointercapture'])expect(events.some(event=>event.type===type&&event.id===starts[2].id&&event.target==='terminal-dpad')).toBe(true);
  await testInfo.attach('dpad-primary-capture-events.json',{body:JSON.stringify(events),contentType:'application/json'});
  await page.getByRole('button',{name:'D-pad left corner',exact:true}).tap();
  await page.getByRole('button',{name:'D-pad right corner',exact:true}).tap();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[A','\x03','\x7f']);
});

test('delayed terminal controls preserve modal form focus and resume input after dismissal',async({page},testInfo)=>{
  await fixture(page);
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.locator('.terminal-canvas .xterm-helper-textarea')).toHaveCount(1);
  await page.evaluate(()=>{
    const request=window.requestAnimationFrame,frames:FrameRequestCallback[]=[];
    window.requestAnimationFrame=callback=>frames.push(callback);
    Object.assign(window,{
      restoreTerminalFrames:()=>{window.requestAnimationFrame=request;},
      flushTerminalFrames:()=>{for(const callback of frames.splice(0))callback(performance.now());},
    });
    (document.querySelector('button[aria-label="Compose"]') as HTMLButtonElement).click();
  });
  await expect(page.getByLabel('Compose text',{exact:true})).toBeVisible();
  await page.evaluate(()=>Reflect.get(window,'restoreTerminalFrames')());
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Appearance');
  const field=page.getByRole('spinbutton',{name:'Font size',exact:true});
  await field.fill('17');
  await page.evaluate(()=>Reflect.get(window,'flushTerminalFrames')());
  await expect(field).toBeFocused();
  await page.keyboard.press('ArrowUp');await expect(field).toHaveValue('18');
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  await page.getByRole('button',{name:'Close composer',exact:true}).click();
  await expect(page.locator('.terminal-canvas .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('owned-after-modal');
  expect((await page.evaluate(()=>window.simpleShortcutWrites)).join('')).toBe('owned-after-modal');
});

test('momentary terminal touch feedback clears after release while modifiers remain intentional',async({page},testInfo)=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  await fixture(page);
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  if(testInfo.project.name==='phone') await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await page.clock.install();
  const keys=page.getByLabel('Terminal keys',{exact:true});
  const colors=(button:import('@playwright/test').Locator)=>button.evaluate(element=>({background:getComputedStyle(element).backgroundColor,color:getComputedStyle(element).color}));
  const resting=await colors(keys.getByRole('button',{name:'esc',exact:true}));
  const activate=async(button:import('@playwright/test').Locator)=>{
    if(testInfo.project.name==='phone') await button.tap();
    else {await button.click();await page.mouse.move(0,0);}
  };
  const expected:string[]=[];
  for(const [name,bytes] of [['tab','\t'],['Arrow right','\x1b[C']]){
    const button=keys.getByRole('button',{name,exact:true});
    await activate(button);
    expected.push(bytes); await page.clock.runFor(1000);
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(expected);
    expect(await button.getAttribute('aria-pressed')).toBeNull();
    await testInfo.attach(`${name}-state.json`,{body:JSON.stringify({hover:await button.evaluate(element=>element.matches(':hover')),pressed:await button.getAttribute('aria-pressed'),colors:await colors(button),writes:expected}),contentType:'application/json'});
    await page.screenshot({path:testInfo.outputPath('momentary-toolbar.png')});
    await expect.poll(()=>colors(button)).toEqual(resting);
  }
  for(const name of ['ctrl','Alt']){
    const modifier=keys.getByRole('button',{name:new RegExp(`^${name}(?: · lock)?$`)});
    await activate(modifier);await expect(modifier).toHaveAttribute('aria-pressed','true');
    expect(await colors(modifier)).not.toEqual(resting);
    await activate(modifier);await expect(modifier).toContainText('lock');
    await activate(modifier);await expect(modifier).toHaveAttribute('aria-pressed','false');
    await expect.poll(()=>colors(modifier)).toEqual(resting);
  }
  const shift=keys.getByRole('button',{name:'Shift',exact:true});
  await activate(shift);await expect(shift).toHaveAttribute('aria-pressed','true');
  expect(await colors(shift)).not.toEqual(resting);await activate(shift);
  const right=keys.getByRole('button',{name:'Arrow right',exact:true});
  await right.scrollIntoViewIfNeeded();
  const point=(await right.boundingBox())!;
  const cdp=await page.context().newCDPSession(page);
  const location={x:point.x+point.width/2,y:point.y+point.height/2};
  if(testInfo.project.name==='phone') await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[location]});
  else {await page.mouse.move(location.x,location.y);await page.mouse.down();}
  if(testInfo.project.name==='desktop') expect(await colors(right)).not.toEqual(resting);
  await page.clock.runFor(560);
  const held=await page.evaluate(()=>window.simpleShortcutWrites);
  expect(held.slice(0,expected.length)).toEqual(expected);
  expect(held.length).toBeGreaterThanOrEqual(expected.length+2);
  expect(held.slice(expected.length).every(value=>value==='\x1b[C')).toBe(true);
  if(testInfo.project.name==='phone') await cdp.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});
  else {await page.mouse.up();await page.mouse.move(0,0);}
  const released=await page.evaluate(()=>window.simpleShortcutWrites);
  expect(released.slice(0,held.length)).toEqual(held);
  expect(released.slice(held.length).every(value=>value==='\x1b[C')).toBe(true);
  await page.clock.runFor(1000);expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(released);
  await expect.poll(()=>colors(right)).toEqual(resting);
  if(testInfo.project.name==='desktop') {
    await right.hover();expect(await colors(right)).not.toEqual(resting);await page.mouse.move(0,0);
  }
  await right.focus();await page.keyboard.press('Shift+Tab');await page.keyboard.press('Tab');
  await expect(right).toBeFocused();
  expect(await right.evaluate(element=>getComputedStyle(element).outlineStyle)).not.toBe('none');
  await page.keyboard.down('Space');
  await expect.poll(()=>right.evaluate(element=>element.matches(':active'))).toBe(true);
  await expect.poll(()=>colors(right)).not.toEqual(resting);
  await page.keyboard.up('Space');
  await expect.poll(()=>colors(right)).toEqual(resting);
  await keys.evaluate(element=>{element.style.setProperty('--theme-control','rgb(10, 20, 30)');element.style.setProperty('--theme-text','rgb(220, 230, 240)');element.style.setProperty('--theme-hover','rgb(40, 50, 60)');element.style.setProperty('--theme-accent','rgb(70, 80, 90)');});
  await activate(right);
  await expect.poll(()=>colors(right)).toEqual({background:'rgb(10, 20, 30)',color:'rgb(220, 230, 240)'});
  await activate(shift);
  await expect.poll(()=>colors(shift)).toEqual({background:'rgb(40, 50, 60)',color:'rgb(70, 80, 90)'});
});


test('Simple custom text survives reload and sends exact toolbar bytes only on explicit click',async({page})=>{
  await fixture(page);
  await expect(page.getByLabel('Shortcut builder')).toHaveValue('advanced');
  await page.getByLabel('Shortcut builder').selectOption('simple');
  await page.getByLabel('Control',{exact:true}).check();
  const cases=[['Prefix','b1','\x021'],['Groups','a,b','\x01\x02'],['Comma','a,,b','\x01,b'],['Spaces',' b ','\x00b ']];
  for (const [label,text] of cases) {
    await page.getByLabel('Chord name',{exact:true}).fill(label);
    await page.getByLabel('Custom shortcut text').fill(text);
    await page.getByRole('button',{name:'Add chord',exact:true}).click();
  }
  await page.getByLabel('Control',{exact:true}).uncheck();
  await page.getByLabel('Chord name',{exact:true}).fill('Unicode');
  await page.getByLabel('Custom shortcut text').fill(' 你好,, 😀 ');
  await page.getByRole('button',{name:'Add chord',exact:true}).click();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await page.reload();
  if ((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.getByLabel('Terminal keys',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  for (const [label] of cases) await page.getByLabel('Terminal keys',{exact:true}).getByRole('button',{name:label,exact:true}).click();
  await page.getByLabel('Terminal keys',{exact:true}).getByRole('button',{name:'Unicode',exact:true}).click();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([...cases.map(item=>item[2]),' 你好,, 😀 ']);
  expect(await page.evaluate(()=>window.simpleShortcutSteps)).toEqual([['\x02','1'],['\x01','\x02'],['\x01',',','b'],['\x00','b',' '],[' 你好,, 😀 ']]);
});

test('Simple limits and unsupported modifiers reject saving without truncating the entered text',async({page})=>{
  await fixture(page);
  await page.getByLabel('Shortcut builder').selectOption('simple');
  await page.getByLabel('Chord name',{exact:true}).fill('Rejected');
  await page.getByLabel('Custom shortcut text').fill('x'.repeat(124));
  await page.getByRole('button',{name:'Add chord',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('123');
  await expect(page.getByLabel('Custom shortcut text')).toHaveValue('x'.repeat(124));
  await page.getByLabel('Custom shortcut text').fill('a\nb');
  await page.getByRole('button',{name:'Add chord',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('printable text');
  await expect(page.getByLabel('Custom shortcut text')).toHaveValue('a\nb');
  await page.getByLabel('Control',{exact:true}).check();
  for (const [text,error] of [['b你好','ASCII'],['abcdefghi','8 resulting'],['a,','comma-separated'],['1','Ctrl is unsupported']]) {
    await page.getByLabel('Custom shortcut text').fill(text);
    await page.getByRole('button',{name:'Add chord',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText(error);
    await expect(page.getByLabel('Custom shortcut text')).toHaveValue(text);
  }
  await expect(page.getByRole('button',{name:'Remove chord Rejected',exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
});

test('custom gesture and D-pad builders save isolated bindings and send only on explicit activation',async({page})=>{
  await fixture(page);
  await openPreferenceCategory(page,'Input');
  await page.getByText('Terminal touch gestures',{exact:true}).click();
  await page.getByRole('combobox',{name:'Single tap',exact:true}).selectOption('custom');
  await page.getByLabel('Single tap chord',{exact:true}).fill('F12, M-h');
  await page.getByRole('button',{name:'Save Single tap chord',exact:true}).click();
  await page.getByRole('combobox',{name:'Single tap shortcut builder',exact:true}).selectOption('simple');
  await page.getByRole('textbox',{name:'Single tap custom shortcut text',exact:true}).fill(' 你好,, 😀 ');
  await page.getByRole('combobox',{name:'D-pad left corner',exact:true}).selectOption('custom');
  await page.getByRole('combobox',{name:'D-pad left corner shortcut builder',exact:true}).selectOption('simple');
  await page.getByLabel('D-pad left corner Control',{exact:true}).check();
  await page.getByRole('textbox',{name:'D-pad left corner custom shortcut text',exact:true}).fill('a,,b');
  await page.getByRole('combobox',{name:'Single tap shortcut builder',exact:true}).selectOption('advanced');
  await expect(page.getByLabel('Single tap chord',{exact:true})).toHaveValue('F12, M-h');
  await page.getByRole('combobox',{name:'Single tap shortcut builder',exact:true}).selectOption('simple');
  await expect(page.getByRole('textbox',{name:'Single tap custom shortcut text',exact:true})).toHaveValue(' 你好,, 😀 ');
  await page.getByRole('button',{name:'Save Single tap chord',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'D-pad left corner custom shortcut text',exact:true})).toHaveValue('a,,b');
  await page.getByRole('button',{name:'Save D-pad left corner chord',exact:true}).click();
  await page.getByRole('combobox',{name:'Two-finger swipe right',exact:true}).selectOption('custom');
  await page.getByRole('combobox',{name:'Two-finger swipe right shortcut builder',exact:true}).selectOption('simple');
  await page.getByLabel('Two-finger swipe right Option / Alt',{exact:true}).check();
  await page.getByRole('textbox',{name:'Two-finger swipe right custom shortcut text',exact:true}).fill('b1');
  await page.getByRole('button',{name:'Save Two-finger swipe right chord',exact:true}).click();
  await page.getByText('Toolbar keys and order',{exact:true}).click();
  await page.getByRole('button',{name:'Add dpad',exact:true}).click();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).gestureChords)).toEqual({tap:'text: 你好,, 😀 ',cornerLeft:'C-a comma b',twoRight:'M-b 1'});
  await page.reload();
  await openGestureSettings(page);
  await expect(page.getByLabel('Single tap chord',{exact:true})).toHaveValue('text: 你好,, 😀 ');
  await expect(page.getByLabel('D-pad left corner chord',{exact:true})).toHaveValue('C-a comma b');
  await expect(page.getByLabel('Two-finger swipe right chord',{exact:true})).toHaveValue('M-b 1');
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  if ((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.getByLabel('Terminal keys',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await page.getByLabel('Terminal keys',{exact:true}).getByRole('button',{name:'dpad',exact:true}).click();
  await page.getByRole('button',{name:'D-pad left corner',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x01,b']);
  const terminal=page.locator('.terminal-canvas');
  await terminal.dispatchEvent('pointerdown',{pointerId:1,pointerType:'touch',clientX:100,clientY:100});
  await terminal.dispatchEvent('pointerup',{pointerId:1,pointerType:'touch',clientX:100,clientY:100});
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x01,b',' 你好,, 😀 ']);
  expect(await page.evaluate(()=>window.simpleShortcutSteps)).toEqual([['\x01',',','b'],[' 你好,, 😀 ']]);
});

test('invalid slot drafts survive other-slot saves and builder switches never rewrite stored Advanced bindings',async({page})=>{
  await fixture(page);
  await openPreferenceCategory(page,'Input');
  await page.getByText('Terminal touch gestures',{exact:true}).click();
  await saveAdvancedGesture(page, 'Double tap', 'C-b, S-t');
  await page.getByRole('combobox',{name:'Double tap shortcut builder',exact:true}).selectOption('simple');
  await page.getByLabel('Double tap Control',{exact:true}).check();
  await page.getByRole('textbox',{name:'Double tap custom shortcut text',exact:true}).fill('a,');
  await page.getByRole('button',{name:'Save Double tap chord',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('comma-separated');
  await page.getByRole('combobox',{name:'D-pad right corner',exact:true}).selectOption('custom');
  await page.getByLabel('D-pad right corner chord',{exact:true}).fill('text: trailing ');
  await page.getByRole('button',{name:'Save D-pad right corner chord',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('comma-separated');
  await expect(page.getByRole('textbox',{name:'Double tap custom shortcut text',exact:true})).toHaveValue('a,');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).gestureChords)).toEqual({doubleTap:'C-b, S-t',cornerRight:'text: trailing '});
  await page.getByRole('combobox',{name:'Double tap shortcut builder',exact:true}).selectOption('advanced');
  await expectGestureBinding(page, 'Double tap', 'C-b, S-t');
  await page.reload();
  await openGestureSettings(page);
  await expectGestureBinding(page, 'Double tap', 'C-b, S-t');
  await expect(page.getByLabel('D-pad right corner chord',{exact:true})).toHaveValue('text: trailing ');
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
});

for(const initial of ['en','pt-BR','es','en-XA'])test(`${initial} retained parser causes keep literal data and both builder drafts without replaying input`,async({page})=>{
  await fixture(page);
  const setLocale=async(locale:string)=>page.evaluate(async locale=>{
    const{uiI18n}=await import('/src/i18n/core.ts');
    if(locale==='en-XA'){const{enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');await enablePseudoLocale(uiI18n);}else await uiI18n.changeLanguage(locale);
  },locale);
  const labels=()=>page.evaluate(async()=>{const{t}=await import('/src/i18n/core.ts');return {name:t('preferencesChordName'),keys:t('shortcutKeySequence'),builder:t('shortcutShortcutBuilder'),text:t('shortcutCustomShortcutText'),control:t('shortcutControl'),add:t('shortcutAddChord'),unknown:t('validationUnknownKeyValue1',{value1:'{{<key>}}'}),ascii:t('validationWithModifiersUsePrintableASCIIOnlyRemoveModifiersFor')};});
  await setLocale(initial);let names=await labels();
  const rawLabel='RAW {{label}} 中文';
  await page.getByLabel(names.name,{exact:true}).fill(rawLabel);
  const keys=page.getByLabel(names.keys,{exact:true});await keys.fill('Ctrl+{{<key>}}');
  await page.getByRole('button',{name:names.add,exact:true}).click();await keys.focus();
  const keysNode=await keys.elementHandle(),alert=await page.getByRole('alert').elementHandle();
  const before=await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'));
  for(const locale of ['en','pt-BR','es','en-XA']){
    await setLocale(locale);names=await labels();
    await expect(page.getByRole('alert')).toHaveText(names.unknown);
    await expect(page.getByLabel(names.keys,{exact:true})).toHaveValue('Ctrl+{{<key>}}');
    expect(await keysNode!.evaluate(node=>node===document.activeElement)).toBe(true);
    expect(await alert!.evaluate(node=>node.isConnected)).toBe(true);
    expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBe(before);
  }
  await page.getByLabel(names.builder,{exact:true}).selectOption('simple');
  await page.getByLabel(names.control,{exact:true}).check();
  const text=page.getByLabel(names.text,{exact:true});await text.fill('世界<{{raw}}>');
  await page.getByRole('button',{name:names.add,exact:true}).click();await text.focus();
  const textNode=await text.elementHandle();
  for(const locale of ['pt-BR','es','en-XA']){
    await setLocale(locale);names=await labels();
    await expect(page.getByRole('alert')).toHaveText(names.ascii);
    await expect(page.getByLabel(names.text,{exact:true})).toHaveValue('世界<{{raw}}>');
    await expect(page.getByLabel(names.control,{exact:true})).toBeChecked();
    expect(await textNode!.evaluate(node=>node===document.activeElement)).toBe(true);
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
    const size=await page.locator('.preferences-panel').evaluate(node=>({width:node.clientWidth,scroll:node.scrollWidth}));expect(size.scroll).toBeLessThanOrEqual(size.width);
  }
  await page.getByLabel(names.builder,{exact:true}).selectOption('advanced');
  await expect(page.getByLabel(names.keys,{exact:true})).toHaveValue('Ctrl+{{<key>}}');
  await page.getByLabel(names.builder,{exact:true}).selectOption('simple');
  await page.getByLabel(names.text,{exact:true}).fill('a,,b');
  await page.getByRole('button',{name:names.add,exact:true}).click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).chords)).toEqual([{label:rawLabel,keys:'C-a comma b'}]);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await setLocale('en');await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await page.getByLabel('Terminal keys',{exact:true}).getByRole('button',{name:rawLabel,exact:true}).click();
  expect(await page.evaluate(()=>window.simpleShortcutSteps)).toEqual([['\x01',',','b']]);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x01,b']);
});

test('named key pickers persist toolbar and gesture bindings and deliver exact steps after explicit activation',async({page})=>{
  await fixture(page);
  const builder=page.getByLabel('Shortcut builder',{exact:true});
  await builder.selectOption('named');
  await page.getByLabel('Named key',{exact:true}).selectOption('F12');
  await page.getByLabel('Option / Alt',{exact:true}).check();
  await builder.selectOption('simple');
  await expect(page.getByLabel('Option / Alt',{exact:true})).not.toBeChecked();
  await page.getByLabel('Custom shortcut text',{exact:true}).fill(' untouched 世界 ');
  await builder.selectOption('named');
  await expect(page.getByLabel('Named key',{exact:true})).toHaveValue('F12');
  await expect(page.getByLabel('Option / Alt',{exact:true})).toBeChecked();
  await page.getByLabel('Chord name',{exact:true}).fill('Agent action');
  await page.getByRole('button',{name:'Add chord',exact:true}).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Terminal touch gestures',{exact:true}).click();
  await page.getByRole('combobox',{name:'Single tap',exact:true}).selectOption('custom');
  await page.getByLabel('Single tap shortcut builder',{exact:true}).selectOption('named');
  await page.getByLabel('Single tap named key',{exact:true}).selectOption('Tab');
  await page.getByLabel('Single tap Shift',{exact:true}).check();
  await page.getByRole('button',{name:'Save Single tap chord',exact:true}).click();
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!));
  expect(stored.chords).toEqual([{label:'Agent action',keys:'M-F12'}]);
  expect(stored.gestureChords.tap).toBe('S-Tab');
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await page.reload();
  if ((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const toolbar=page.getByLabel('Terminal keys',{exact:true});
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button',{name:'Agent action',exact:true}).click();
  const terminal=page.locator('.terminal-canvas');
  await terminal.dispatchEvent('pointerdown',{pointerId:8,pointerType:'touch',clientX:160,clientY:120});
  await terminal.dispatchEvent('pointerup',{pointerId:8,pointerType:'touch',clientX:160,clientY:120});
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutSteps)).toEqual([['\x1b[24;3~'],['\x1b[Z']]);
});


test('terminal canvas stays anchored when keyboard-sized resizes reveal its input',async({page})=>{
  await fixture(page); await page.keyboard.press('Escape');
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect(page.locator('.terminal-canvas .xterm-screen')).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:200},(_,i)=>`history ${i}\r\n`).join('')));
  const width=(page.viewportSize()?.width??1280)<=600?412:1280;
  for(const height of [659,365,659,365]) {
    await page.setViewportSize({width,height});
    await page.locator('.terminal-canvas .xterm-helper-textarea').evaluate(node=>node.scrollIntoView());
    await expect.poll(()=>page.locator('.terminal-canvas').evaluate(canvas=>{
      const bounds=canvas.getBoundingClientRect(),screen=canvas.querySelector('.xterm-screen')!.getBoundingClientRect();
      return {scroll:canvas.scrollTop,inside:screen.top>=bounds.top&&screen.bottom<=bounds.bottom&&bounds.top>=0&&bounds.bottom<=innerHeight};
    })).toEqual({scroll:0,inside:true});
  }
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
});

test.describe('touch-layout past-bottom keyboard dismissal',()=>{
  test.use({hasTouch:true});
test('optional past-bottom gesture dismisses only idle local history input and preserves normal scrolling',async({page},testInfo)=>{
  if(testInfo.project.name==='phone')await page.setViewportSize({width:393,height:852});
  await expect.poll(()=>page.evaluate(()=>matchMedia('(pointer: coarse)').matches)).toBe(true);
  await fixture(page);
  await page.getByText('Terminal touch gestures',{exact:true}).click();
  const setting=page.getByRole('checkbox',{name:'Hide keyboard when scrolling past local history bottom',exact:true});await expect(setting).not.toBeChecked();
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  if(testInfo.project.name==='phone')await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const canvas=page.locator('.terminal-canvas:visible'),area=canvas.locator('.xterm-helper-textarea'),screen=canvas.locator('.xterm-screen'),viewport=canvas.locator('.xterm-viewport');
  await expect(screen).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:200},(_,index)=>`local history ${index}\r\n`).join('')));
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(500);
  const box=(await screen.boundingBox())!,origin={x:box.x+60,y:box.y+100};
  const input=await page.context().newCDPSession(page);
  await canvas.evaluate(element=>{Reflect.set(window,'overscrollMoves',0);element.addEventListener('touchmove',()=>Reflect.set(window,'overscrollMoves',Reflect.get(window,'overscrollMoves')+1),{capture:true,passive:true});});
  await page.evaluate(()=>{const trace:unknown[]=[];Reflect.set(window,'overscrollTrace',trace);for(const type of ['touchstart','touchmove','touchcancel','touchend'])document.addEventListener(type,event=>{const touch=event as TouchEvent;if(type==='touchstart')Reflect.set(window,'overscrollTarget',event.target);trace.push({type,cancelable:touch.cancelable,target:(event.target as Element).className,tag:(event.target as Element).tagName,points:Array.from(touch.touches,point=>({x:point.clientX,y:point.clientY})),scrollY});},{capture:true,passive:true});});
  const swipe=async(direction:number,partial=false)=>{
    const before=await page.evaluate(()=>Reflect.get(window,'overscrollMoves')) as number;
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
    await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:origin.y+direction*20}]});
    await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'overscrollMoves'))).toBe(before+1);await expect(area).toBeFocused();
    if(!partial){await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:origin.y+direction*60}]});await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'overscrollMoves'))).toBe(before+2).catch(async error=>{await testInfo.attach('overscroll-delivery.json',{body:JSON.stringify({origin,bounds:await screen.boundingBox(),trace:await page.evaluate(()=>Reflect.get(window,'overscrollTrace')),target:await page.evaluate(()=>{const node=Reflect.get(window,'overscrollTarget') as Element;return {connected:node.isConnected,tag:node.tagName,html:node.outerHTML.slice(0,250)};})}),contentType:'application/json'});throw error;});}
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  await canvas.click({position:{x:30,y:30}});await swipe(-1);await expect(area).toBeFocused();
  await (await workspaceControl(page,'Preferences')).click();await openPreferenceCategory(page,'Input');await page.getByText('Terminal touch gestures',{exact:true}).click();
  await setting.check();await page.screenshot({path:testInfo.outputPath('overscroll-setting.png')});
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();await canvas.click({position:{x:30,y:30}});
  const bottom=await viewport.evaluate(node=>node.scrollTop);await swipe(1);await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeLessThan(bottom);await expect(area).toBeFocused();
  await page.mouse.move(origin.x,origin.y);await page.mouse.wheel(0,10000);await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBe(bottom);
  await page.screenshot({path:testInfo.outputPath('overscroll-before.png')});
  await swipe(-1);await expect(area).not.toBeFocused();expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('overscroll-after.png')});
  await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?1049h\x1b[?1000h\x1b[?1006h'));
  await canvas.click({position:{x:30,y:30}});await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  await swipe(-1);await expect(area).toBeFocused();
  expect((await page.evaluate(()=>window.simpleShortcutWrites)).every(bytes=>/^\x1b\[<6[45];\d+;\d+M$/.test(bytes))).toBe(true);
  expect((await page.evaluate(()=>window.simpleShortcutWrites)).length).toBeGreaterThan(0);
});

});

for(const dismissKeyboardOnOverscroll of [false,true])test(`direct finger scrolling uses real xterm history and the same mouse reports as a wheel (dismiss=${dismissKeyboardOnOverscroll})`,async({page})=>{
  await fixture(page);
  if(dismissKeyboardOnOverscroll){await page.getByText('Terminal touch gestures',{exact:true}).click();await page.getByRole('checkbox',{name:'Hide keyboard when scrolling past local history bottom',exact:true}).check();}
  await page.keyboard.press('Escape');
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const screen=page.locator('.terminal-canvas:visible .xterm-screen');
  await expect(screen).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:200},(_,i)=>`history ${i}\r\n`).join('')));
  const viewport=page.locator('.terminal-canvas:visible .xterm-viewport');
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(500);
  const before=await viewport.evaluate(node=>node.scrollTop);
  const box=(await screen.boundingBox())!;
  const x=box.x+60,y=box.y+80;
  const input=await page.context().newCDPSession(page);
  const swipe=async(from:number,to:number)=>{
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y:from}]});
    await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:to}]});
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  };
  await swipe(y,y+60);
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeLessThan(before);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?1049h\x1b[?1000h\x1b[?1006h'));
  await expect(page.locator('.terminal-canvas:visible .xterm')).toHaveClass(/enable-mouse-events/);
  const notch=await screen.evaluate(element=>Math.ceil(element.getBoundingClientRect().height/element.querySelectorAll('.xterm-rows > div').length)+1);
  expect(Number.isFinite(notch)&&notch>0).toBe(true);
  for(const delta of [notch,-notch]){
    await page.mouse.move(x,y+delta);
    await page.mouse.wheel(0,delta);
    await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites.length)).toBe(1);
    const wheel=await page.evaluate(()=>window.simpleShortcutWrites[0]);
    expect(wheel).toMatch(/^\x1b\[<6[45];\d+;\d+M$/);
    await page.evaluate(()=>{window.simpleShortcutWrites=[];});
    await swipe(y+delta,y);
    await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual([wheel]);
    await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  }
  const origin={x,y:y+160};
  const reports=()=>page.evaluate(()=>window.simpleShortcutWrites);
  await page.mouse.move(origin.x,origin.y);
  await page.mouse.wheel(0,notch);
  await page.mouse.wheel(0,-notch);
  await expect.poll(async()=>(await reports()).length).toBe(2);
  const [down,up]=await reports();
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
  const trace=[{x:x+2,y:origin.y-notch},{x:x+110,y:origin.y-notch*2},{x:x+130,y:origin.y-notch*3},{x:x+3,y:origin.y-notch*2}];
  for(const [index,point] of trace.entries()){
    await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[point]});
    await expect.poll(reports).toEqual(Array.from({length:index+1},(_,i)=>i===3?up:down));
  }
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  const next={x:x+80,y:origin.y};
  await page.mouse.move(next.x,next.y);await page.mouse.wheel(0,notch);
  await expect.poll(async()=>(await reports()).length).toBe(1);
  const second=(await reports())[0];expect(second).not.toBe(down);
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[next]});
  await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:next.x+3,y:next.y-notch}]});
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(reports).toEqual([second]);
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  await page.locator('.terminal-canvas:visible').evaluate(element=>element.addEventListener('touchmove',()=>window.simpleShortcutTouchMoves++,{capture:true,passive:true}));
  const batches:string[][]=[];
  for(const segments of [2,8]) {
    await page.evaluate(()=>{window.simpleShortcutWrites=[];window.simpleShortcutTouchMoves=0;});
    const start={x,y:box.y+20};
    expect(start.y+notch*12).toBeLessThan(box.y+box.height);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
    try {
      for(let step=1;step<=segments;step++) {
        await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start.y+notch*12*step/segments}]});
        await expect.poll(()=>page.evaluate(()=>window.simpleShortcutTouchMoves)).toBe(step);
      }
      await expect.poll(async()=>(await reports()).length).toBeGreaterThan(0);
      batches.push(await reports());
    } finally {await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  }
  expect(batches[0]).toHaveLength(12);
  expect(batches[1]).toEqual(batches[0]);
  if(await page.evaluate(()=>matchMedia('(pointer:coarse)').matches)) {
    // A real host redraw replaces xterm spans while the same finger is still down.
    await page.evaluate(()=>window.simpleShortcutOutput('\x1b[2J\x1b[H'+Array.from({length:40},(_,i)=>`owned-row-${i} ${' '.repeat(30)}`).join('\r\n')));
    await expect(screen).toContainText('owned-row-');
    const start=await screen.evaluate(element=>{
      const spans=Array.from(element.querySelectorAll('.xterm-rows span')).filter(node=>node.getBoundingClientRect().width>20);
      const span=spans[Math.floor(spans.length/4)],r=span.getBoundingClientRect(),bounds=element.getBoundingClientRect();
      window.simpleShortcutTouchMoves=0;window.simpleShortcutWrites=[];window.simpleShortcutTouchTarget=null;
      element.closest('.terminal-canvas')!.addEventListener('touchstart',event=>{
        window.simpleShortcutTouchTarget=event.target instanceof Element?event.target:null;
      },{capture:true,passive:true,once:true});
      return {x:r.left+10,y:r.top+r.height/2,travel:Math.min(40,(bounds.bottom-r.bottom)/3)};
    });
    expect(start.travel).toBeGreaterThan(12);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:start.x,y:start.y}]});
    try {
      await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:start.y+start.travel}]});
      await expect.poll(()=>page.evaluate(()=>window.simpleShortcutTouchMoves)).toBe(1);
      await expect.poll(async()=>(await reports()).length).toBeGreaterThan(0);
      const first=(await reports()).length;
      await page.evaluate(()=>window.simpleShortcutOutput('\x1b[2J\x1b[H'+Array.from({length:40},(_,i)=>`updated-owned-row-${i} ${' '.repeat(30)}`).join('\r\n')));
      await expect(screen).toContainText('updated-owned-row-');
      await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y:start.y+start.travel*2}]});
      await expect.poll(()=>page.evaluate(()=>window.simpleShortcutTouchMoves)).toBe(2);
      await expect.poll(async()=>(await reports()).length).toBeGreaterThan(first);
      expect(await page.evaluate(()=>window.simpleShortcutTouchTarget?.isConnected)).toBe(true);
    } finally {await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  }
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?1000l\x1b[?1006l'));
  await expect(page.locator('.terminal-canvas:visible .xterm')).not.toHaveClass(/enable-mouse-events/);
  await page.mouse.wheel(0,60);
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites.length)).toBe(1);
  const arrows=await page.evaluate(()=>window.simpleShortcutWrites[0]);
  expect(arrows).toMatch(/^(\x1b\[B)+$/);
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  await swipe(y+60,y);
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual([arrows]);
  await input.detach();
});


async function openShortcutTerminal(page:Page) {
  await fixture(page);
  await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  if ((page.viewportSize()?.width??1280)<=600) await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
}

for(const android of [false,true])test.describe(android ? 'Android IME' : 'ordinary keyboard',()=>{
  if(android)test.use({userAgent:'Mozilla/5.0 (Linux; Android 14; Owned IME fixture) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'});
test('real xterm DSR failures retain nonuser classification and visible errors',async({page})=>{
  const receipts:string[]=[];
  page.on('console',message=>{if(message.type()==='warning'&&message.text().startsWith('lazysh-terminal-input '))receipts.push(message.text().slice('lazysh-terminal-input '.length));});
  await openShortcutTerminal(page);
  await expect(page.locator('.xterm-helper-textarea')).toBeAttached();
  for(const [kind,cause] of [['backpressure','queue-full'],['input_closed','channel-closed']] as const) {
    await page.evaluate(kind=>{window.simpleShortcutWriteFailure=kind;window.simpleShortcutOutput('\x1b[6n');},kind);
    await expect.poll(()=>receipts.length).toBe(kind==='backpressure'?1:2);
    const writes=await page.evaluate(()=>window.simpleShortcutWrites);
    const response=writes.at(-1)!;
    expect(response).toMatch(/^\x1b\[\d+;\d+R$/);
    expect(JSON.parse(receipts.at(-1)!)).toEqual({caller:'terminal-nonuser',cause,utf16Units:response.length,
      dispatch:{active:true,connected:true,disposed:false,currentOwner:true},receipt:{active:true,connected:true,disposed:false,currentOwner:true}});
    await expect(page.getByText('Owned queue failure',{exact:true})).toBeVisible();
  }
});
test('Haven-style toolbar modifiers classify real xterm IME, paste, mouse and protocol input', async ({page,context}) => {
  await openShortcutTerminal(page);
  const keys=page.getByLabel('Terminal keys',{exact:true});
  const input=page.locator('.xterm-helper-textarea');
  const writes=()=>page.evaluate(()=>window.simpleShortcutWrites);
  const clear=()=>page.evaluate(()=>{window.simpleShortcutWrites=[];});
  const ctrl=()=>keys.getByRole('button',{name:'ctrl',exact:true}).click();
  const alt=()=>keys.getByRole('button',{name:'Alt',exact:true}).click();
  await ctrl(); await input.focus(); await page.keyboard.type('c');
  await expect.poll(writes).toEqual(['\x03']); await clear();
  await alt(); await input.focus(); await page.keyboard.type('x');
  await expect.poll(writes).toEqual(['\x1bx']); await clear();
  const cdp=await context.newCDPSession(page);
  await ctrl(); await input.focus();
  await cdp.send('Input.imeSetComposition',{text:'你',selectionStart:1,selectionEnd:1});
  // DSR during composition must neither acquire modifiers nor consume the pending IME lane.
  await page.evaluate(()=>window.simpleShortcutOutput('\x1b[6n'));
  await expect.poll(async()=> (await writes()).some(value=>/^\x1b\[\d+;\d+R$/.test(value))).toBe(true);
  await cdp.send('Input.insertText',{text:'你好'});
  await expect.poll(async()=> (await writes()).at(-1)).toBe('你好'); await clear();
  await alt(); await input.focus(); await cdp.send('Input.insertText',{text:'世界'});
  await expect.poll(writes).toEqual(['\x1b世界']); await clear();
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await page.evaluate(()=>navigator.clipboard.writeText('c'));
  await ctrl(); await input.focus(); await page.keyboard.press('Control+Shift+v');
  await expect.poll(writes).toEqual(['c']);
  await expect(keys.getByRole('button',{name:'ctrl',exact:true})).toHaveAttribute('aria-pressed','true');
  await clear(); await page.keyboard.type('c'); await expect.poll(writes).toEqual(['\x03']); await clear();
  await alt();
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await page.getByLabel('Compose text',{exact:true}).fill('x');
  await page.getByRole('button',{name:'Paste draft',exact:true}).click();
  await expect.poll(writes).toEqual(['x']);
  await expect(keys.getByRole('button',{name:'Alt',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Close composer',exact:true}).click(); await clear();
  await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?1000h\x1b[?1006h'));
  await input.focus();
  await page.locator('.xterm-screen').click({position:{x:12,y:12}});
  await expect.poll(async()=> (await writes()).some(value=>value.startsWith('\x1b[<'))).toBe(true);
  expect((await writes()).every(value=>!value.startsWith('\x1b\x1b'))).toBe(true);
  await expect(keys.getByRole('button',{name:'Alt',exact:true})).toHaveAttribute('aria-pressed','true');
  await clear(); await page.keyboard.type('x'); await expect.poll(writes).toEqual(['\x1bx']);
  await expect(input).toBeFocused();
  await clear(); await alt(); await alt(); await page.keyboard.type('x');
  await expect.poll(writes).toEqual(['\x1bx']); await clear();
  await page.locator('.xterm-screen').click({position:{x:12,y:12}});
  await expect.poll(async()=> (await writes()).length).toBe(2);
  expect(await writes()).toEqual([expect.stringMatching(/^\x1b\[</),expect.stringMatching(/^\x1b\[</)]);
  await keys.getByRole('button',{name:'Alt · lock',exact:true}).click();
  await clear(); await keys.getByRole('button',{name:'ctrl',exact:true}).click();
  await expect(input).toBeFocused();
  if ((page.viewportSize()?.width??1280)<=600) {
    const bounds=await keys.boundingBox(); if (!bounds) throw new Error('toolbar must be visible');
    const y=bounds.y+bounds.height/2, x=bounds.x+bounds.width-30;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for (const offset of [30,80,160]) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-offset,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(()=>keys.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
    expect(await writes()).toEqual([]);
  }
});

for(const [label,expected] of [['ctrl','\x03'],['Alt','\x1bc']] as const)test(`current preedit stays literal when ${label} latches before a fresh native key and release`,async({page,context})=>{
  await openShortcutTerminal(page);
  const input=page.locator('.xterm-helper-textarea'),keys=page.getByLabel('Terminal keys',{exact:true});
  const writes=()=>page.evaluate(()=>window.simpleShortcutWrites);
  const modifier=()=>keys.getByRole('button',{name:label,exact:true}).click();
  const cdp=await context.newCDPSession(page);
  await input.focus();
  await cdp.send('Input.imeSetComposition',{text:'a',selectionStart:1,selectionEnd:1});
  expect(await writes()).toEqual([]);
  await modifier();const afterLatch=await writes();
  await modifier();
  await expect(keys.getByRole('button',{name:`${label} · lock`,exact:true})).toHaveAttribute('aria-pressed','true');
  await cdp.send('Input.insertText',{text:'c'});
  await expect.poll(async()=>(await writes()).at(-1)).toBe(expected);
  await keys.getByRole('button',{name:`${label} · lock`,exact:true}).click();
  await expect(keys.getByRole('button',{name:label,exact:true})).toHaveAttribute('aria-pressed','false');
  await cdp.send('Input.insertText',{text:'plain'});
  await expect.poll(async()=>(await writes()).at(-1)).toBe('plain');
  expect(afterLatch).toEqual(['a']);
  expect(await writes()).toEqual(['a',expected,'plain']);
  await cdp.detach();
});

test('terminal completion hints stay distinct from the normal Compose editor',async({page})=>{
  await openShortcutTerminal(page);
  const input=page.locator('.xterm-helper-textarea');
  expect(await input.getAttribute('autocomplete')).toBe(android?'off':null);
  await expect(input).toHaveAttribute('autocorrect','off');
  await expect(input).toHaveAttribute('autocapitalize','off');
  await expect(input).toHaveAttribute('spellcheck','false');
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  const composer=page.getByLabel('Compose text',{exact:true});
  expect(await composer.getAttribute('autocomplete')).toBeNull();
  expect(await composer.getAttribute('autocorrect')).toBeNull();
  expect(await composer.evaluate(element=>element.tagName)).toBe('TEXTAREA');
});

});

for(const truncated of [false,true])test(`unapplied inline input review preserves Compose and copy safety with truncated=${truncated}`,async({page,context})=>{
  await openShortcutTerminal(page);
  await page.evaluate(()=>{
    window.simpleShortcutCopies=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{window.simpleShortcutCopies.push(text);}}});
  });
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await page.getByRole('textbox',{name:'Compose text',exact:true}).fill('keep my draft');
  await page.getByRole('button',{name:'Close composer',exact:true}).click();
  const input=page.locator('.xterm-helper-textarea');await input.focus();
  await input.evaluate(async(element,truncated)=>{
    const area=element as HTMLTextAreaElement;
    for(const value of ['éx',truncated?'x'.repeat(65535)+'👩tail':'èy']){
      area.dispatchEvent(new KeyboardEvent('keydown',{key:'Unidentified',keyCode:229,bubbles:true,composed:true}));
      area.value=value;area.setSelectionRange(value.length,value.length);
      area.dispatchEvent(new InputEvent('input',{data:value,inputType:'insertReplacementText',bubbles:true,composed:true}));
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  },truncated);
  const review=page.locator('.terminal-edit-review');
  await expect(review).toBeVisible();await expect(review.locator('pre')).not.toBeVisible();
  await review.locator('summary').click();
  await expect(review.getByText('Unapplied local input context. The terminal is unchanged.',{exact:true})).toBeVisible();
  const copy=review.getByRole('button',{name:'Copy context',exact:true});
  if(truncated){await expect(copy).toBeDisabled();await expect(review.getByRole('status')).toHaveText('Context exceeds the review limit. Copy is unavailable.');}
  else {await copy.click();await expect.poll(()=>page.evaluate(()=>window.simpleShortcutCopies)).toEqual(['èy']);}
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Compose text',exact:true})).toHaveValue('keep my draft');
  await expect(page.getByRole('button',{name:'Paste draft',exact:true})).toBeDisabled();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['éx']);
  await review.getByRole('button',{name:'Dismiss and resume typing',exact:true}).click();
  await expect(review).toHaveCount(0);
  await expect(page.getByRole('textbox',{name:'Compose text',exact:true})).toHaveValue('keep my draft');
  const cdp=await context.newCDPSession(page);await cdp.send('Input.insertText',{text:'new'});await cdp.detach();
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['éx','new']);
  if(truncated)expect(await page.evaluate(()=>window.simpleShortcutCopies)).toEqual([]);
});

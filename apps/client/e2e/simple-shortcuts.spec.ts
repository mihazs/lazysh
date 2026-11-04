import {openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';
import { openGestureSettings, saveAdvancedGesture, expectGestureBinding } from './fixtures/gestureSettings';
import {expect,test,type Page} from '@playwright/test';
import {installLocalTerminal} from './fixtures/localTerminal';

async function fixture(page:Page) {
  await installLocalTerminal(page);
  await page.goto('/');
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
  await page.getByText('Keyboard chords',{exact:true}).click();
}

async function openExpandedDpad(page:Page,phone:boolean) {
  await fixture(page);
  await openPreferenceCategory(page,'Input');
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

test('expanded D-pad keeps the composer editable in a keyboard-sized viewport',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Mobile keyboard viewport');
  await openExpandedDpad(page,true);
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  const editor=page.getByLabel('Compose text',{exact:true});
  await expect(page.getByRole('button',{name:'D-pad up',exact:true})).toHaveCount(0);
  // Touch layouts yield the key row to the composer sheet; the D-pad still closes.
  await expect(page.locator('.terminal-keys').getByRole('button',{name:'dpad',exact:true,includeHidden:true})).toHaveAttribute('aria-pressed','false');
  for(const height of [659,360]){
    await page.setViewportSize({width:411,height});
    if(height===360)await page.getByRole('button',{name:'Compose',exact:true}).click();
    await page.screenshot({path:testInfo.outputPath(`dpad-compose-${height}.png`)});
    expect((await editor.boundingBox())!.height).toBeGreaterThan(16);
    await editor.fill('Owned draft');
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect(editor).toHaveCount(0);
  }
  expect(await page.evaluate(()=>window.simpleShortcutSteps)).toEqual([['Owned draft','\r'],['Owned draft','\r']]);
});

test('D-pad context menus are cancelled without consuming unrelated menus or terminal input',async({page},testInfo)=>{
  await openExpandedDpad(page,testInfo.project.name==='phone');
  await page.evaluate(()=>{
    const events:unknown[]=[];Reflect.set(window,'dpadMenus',events);
    document.addEventListener('contextmenu',event=>events.push({
      pad:event.target instanceof Element && Boolean(event.target.closest('.terminal-dpad')),
      trusted:event.isTrusted,cancelable:event.cancelable,prevented:event.defaultPrevented,
    }));
  });
  const up=page.getByRole('button',{name:'D-pad up',exact:true});
  await up.click({button:'right'});
  await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'dpadMenus'))).toEqual([
    {pad:true,trusted:true,cancelable:true,prevented:true},
  ]);
  await page.getByRole('button',{name:'Compose',exact:true}).click({button:'right'});
  await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'dpadMenus'))).toEqual([
    {pad:true,trusted:true,cancelable:true,prevented:true},
    {pad:false,trusted:true,cancelable:true,prevented:false},
  ]);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await up.click();
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[A']);
});

test('physical and toolbar Shift+Enter preserve the agent newline key',async({page})=>{
  await openShortcutTerminal(page);
  await page.locator('.terminal-canvas').click();
  await page.keyboard.press('Shift+Enter');
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[13;2u']);
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[13;2u','\r']);
  await page.getByRole('button',{name:'Shift',exact:true}).click();
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[13;2u','\r','\x1b[13;2u']);
  await expect(page.getByRole('button',{name:'Shift',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[13;2u','\r','\x1b[13;2u','\r']);
});

test('trusted keyless line breaks preserve plain and toolbar Shift Enter',async({page,context})=>{
  await openShortcutTerminal(page);await page.locator('.terminal-canvas').click();
  const cdp=await context.newCDPSession(page);
  await cdp.send('Input.insertText',{text:'\n'});
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\r']);
  await page.getByRole('button',{name:'Shift',exact:true}).click();
  await cdp.send('Input.insertText',{text:'\n'});await cdp.send('Input.insertText',{text:'a'});
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\r','\x1b[13;2u','a']);
  await expect(page.getByRole('button',{name:'Shift',exact:true})).toHaveAttribute('aria-pressed','false');
  await cdp.detach();
});

test('physical Enter and keyless line breaks remain distinct without duplicate keydown output',async({page,context})=>{
  await openShortcutTerminal(page);await page.locator('.terminal-canvas').click();
  const cdp=await context.newCDPSession(page);
  const key={key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13};
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',...key});
  await cdp.send('Input.insertText',{text:'\n'});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...key});
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\r']);
  await cdp.send('Input.insertText',{text:'\n'});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',...key});
  await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',...key});
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\r','\r','\r']);
  await cdp.detach();
});

test('one-shot Shift keeps one held arrow shifted and leaves the next key plain',async({page},testInfo)=>{
  await openShortcutTerminal(page);await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+1000));
  const shift=page.getByRole('button',{name:'Shift',exact:true}),left=page.getByRole('button',{name:'Arrow left',exact:true});
  const colors=()=>shift.evaluate(element=>({background:getComputedStyle(element).backgroundColor,color:getComputedStyle(element).color}));
  const resting=await colors();await shift.click();await expect(shift).toHaveAttribute('aria-pressed','true');
  await left.scrollIntoViewIfNeeded();const box=(await left.boundingBox())!,point={x:box.x+box.width/2,y:box.y+box.height/2};
  const cdp=await page.context().newCDPSession(page);
  if(testInfo.project.name==='phone')await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
  else {await page.mouse.move(point.x,point.y);await page.mouse.down();}
  await page.clock.runFor(560);
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[1;2D','\x1b[1;2D','\x1b[1;2D']);
  await expect(shift).toHaveAttribute('aria-pressed','false');await expect.poll(colors).toEqual(resting);
  if(testInfo.project.name==='phone')await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});else await page.mouse.up();
  await page.clock.runFor(800);expect(await page.evaluate(()=>window.simpleShortcutWrites)).toHaveLength(3);
  await page.getByRole('button',{name:'Arrow right',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[1;2D','\x1b[1;2D','\x1b[1;2D','\x1b[C']);
});

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

test('delayed terminal controls preserve modal form focus and resume input after dismissal',async({page})=>{
  await openShortcutTerminal(page);
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
  await openPreferenceCategory(page,'Input');
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
  await openShortcutTerminal(page);
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

for(const fontSize of [14,17])test(`slow fractional finger motion preserves normal-buffer scroll distance at font ${fontSize}`,async({page},testInfo)=>{
  await openShortcutTerminal(page);
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
  if(fontSize!==14) {
    await (await workspaceControl(page,'Preferences')).click();await openPreferenceCategory(page,'Appearance');
    await page.getByLabel('Font size',{exact:true}).fill(String(fontSize));
    await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
  }
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:300},(_,i)=>`fractional history ${i}\r\n`).join('')));
  const viewport=page.locator('.terminal-canvas:visible .xterm-viewport');
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(1000);
  const box=(await page.locator('.terminal-canvas:visible .xterm-screen').boundingBox())!;
  const input=await page.context().newCDPSession(page);
  const distance=await page.locator('.terminal-canvas:visible .xterm-screen').evaluate(node=>node.getBoundingClientRect().height/node.querySelectorAll('.xterm-rows > div').length*3);
  const results:unknown[]=[];
  await viewport.evaluate(node=>{const samples:number[]=[];Reflect.set(window,'fractionalWheels',samples);node.closest('.xterm')!.addEventListener('wheel',event=>samples.push((event as WheelEvent).deltaY));});
  for(const segments of [1,120]) {
    await viewport.evaluate(node=>{node.scrollTop=node.scrollHeight;});
    await expect(page.locator('.terminal-canvas:visible .xterm-rows')).toContainText('fractional history 299');
    const before=await viewport.evaluate(node=>node.scrollTop);
    await page.evaluate(()=>{(Reflect.get(window,'fractionalWheels') as number[]).length=0;});
    const bounds=(await page.locator('.terminal-canvas:visible').boundingBox())!;
    const origin={x:testInfo.project.name==='phone'?box.x+60:bounds.x+bounds.width-1,y:box.y+60};
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
    for(let step=1;step<=segments;step++)await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:origin.y+distance*step/segments}]});
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(async()=>before-await viewport.evaluate(node=>node.scrollTop)).toBeGreaterThanOrEqual(distance-1);
    const travel=before-await viewport.evaluate(node=>node.scrollTop);
    results.push({segments,travel,wheels:await page.evaluate(()=>Reflect.get(window,'fractionalWheels'))});
    await testInfo.attach(`normal-fractional-${segments}`,{body:JSON.stringify(results),contentType:'application/json'});
    expect(travel).toBeGreaterThanOrEqual(distance-1);
    expect(travel).toBeLessThanOrEqual(distance+1);
  }
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
});

test('direct finger scrolling uses real xterm history and the same mouse reports as a wheel',async({page},testInfo)=>{
  await openShortcutTerminal(page);
  const screen=page.locator('.terminal-canvas:visible .xterm-screen');
  await expect(screen).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:200},(_,i)=>`history ${i}\r\n`).join('')));
  const viewport=page.locator('.terminal-canvas:visible .xterm-viewport');
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(500);
  const before=await viewport.evaluate(node=>node.scrollTop);
  const box=(await screen.boundingBox())!;
  const x=box.x+60,y=box.y+80;
  const hitTargets=await page.locator('.terminal-canvas:visible').evaluate(canvas=>{
    const selectors=['.terminal-canvas','.xterm-screen','.xterm-viewport','.xterm-helper-textarea'];
    return selectors.map(selector=>{
      const element=selector==='.terminal-canvas'?canvas:canvas.querySelector(selector)!;
      const r=element.getBoundingClientRect(),candidates=[[r.left+r.width/2,r.top+r.height/2],[r.left+1,r.top+1],[r.right-1,r.bottom-1]];
      return {selector,width:r.width,height:r.height,points:candidates.map(([x,y])=>({x,y,hit:document.elementFromPoint(x,y)?.className}))};
    });
  });
  await testInfo.attach('touch-hit-targets',{body:JSON.stringify(hitTargets),contentType:'application/json'});
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
  await page.locator('.terminal-canvas:visible').evaluate(element=>{
    element.addEventListener('touchmove',()=>window.simpleShortcutTouchMoves++,{capture:true,passive:true});
    element.addEventListener('pointermove',()=>window.simpleShortcutPointerMoves++,{capture:true,passive:true});
    element.addEventListener('touchstart',event=>{window.simpleShortcutTouchTarget=event.target instanceof Element?event.target:null;},{capture:true,passive:true});
  });
  const batches:string[][]=[],deliveries:unknown[]=[];
  const row=await screen.evaluate(element=>element.getBoundingClientRect().height/element.querySelectorAll('.xterm-rows > div').length);
  for(const segments of [1,2,8,48]) {
    await page.evaluate(()=>{window.simpleShortcutWrites=[];window.simpleShortcutTouchMoves=0;window.simpleShortcutPointerMoves=0;});
    const start={x,y:box.y+20};
    expect(start.y+row*12).toBeLessThan(box.y+box.height);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
    try {
      for(let step=1;step<=segments;step++) {
        await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:start.y+row*12*step/segments}]});
        if(segments<=8)await expect.poll(()=>page.evaluate(()=>window.simpleShortcutTouchMoves)).toBe(step);
      }
      await expect.poll(async()=>(await reports()).length).toBeGreaterThan(0);
      batches.push(await reports());
      deliveries.push(await page.evaluate(segments=>({segments,pointers:window.simpleShortcutPointerMoves,touches:window.simpleShortcutTouchMoves,
        target:window.simpleShortcutTouchTarget?.className,writes:window.simpleShortcutWrites}),segments));
    } finally {await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  }
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  const diagonal={x:x+10,y:box.y+25};
  await page.mouse.move(diagonal.x,diagonal.y);await page.mouse.wheel(0,notch);
  await expect.poll(async()=>(await reports()).length).toBe(1);
  const angledReport=(await reports())[0];
  await page.evaluate(()=>{window.simpleShortcutWrites=[];});
  for(const [index,segments] of [1,4,16].entries()) {
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[diagonal]});
    for(let step=1;step<=segments;step++)await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:diagonal.x+notch*.8*step/segments,y:diagonal.y-notch*step/segments}]});
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(reports).toEqual(Array.from({length:index+1},()=>angledReport));
  }
  const starts=await page.locator('.terminal-canvas:visible').evaluate(canvas=>{
    return ['.terminal-canvas','.xterm-screen','.xterm-viewport','.xterm-helper-textarea'].map(selector=>{
      const element=selector==='.terminal-canvas'?canvas:canvas.querySelector(selector)!;
      const r=element.getBoundingClientRect();
      const point=[[r.left+r.width/2,r.top+r.height/2],[r.left+1,r.top+1],[r.right-1,r.bottom-1]]
        .find(([x,y])=>{const hit=document.elementFromPoint(x,y);return hit===element||(selector==='.xterm-screen'&&!!hit&&element.contains(hit));});
      return {selector,point:point?{x:point[0],y:point[1]}:null};
    });
  });
  const landings:unknown[]=[];
  for(const {selector,point} of starts) {
    expect(point,`Real finger landing available on ${selector}`).not.toBeNull();
    await page.evaluate(()=>{window.simpleShortcutWrites=[];});
    const origin=point!;
    const destination=origin.y+(origin.y<box.y+box.height/2?notch:-notch);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
    await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:destination}]});
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(async()=>(await reports()).length,`Finger scrolling starts on ${selector}`).toBe(1);
    expect((await reports())[0]).toMatch(/^\x1b\[<6[45];\d+;\d+M$/);
    landings.push(await page.evaluate(selector=>({selector,target:window.simpleShortcutTouchTarget?.className,writes:window.simpleShortcutWrites}),selector));
  }
  await testInfo.attach('native-touch-starts',{body:JSON.stringify(landings),contentType:'application/json'});
  await testInfo.attach('native-touch-delivery',{body:JSON.stringify(deliveries),contentType:'application/json'});
  expect(batches[0]).toHaveLength(12);
  for(const batch of batches.slice(1))expect(batch).toEqual(batches[0]);
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
  await page.evaluate(()=>{window.simpleShortcutSteps=[];});
  await page.getByRole('button',{name:'Send',exact:true}).click();
  // The latched Alt modifies neither the literal draft nor its separate Enter.
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutSteps)).toEqual([['x','\r']]);
  await expect(page.getByLabel('Compose text',{exact:true})).toHaveCount(0);
  await expect(keys.getByRole('button',{name:'Alt',exact:true})).toHaveAttribute('aria-pressed','true');
  await clear();
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
    // Each toolbar row is its own horizontal scroller.
    const line=keys.locator('.terminal-keys-row').first(),bounds=await line.boundingBox(); if (!bounds) throw new Error('toolbar must be visible');
    const y=bounds.y+bounds.height/2, x=bounds.x+bounds.width-30;
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
    for (const offset of [30,80,160]) await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x-offset,y}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    await expect.poll(()=>line.evaluate(element=>element.scrollLeft)).toBeGreaterThan(0);
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

for(const truncated of [false,true])test(`skipped inline input review keeps Compose usable and copy safe with truncated=${truncated}`,async({page,context})=>{
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
  await expect(review.getByText('This keyboard edit could not be sent safely, so the terminal is unchanged. Typing continues normally.',{exact:true})).toBeVisible();
  const copy=review.getByRole('button',{name:'Copy context',exact:true});
  if(truncated){await expect(copy).toBeDisabled();await expect(review.getByRole('status')).toHaveText('Context exceeds the review limit. Copy is unavailable.');}
  else {await copy.click();await expect.poll(()=>page.evaluate(()=>window.simpleShortcutCopies)).toEqual(['èy']);}
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Compose text',exact:true})).toHaveValue('keep my draft');
  await expect(page.getByRole('button',{name:'Send',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['éx']);
  await page.getByRole('button',{name:'Close composer',exact:true}).click();
  await page.locator('.xterm-screen').click({position:{x:12,y:12}});
  const cdp=await context.newCDPSession(page);await cdp.send('Input.insertText',{text:'new'});await cdp.detach();
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['éx','new']);
  await review.getByRole('button',{name:'Dismiss',exact:true}).click();
  await expect(review).toHaveCount(0);
  if(truncated)expect(await page.evaluate(()=>window.simpleShortcutCopies)).toEqual([]);
});


async function dragSelectedTerminalBody(page:Page,origin:{x:number;y:number},notch:number) {
  const input=await page.context().newCDPSession(page);
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
  await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:origin.y+notch}]});
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  return input;
}

async function selectScrollSearchResult(page:Page,row:number) {
  await page.getByRole('button',{name:'Find',exact:true}).click();
  await page.locator('.terminal-search input').fill(`OWNED_SELECTION_ROW ${row}`);
  await page.locator('.terminal-search input').press('Enter');
  await expect.poll(()=>page.locator('.terminal-canvas .xterm-selection > div').count()).toBeGreaterThan(0);
  await page.locator('.terminal-search button').last().click();
}

test('normal scrollback finger scrolling preserves selected text',async({page},testInfo)=>{
  await openShortcutTerminal(page);
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
  await page.evaluate(()=>{
    window.simpleShortcutCopies=[];
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{window.simpleShortcutCopies.push(text);}}});
    window.simpleShortcutOutput(Array.from({length:100},(_,i)=>`OWNED_SELECTION_ROW ${i}`).join('\r\n'));
  });
  const viewport=page.locator('.terminal-canvas:visible .xterm-viewport'),screen=page.locator('.terminal-canvas:visible .xterm-screen');
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
  await selectScrollSearchResult(page,96);
  await page.getByRole('button',{name:'Copy',exact:true}).click();
  const selected=await page.evaluate(()=>window.simpleShortcutCopies.at(-1));expect(selected).toContain('OWNED_SELECTION_ROW 96');
  const box=(await screen.boundingBox())!,origin={x:box.x+80,y:box.y+Math.min(240,box.height/2)};
  const notch=await screen.evaluate(node=>Math.ceil(node.getBoundingClientRect().height/node.querySelectorAll('.xterm-rows > div').length)+1);
  const beforeWheel=await viewport.evaluate(node=>node.scrollTop);
  await page.mouse.move(origin.x,origin.y);await page.mouse.wheel(0,-notch);
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeLessThan(beforeWheel);
  await page.getByRole('button',{name:'Copy',exact:true}).click();expect(await page.evaluate(()=>window.simpleShortcutCopies.at(-1))).toBe(selected);
  const beforeTouch=await viewport.evaluate(node=>node.scrollTop);
  const input=await dragSelectedTerminalBody(page,origin,notch);
  await testInfo.attach('selected-scrollback',{body:JSON.stringify({beforeWheel,beforeTouch,afterTouch:await viewport.evaluate(node=>node.scrollTop),selected,writes:await page.evaluate(()=>window.simpleShortcutWrites)}),contentType:'application/json'});
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeLessThan(beforeTouch);
  await page.getByRole('button',{name:'Copy',exact:true}).click();expect(await page.evaluate(()=>window.simpleShortcutCopies.at(-1))).toBe(selected);
  const top=await screen.locator('.xterm-rows > div').first().innerText(),size=page.viewportSize()!;
  await page.setViewportSize({width:size.width,height:size.height-150});
  await expect(screen.locator('.xterm-rows > div').first()).toHaveText(top);
  await page.getByRole('button',{name:'Copy',exact:true}).click();expect(await page.evaluate(()=>window.simpleShortcutCopies.at(-1))).toBe(selected);
  expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  await input.detach();
});

test('selected multiplexer finger scrolling matches xterm mouse wheel selection behavior',async({page},testInfo)=>{
  await openShortcutTerminal(page);
  await expect(page.locator('.terminal-canvas:visible .xterm-screen')).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?1049h\x1b[?1000h\x1b[?1006h\x1b[H'+Array.from({length:20},(_,i)=>`OWNED_SELECTION_ROW ${i}`).join('\r\n')));
  await expect(page.locator('.terminal-canvas:visible .xterm')).toHaveClass(/enable-mouse-events/);
  await selectScrollSearchResult(page,6);
  const screen=page.locator('.terminal-canvas:visible .xterm-screen'),box=(await screen.boundingBox())!;
  const notch=await screen.evaluate(node=>Math.ceil(node.getBoundingClientRect().height/node.querySelectorAll('.xterm-rows > div').length)+1);
  const origin={x:testInfo.project.name==='phone'?box.x+80:box.x+box.width-20,y:box.y+Math.min(240,box.height/2)};
  await page.mouse.move(origin.x,origin.y);await page.mouse.wheel(0,-notch);
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites.length)).toBe(1);
  const wheel=await page.evaluate(()=>window.simpleShortcutWrites[0]);
  expect(wheel).toMatch(/^\x1b\[<64;\d+;\d+M$/);
  const wheelSelection=await page.locator('.xterm-selection').innerHTML();
  expect(wheelSelection).toBe('');
  await selectScrollSearchResult(page,6);
  expect(await page.locator('.xterm-selection').innerHTML()).not.toBe('');
  await testInfo.attach('selected-geometry',{body:JSON.stringify(await page.evaluate(({x,y})=>({x,y,hit:document.elementFromPoint(x,y)?.outerHTML.slice(0,300),screen:document.querySelector('.terminal-canvas .xterm-screen')?.getBoundingClientRect().toJSON(),viewport:{width:innerWidth,height:innerHeight}}),origin)),contentType:'application/json'});
  await page.evaluate(()=>{window.simpleShortcutWrites=[];Reflect.set(window,'selectedScrollEvents',[]);for(const type of ['touchstart','touchmove','touchend','touchcancel','pointercancel'])document.addEventListener(type,event=>{const rows=Reflect.get(window,'selectedScrollEvents');if(rows.length<16)rows.push({type,trusted:event.isTrusted,target:(event.target as Element)?.className});},true);});
  const input=await dragSelectedTerminalBody(page,origin,notch);
  await testInfo.attach('selected-finger-scroll',{body:JSON.stringify(await page.evaluate(()=>({events:Reflect.get(window,'selectedScrollEvents'),writes:window.simpleShortcutWrites}))),contentType:'application/json'});
  await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual([wheel]);
  expect(await page.locator('.xterm-selection').innerHTML()).toBe(wheelSelection);
  await input.detach();
});

for(const route of ['normal','mouse','alternate'] as const)for(const direction of [-1,1])test(`short repeated finger drags match actual wheel sensitivity route=${route} direction=${direction}`,async({page},testInfo)=>{
  const tracked=route!=='normal';
  await openShortcutTerminal(page);
  const screen=page.locator('.terminal-canvas:visible .xterm-screen'),viewport=page.locator('.terminal-canvas:visible .xterm-viewport');
  await expect(screen).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:300},(_,i)=>`short history ${i}\r\n`).join('')));
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(1000);
  if(route==='alternate'){await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?1049h'+Array.from({length:22},(_,i)=>`short alt ${i}\r\n`).join('')));await expect(page.locator('.terminal-canvas:visible .xterm-rows')).toContainText('short alt 21');}
  if(route==='mouse'){await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?1000h\x1b[?1006h'));await expect(page.locator('.terminal-canvas:visible .xterm')).toHaveClass(/enable-mouse-events/);}
  const bounds=(await screen.boundingBox())!,origin={x:bounds.x+bounds.width-20,y:bounds.y+80};
  const distance=await screen.evaluate(node=>node.getBoundingClientRect().height/node.querySelectorAll('.xterm-rows > div').length*.8);
  await viewport.evaluate((node,height)=>{node.scrollTop=Math.floor(node.scrollHeight/2/height)*height;},distance/.8);
  const beforeWheel=await viewport.evaluate(node=>node.scrollTop);
  await page.mouse.move(origin.x,origin.y);
  for(let n=0;n<5;n++)await page.mouse.wheel(0,direction*distance);
  if(tracked)await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites.length)).toBe(4);
  else await expect.poll(async()=>direction*(await viewport.evaluate(node=>node.scrollTop)-beforeWheel)).toBeGreaterThan(0);
  const wheel={travel:beforeWheel-await viewport.evaluate(node=>node.scrollTop),writes:await page.evaluate(()=>window.simpleShortcutWrites)};
  await viewport.evaluate((node,top)=>{node.scrollTop=top;},beforeWheel);
  await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBe(beforeWheel);
  await page.evaluate(()=>{window.simpleShortcutWrites=[];Reflect.set(window,'shortTouchEvents',[]);document.addEventListener('touchmove',event=>{const rows=Reflect.get(window,'shortTouchEvents');if(rows.length<10)rows.push({trusted:event.isTrusted,target:(event.target as Element).tagName});},true);});
  const beforeTouch=await viewport.evaluate(node=>node.scrollTop),input=await page.context().newCDPSession(page);
  for(let n=0;n<5;n++){
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
    await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x,y:origin.y-direction*distance}]});
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    if(n===0){
      await expect.poll(()=>page.evaluate(()=>Reflect.get(window,'shortTouchEvents').length)).toBe(1);
      if(tracked)expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
      else await expect.poll(async()=>direction*(await viewport.evaluate(node=>node.scrollTop)-beforeTouch)).toBeGreaterThan(0);
    }
  }
  await testInfo.attach('short-touch-vs-wheel',{body:JSON.stringify({route,direction,distance,wheel,touch:{travel:beforeTouch-await viewport.evaluate(node=>node.scrollTop),writes:await page.evaluate(()=>window.simpleShortcutWrites),events:await page.evaluate(()=>Reflect.get(window,'shortTouchEvents'))}}),contentType:'application/json'});
  if(tracked)await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(wheel.writes);
  else await expect.poll(async()=>beforeTouch-await viewport.evaluate(node=>node.scrollTop)).toBe(wheel.travel);
  const moves=await page.evaluate(()=>Reflect.get(window,'shortTouchEvents') as {trusted:boolean;target:string}[]);
  expect(moves).toHaveLength(5);expect(moves.every(event=>event.trusted&&event.target==='DIV')).toBe(true);
  await input.detach();
});


for(const android of [false,true])test.describe(`owned D-pad touchstart ${android?'Android UA':'ordinary UA'}`,()=>{
  if(android)test.use({userAgent:'Mozilla/5.0 (Linux; Android 14; Owned IME fixture) AppleWebKit/537.36 Chrome/133.0.0.0 Mobile Safari/537.36'});
  test('consumes the admitted start after pointer capture and preserves a real held pan',async({page},testInfo)=>{
    test.skip(testInfo.project.name!=='phone','Requires trusted touchscreen input.');
    await openExpandedDpad(page,true);
    const up=page.getByRole('button',{name:'D-pad up',exact:true});await up.scrollIntoViewIfNeeded();
    await page.evaluate(()=>{
      const events:unknown[]=[];Reflect.set(window,'ownedDpadStarts',events);
      for(const kind of ['pointerdown','touchstart','pointermove','pointerup','pointercancel'])document.addEventListener(kind,event=>{
        const pad=event.target instanceof Element&&Boolean(event.target.closest('.terminal-dpad'));
        if(kind==='touchstart')setTimeout(()=>events.push({kind,pad,trusted:event.isTrusted,prevented:event.defaultPrevented}),0);
        else events.push({kind,pad,trusted:event.isTrusted,prevented:event.defaultPrevented});
      },true);
    });
    await page.clock.install();await page.clock.pauseAt(new Date(Date.now()+1000));
    const box=(await up.boundingBox())!,origin={x:box.x+box.width/2,y:box.y+box.height/2};
    const input=await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[origin]});
    // Keep real Chromium gesture time separate from deterministic component repeats.
    await new Promise(resolve=>setTimeout(resolve,1000));
    await page.clock.runFor(1000);
    await input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:origin.x+40,y:origin.y}]});
    await page.clock.runFor(160);
    await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    const writes=await page.evaluate(()=>window.simpleShortcutWrites);
    expect(writes).toEqual([...Array(8).fill('\x1b[A'),...Array(2).fill('\x1b[C')]);
    await page.clock.runFor(160);
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual(writes);
    const events=await page.evaluate(()=>Reflect.get(window,'ownedDpadStarts')) as Array<{kind:string;pad:boolean;trusted:boolean;prevented:boolean}>;
    expect(events.map(event=>event.kind)).toEqual(['pointerdown','touchstart','pointermove','pointerup']);
    expect(events.every(event=>event.trusted&&event.pad)).toBe(true);
    expect(events[1].prevented).toBe(true);
    await testInfo.attach('owned-dpad-touchstart.json',{body:JSON.stringify({events,writes}),contentType:'application/json'});
    await input.detach();
    await up.focus();await page.keyboard.press('Enter');
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([...writes,'\x1b[A']);
  });
});


for(const route of ['history','mouse'] as const)test(`finger scrolling remains responsive during and after resize in ${route}`,async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Requires touchscreen input.');
  await openShortcutTerminal(page);
  const screen=page.locator('.terminal-canvas:visible .xterm-screen');
  await expect(screen).toBeVisible();
  await page.evaluate(route=>window.simpleShortcutOutput(route==='history'
    ? Array.from({length:200},(_,i)=>`history ${i}\r\n`).join('')
    : '\x1b[?1049h\x1b[?1000h\x1b[?1006h'),route);
  const viewport=page.locator('.terminal-canvas:visible .xterm-viewport');
  if(route==='history')await expect.poll(()=>viewport.evaluate(node=>node.scrollTop)).toBeGreaterThan(1000);
  else await expect(page.locator('.terminal-canvas:visible .xterm')).toHaveClass(/enable-mouse-events/);
  const box=(await screen.boundingBox())!, start={x:box.x+60,y:box.y+120};
  const input=await page.context().newCDPSession(page);
  const count=()=>route==='history'?viewport.evaluate(node=>-node.scrollTop):page.evaluate(()=>window.simpleShortcutWrites.length);
  const move=async(y:number)=>input.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:start.x,y}]});
  const before=await count();
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
  try {
    await move(start.y+40);
    await expect.poll(count).toBeGreaterThan(before);
    const top=route==='history'?await screen.locator('.xterm-rows > div').first().innerText():'';
    await page.setViewportSize({width:390,height:550});
    await expect.poll(async()=> (await screen.boundingBox())!.height).toBeLessThan(box.height);
    if(route==='history')await expect(screen.locator('.xterm-rows > div').first()).toHaveText(top);
    const resized=await count();
    await move(start.y+80);
    await expect.poll(count).toBeGreaterThan(resized);
  } finally {await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  const beforeFresh=await count();
  await input.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[start]});
  await move(start.y+40);
  await input.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect.poll(count).toBeGreaterThan(beforeFresh);
  const top=route==='history'?await screen.locator('.xterm-rows > div').first().innerText():'';
  await page.setViewportSize({width:390,height:844});
  await expect.poll(async()=> (await screen.boundingBox())!.height).toBeGreaterThan(box.height-40);
  if(route==='history')await expect(screen.locator('.xterm-rows > div').first()).toHaveText(top);
  if(route==='history')expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
  else expect(await page.evaluate(()=>window.simpleShortcutWrites.every(value=>/^\x1b\[<6[45];\d+;\d+M$/.test(value)))).toBe(true);
});


test('resizing at the bottom keeps following terminal output',async({page},testInfo)=>{
  test.skip(testInfo.project.name!=='phone','Keyboard-sized viewport.');
  await openShortcutTerminal(page);
  const screen=page.locator('.terminal-canvas:visible .xterm-screen');await expect(screen).toBeVisible();
  await page.evaluate(()=>window.simpleShortcutOutput(Array.from({length:200},(_,i)=>`tail ${i}\r\n`).join('')));
  await expect(screen).toContainText('tail 199');
  await page.setViewportSize({width:390,height:550});
  await page.evaluate(()=>window.simpleShortcutOutput('FOLLOWED_OUTPUT\r\n'));
  await expect(screen).toContainText('FOLLOWED_OUTPUT');
});

test.describe('terminal composer sheet',()=>{
  const steps=(page:Page)=>page.evaluate(()=>window.simpleShortcutSteps);
  const resizes=(page:Page)=>page.evaluate(()=>window.simpleShortcutResizes.length);
  async function openComposer(page:Page) {
    await openShortcutTerminal(page);
    await expect.poll(()=>page.evaluate(()=>typeof window.simpleShortcutOutput)).toBe('function');
    // The remote program asks for bracketed paste, as shells and agent CLIs do.
    await page.evaluate(()=>window.simpleShortcutOutput('$ \x1b[?2004h'));
    await expect.poll(()=>page.evaluate(()=>window.simpleShortcutResizes.length)).toBeGreaterThan(0);
    const before=await resizes(page);
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    const editor=page.getByRole('textbox',{name:'Compose text',exact:true});
    await expect(editor).toBeFocused();
    return {editor,before};
  }

  test('Send pastes a multi-line draft as one bracketed paste, then a separate Enter, without resizing the PTY',async({page},testInfo)=>{
    const {editor,before}=await openComposer(page);
    const sheet=page.locator('.terminal-composer-sheet');
    const stage=await page.locator('.terminal-stage:visible').boundingBox();
    await expect.poll(()=>sheet.boundingBox()).toEqual(stage);
    if(testInfo.project.name==='phone')await expect(page.locator('.terminal-keys')).toBeHidden();
    else await expect(page.getByText('Ctrl+Enter to send',{exact:true})).toBeVisible();
    await editor.pressSequentially('first line');await editor.press('Enter');await editor.pressSequentially('second line');
    await expect(page.getByText('22 characters · 2 lines',{exact:true})).toBeVisible();
    expect(await steps(page)).toEqual([]);
    await page.screenshot({path:testInfo.outputPath('composer-sheet.png'),animations:'disabled'});
    await page.getByRole('button',{name:'Send',exact:true}).click();
    await expect.poll(()=>steps(page)).toEqual([['\x1b[200~first line\rsecond line\x1b[201~','\r']]);
    await expect(sheet).toHaveCount(0);
    await expect(page.locator('.terminal-canvas .xterm-helper-textarea')).toBeFocused();
    await expect(page.locator('.terminal-keys')).toBeVisible();
    expect(await resizes(page)).toBe(before);
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    await expect(editor).toHaveValue('');
    await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
    await editor.fill('  \n  ');
    await expect(page.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
    await editor.press('Control+Enter');
    expect(await steps(page)).toHaveLength(1);
    await editor.fill('echo ok');await editor.press('Control+Enter');
    await expect.poll(()=>steps(page)).toEqual([['\x1b[200~first line\rsecond line\x1b[201~','\r'],['\x1b[200~echo ok\x1b[201~','\r']]);
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).not.toContain('\r');
  });

  test('Escape and Close return to the terminal and keep the draft without sending',async({page})=>{
    const {editor,before}=await openComposer(page);
    await editor.fill('keep\nthis draft');
    await editor.press('Escape');
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.terminal-canvas .xterm-helper-textarea')).toBeFocused();
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    await expect(editor).toHaveValue('keep\nthis draft');await expect(editor).toBeFocused();
    await page.getByRole('button',{name:'Close composer',exact:true}).click();
    await expect(editor).toHaveCount(0);
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    await page.getByRole('button',{name:'Clear draft',exact:true}).click();
    await expect(editor).toHaveValue('');await expect(editor).toBeFocused();
    expect(await steps(page)).toEqual([]);
    expect(await page.evaluate(()=>window.simpleShortcutWrites)).toEqual([]);
    expect(await resizes(page)).toBe(before);
  });

  test('turning off Send Enter restores paste without Enter and labels the action Paste draft',async({page})=>{
    await fixture(page);
    await openPreferenceCategory(page,'Input');
    const option=page.getByRole('checkbox',{name:'Send Enter after pasting the draft',exact:true});
    await expect(option).toBeChecked();
    await option.uncheck();
    expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).composerSendEnter)).toBe(false);
    await page.getByRole('button',{name:'Close Preferences',exact:true}).click();
    if ((page.viewportSize()?.width??1280)<=600) await page.getByRole('button',{name:'Open hosts',exact:true}).click();
    await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>typeof window.simpleShortcutOutput)).toBe('function');
    await page.evaluate(()=>window.simpleShortcutOutput('\x1b[?2004h'));
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    await expect(page.getByRole('button',{name:'Send',exact:true})).toHaveCount(0);
    const editor=page.getByRole('textbox',{name:'Compose text',exact:true});
    await editor.fill('git status');
    await page.getByRole('button',{name:'Paste draft',exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>window.simpleShortcutWrites)).toEqual(['\x1b[200~git status\x1b[201~']);
    expect(await steps(page)).toEqual([]);
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.terminal-canvas .xterm-helper-textarea')).toBeFocused();
  });

  test('the sheet keeps its editor and actions above a soft keyboard that only shrinks the visual viewport',async({page},testInfo)=>{
    test.skip(testInfo.project.name!=='phone','Soft keyboard');
    await openShortcutTerminal(page);
    // WebKit-style keyboards keep the layout viewport and shrink only the visual viewport.
    await page.evaluate(()=>{
      const target=new EventTarget(), keyboard={height:window.innerHeight};
      Object.defineProperties(target,{offsetTop:{value:0},offsetLeft:{value:0},scale:{value:1},width:{value:window.innerWidth},height:{get:()=>keyboard.height}});
      Object.defineProperty(window,'visualViewport',{configurable:true,value:target});
      Reflect.set(window,'showKeyboard',(height:number)=>{keyboard.height=window.innerHeight-height;target.dispatchEvent(new Event('resize'));});
    });
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    const editor=page.getByRole('textbox',{name:'Compose text',exact:true});
    await editor.fill('above the keyboard');
    await page.evaluate(()=>(Reflect.get(window,'showKeyboard') as (height:number)=>void)(336));
    const visible=await page.evaluate(()=>window.innerHeight-336);
    for(const control of [editor,page.getByRole('button',{name:'Send',exact:true}),page.getByRole('button',{name:'Close composer',exact:true})])
      await expect.poll(async()=>{const box=(await control.boundingBox())!;return box.y+box.height<=visible;}).toBe(true);
    expect((await editor.boundingBox())!.height).toBeGreaterThanOrEqual(96);
    await page.screenshot({path:testInfo.outputPath('composer-keyboard.png'),animations:'disabled'});
    await page.evaluate(()=>(Reflect.get(window,'showKeyboard') as (height:number)=>void)(0));
    await expect.poll(async()=>(await page.getByRole('button',{name:'Send',exact:true}).boundingBox())!.y).toBeGreaterThan(visible);
  });
});

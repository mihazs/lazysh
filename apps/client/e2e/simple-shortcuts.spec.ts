import { openGestureSettings, saveAdvancedGesture, expectGestureBinding } from './fixtures/gestureSettings';
import {expect,test,type Page} from '@playwright/test';

declare global {interface Window {simpleShortcutWrites:string[];simpleShortcutSteps:string[][]}}
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
      if (command==='local_connect') return {sessionId:'local:shortcut-fixture'};
      if (command==='local_write') {const steps=args.steps as string[]|undefined; if(steps)window.simpleShortcutSteps.push(steps);window.simpleShortcutWrites.push(steps?steps.join(''):args.data as string);return;}
      if (['local_resize','local_ack','local_disconnect'].includes(command))return;
      if (command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected shortcut fixture command: ${command}`);
    }}});
  });
  await page.goto('/');
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await page.getByText('Keyboard chords',{exact:true}).click();
}

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

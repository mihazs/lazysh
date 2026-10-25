import {expect,test,type Page} from '@playwright/test';

declare global {interface Window {simpleShortcutWrites:string[]}}
async function fixture(page:Page) {
  await page.addInitScript(()=>{
    window.simpleShortcutWrites=[];
    Object.defineProperty(window,'isTauri',{value:true});
    Object.defineProperty(window,'__TAURI_INTERNALS__',{value:{transformCallback:()=>1,unregisterCallback:()=>{},invoke:async(command:string,args:Record<string,unknown>={})=>{
      if (command==='app_lock_status') return {initialized:true,supported:false,reason:'Synthetic shortcut access fixture.',enabled:false,locked:false,generation:'0'};
      if (command==='app_lock_ready' || command==='adopt_session') return;
      if (command==='list_hosts') return [];
      if (command==='local_capability') return {available:true,reason:'Synthetic shortcut fixture; no shell runs.'};
      if (command==='local_connect') return {sessionId:'local:shortcut-fixture'};
      if (command==='local_write') {window.simpleShortcutWrites.push(args.data as string);return;}
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

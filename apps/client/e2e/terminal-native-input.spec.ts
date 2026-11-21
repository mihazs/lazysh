import {expect,test,type Page} from '@playwright/test';
import {readFileSync} from 'node:fs';
import {canvas,mountNativeSurface} from './fixtures/nativeSurfacePage';
import type {PlatformKeyEntry} from '../src/xterm/platformKeyMatrix';

/**
 * The typed-input editor of a native session (#1334, slice 1334a) over the headless stand-in core: what the browser fires on it
 * and what the core is sent. The Rust core's bytes for the keys are held to the same fixtures by `tests/platform_keys.rs`.
 */
const editor='[data-terminal-editor]',preedit='[data-terminal-preedit]';
test.afterEach(async({page})=>{await page.evaluate(()=>window.nativeSurface?.dispose());});

async function mount(page:Page) {
  await mountNativeSurface(page,'native');
  await page.evaluate(()=>window.nativeSurface.session.adapter.focus());
  await expect(page.locator(editor)).toBeFocused();
}
const keys=(page:Page)=>page.evaluate(()=>window.nativeSurface.core!.keys);
const texts=(page:Page)=>page.evaluate(()=>window.nativeSurface.core!.inputs);
const top=(page:Page)=>page.evaluate(()=>window.nativeSurface.session.adapter.viewport().top);
/** Press and release as the core sees them: `a↓`, `a↑`. */
const arrows=(page:Page)=>keys(page).then(sent=>sent.map(({key,release})=>`${key}${release?'↑':'↓'}`));

const platforms={mac:'MacIntel',windows:'Win32',other:'Linux x86_64'};
const matrix=(platform:string)=>JSON.parse(readFileSync(new URL(`./fixtures/platform-keys/${platform}.json`,import.meta.url),'utf8')) as PlatformKeyEntry[];

for(const [platform,navigatorPlatform] of Object.entries(platforms))test(`keys reach the core as the platform matrix records them on ${platform}`,async({page})=>{
  await mount(page);
  await page.evaluate(value=>Object.defineProperty(navigator,'platform',{value,configurable:true}),navigatorPlatform);
  const entries=matrix(platform);
  expect(entries.length).toBeGreaterThan(5);
  for(const entry of entries){
    await page.evaluate(meta=>window.nativeSurface.setOptionAsMeta(meta),entry.optionAsMeta);
    const sent=await page.evaluate(async({raw,fired,editor})=>{
      const fire=(type:string)=>document.querySelector(editor)!.dispatchEvent(new KeyboardEvent(type,{
        key:raw.key,code:raw.code,keyCode:fired.keyCode,shiftKey:raw.mods.shift,ctrlKey:raw.mods.ctrl,altKey:raw.mods.alt,metaKey:raw.mods.meta,
        modifierAltGraph:fired.altGraph,bubbles:true,cancelable:true} as KeyboardEventInit));
      const core=window.nativeSurface.core!,before=core.keys.length;
      fire('keydown');fire('keyup');
      await new Promise(resolve=>setTimeout(resolve));
      return core.keys.slice(before);
    },{raw:entry.raw,fired:entry.fired,editor});
    // A key that xterm.js and the core both send nothing for (the platform key with a letter) stays with the browser: the app's copy, paste and search.
    const expected=entry.xterm===''&&entry.core===''?[]:[entry.input,{...entry.input,release:true}];
    expect(sent,entry.name).toEqual(expected);
  }
  expect(await texts(page)).toEqual([]);
});

test('typed characters and editing keys arrive once, as keys, with no text beside them',async({page})=>{
  await mount(page);
  await page.keyboard.type('ls');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Backspace');
  expect(await arrows(page)).toEqual(['l↓','l↑','s↓','s↑','Enter↓','Enter↑','Backspace↓','Backspace↑']);
  expect(await texts(page)).toEqual([]);
  await expect(page.locator(editor)).toHaveValue('');
});

test('Shift+PageUp and Shift+PageDown scroll the history and are not sent to the program',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.nativeSurface.output(Array.from({length:80},(_,i)=>`LINE_${i}\r\n`).join('')));
  await expect.poll(()=>page.evaluate(()=>window.nativeSurface.session.adapter.viewport().following)).toBe(true);
  // A page is the rows of the screen less one, as xterm.js scrolls it.
  const live=await top(page),page1=live-(await page.evaluate(()=>window.nativeSurface.session.adapter.size().rows-1));
  await page.keyboard.press('Shift+PageUp');
  await expect.poll(()=>top(page)).toBe(page1);
  await page.keyboard.press('Control+Shift+PageUp');
  await expect.poll(()=>top(page)).toBe(page1-(live-page1));
  await page.keyboard.press('Shift+PageDown');
  await expect.poll(()=>top(page)).toBe(page1);
  expect(await keys(page)).toEqual([]);
  // The same keys without Shift are the program's.
  await page.keyboard.press('PageUp');
  expect(await arrows(page)).toEqual(['PageUp↓','PageUp↑']);
});

test('the key interceptor sees a key first and can keep it from the core',async({page})=>{
  await mount(page);
  await page.evaluate(()=>{
    const seen:string[]=[];
    Object.assign(window,{intercepted:seen,release:window.nativeSurface.session.adapter.interceptKeys(event=>{seen.push(`${event.type}:${event.key}`);return event.key!=='x';})});
  });
  await page.keyboard.type('xy');
  expect(await arrows(page)).toEqual(['y↓','y↑']);
  expect(await page.evaluate(()=>(window as unknown as {intercepted:string[]}).intercepted)).toEqual(['keydown:x','keyup:x','keydown:y','keyup:y']);
});

test.describe('paste',()=>{
  const paste=(page:Page,text:string)=>page.evaluate(({text,editor})=>{
    const data=new DataTransfer();data.setData('text/plain',text);
    const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});
    document.querySelector(editor)!.dispatchEvent(event);
    return event.defaultPrevented;
  },{text,editor});

  test('sends the text once, with line breaks as Enter, and brackets it when the program asked',async({page})=>{
    await mount(page);
    expect(await paste(page,'echo 1\necho 2')).toBe(true);
    await page.evaluate(()=>window.nativeSurface.output('\x1b[?2004h'));
    await expect.poll(()=>page.evaluate(()=>window.nativeSurface.session.adapter.modes().bracketedPaste)).toBe(true);
    await paste(page,'x\x1b[201~y');
    await expect.poll(()=>texts(page)).toEqual([
      {data:'echo 1\recho 2',origin:'paste'},
      // The end marker inside the paste is stripped: pasted text cannot end the paste.
      {data:'\x1b[200~xy\x1b[201~',origin:'paste'},
    ]);
    expect(await arrows(page)).toEqual([]);
    await expect(page.locator(editor)).toHaveValue('');
  });

  test('Shift+Insert pastes through the browser and sends no key',async({page})=>{
    await mount(page);
    await page.keyboard.press('Shift+Insert');
    expect(await keys(page)).toEqual([]);
  });
});

test.describe('IME composition',()=>{
  /** What a browser fires for one composition of `text`: Chromium confirms before `compositionend`, WebKit after it. */
  const compose=(page:Page,text:string,order:'chromium'|'webkit')=>page.evaluate(async({text,order,editor})=>{
    const area=document.querySelector<HTMLTextAreaElement>(editor)!,fire=(event:Event)=>area.dispatchEvent(event);
    const input=(inputType:string,isComposing:boolean)=>fire(new InputEvent('input',{inputType,data:text,isComposing,bubbles:true}));
    fire(new KeyboardEvent('keydown',{key:'Process',keyCode:229,isComposing:false,bubbles:true,cancelable:true}));
    fire(new CompositionEvent('compositionstart',{bubbles:true}));
    area.value=text;
    input('insertCompositionText',true);
    fire(new CompositionEvent('compositionupdate',{data:text,bubbles:true}));
    // The key that confirms (Enter or Space) is part of the composition too.
    fire(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true,cancelable:true}));
    if(order==='chromium'){input('insertCompositionText',true);fire(new CompositionEvent('compositionend',{data:text,bubbles:true}));}
    else{fire(new CompositionEvent('compositionend',{data:text,bubbles:true}));input('insertFromComposition',false);}
    fire(new KeyboardEvent('keyup',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,30));
  },{text,order,editor});

  for(const order of ['chromium','webkit'] as const)for(const text of ['你好','👩🏽‍💻'])test(`commits ${text} once when ${order} orders the events`,async({page})=>{
    await mount(page);
    await compose(page,text,order);
    expect(await texts(page)).toEqual([{data:text,origin:'ime'}]);
    expect(await keys(page)).toEqual([]);
    await expect(page.locator(editor)).toHaveValue('');
    await expect(page.locator(preedit)).toBeHidden();
  });

  test('two compositions in a row commit twice, each once',async({page})=>{
    await mount(page);
    await compose(page,'你好','webkit');
    await compose(page,'你好','chromium');
    expect((await texts(page)).map(({data})=>data)).toEqual(['你好','你好']);
  });

  test('a composition that loses focus is dropped, not committed',async({page})=>{
    await mount(page);
    await page.evaluate(()=>{
      const area=document.querySelector<HTMLTextAreaElement>('[data-terminal-editor]')!;
      area.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
      area.value='你好';
      area.dispatchEvent(new CompositionEvent('compositionupdate',{data:'你好',bubbles:true}));
      area.blur();
    });
    await page.waitForTimeout(50);
    expect(await texts(page)).toEqual([]);
    await expect(page.locator(preedit)).toBeHidden();
  });

  test('shows the preedit at the cursor while composing, through a real Chromium input method',async({page,context})=>{
    await mount(page);
    await page.evaluate(()=>window.nativeSurface.output('abc'));
    await expect.poll(()=>page.evaluate(()=>window.nativeSurface.session.adapter.cursor().x)).toBe(3);
    const cdp=await context.newCDPSession(page),box=await page.locator(canvas).boundingBox();
    await cdp.send('Input.imeSetComposition',{text:'你',selectionStart:1,selectionEnd:1});
    await cdp.send('Input.imeSetComposition',{text:'你好',selectionStart:2,selectionEnd:2});
    await expect(page.locator(preedit)).toHaveText('你好');
    const shown=(await page.locator(preedit).boundingBox())!;
    expect(shown.x-box!.x).toBeCloseTo(3*box!.width/40,0);
    expect(shown.y).toBeCloseTo(box!.y,0);
    // The preedit is the input method's: nothing has gone to the program yet.
    expect(await texts(page)).toEqual([]);
    await cdp.send('Input.insertText',{text:'你好'});
    await expect.poll(()=>texts(page)).toEqual([{data:'你好',origin:'ime'}]);
    await expect(page.locator(preedit)).toBeHidden();
    await cdp.detach();
  });
});

test('a mouse click on the terminal gives the editor focus',async({page})=>{
  await mount(page);
  await page.evaluate(()=>window.nativeSurface.session.adapter.blur());
  await expect(page.locator(editor)).not.toBeFocused();
  await page.locator(canvas).click();
  await expect(page.locator(editor)).toBeFocused();
});

test('a key still held when focus leaves is released, so no program waits for it',async({page})=>{
  await mount(page);
  await page.keyboard.down('a');
  await page.evaluate(()=>window.nativeSurface.session.adapter.blur());
  await expect.poll(()=>arrows(page)).toEqual(['a↓','a↑']);
});

test.describe('on Android',()=>{
  test.use({userAgent:'Mozilla/5.0 (Linux; Android 14; Fixture) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'});
  test('has no DOM editor: its keyboard is the native input connection',async({page})=>{
    await mountNativeSurface(page,'native');
    await expect(page.locator(editor)).toHaveCount(0);
    expect(await page.evaluate(()=>window.nativeSurface.session.adapter.inputElement())).toBeUndefined();
  });
});

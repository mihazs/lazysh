import {readFileSync} from 'node:fs';
import {expect} from '@playwright/test';
import {requestedBackend} from '../src/e2eTerminalBackend';
import {mountNativeSurface} from './fixtures/nativeSurfacePage';
import {test} from './fixtures/terminalBackend';
import {onAdapter,screenText,terminalCell} from './fixtures/terminalState';
import {longPress} from './fixtures/terminalHistory';

test.use({syntheticBackend:true});

test('the selected browser backend parses and exposes terminal output',async({page})=>{
  const engine=requestedBackend()??'native';
  await mountNativeSurface(page,engine);
  try {
    await page.evaluate(()=>window.nativeSurface.output('browser adapter marker'));
    await expect.poll(()=>screenText(page)).toContain('browser adapter marker');
    expect(await onAdapter(page,adapter=>adapter.backend)).toBe(engine);
  } finally {
    await page.evaluate(()=>window.nativeSurface.dispose());
  }
});

for(const text of ['你好','👩🏽‍💻'])test(`native composition and Enter accept two identical ${text} commands independently`,async({page,context})=>{
  test.skip(requestedBackend()==='xterm','This case exercises the native typed-input editor.');
  await mountNativeSurface(page,'native');
  const keyboard=await context.newCDPSession(page);
  try {
    await onAdapter(page,adapter=>adapter.focus());
    for(let count=1;count<=2;count++){
      await keyboard.send('Input.imeSetComposition',{text,selectionStart:text.length,selectionEnd:text.length});
      await keyboard.send('Input.insertText',{text});
      await page.keyboard.press('Enter');
      await expect.poll(()=>page.evaluate(()=>{
        const {core,session}=window.nativeSurface;
        return {text:core!.inputs.map(input=>input.data),keys:core!.keys.filter(input=>!input.release).map(input=>input.key),editor:session.adapter.inputElement()?.value};
      })).toEqual({text:Array(count).fill(text),keys:Array(count).fill('Enter'),editor:''});
    }
  } finally {
    await keyboard.detach();
    await page.evaluate(()=>window.nativeSurface.dispose());
  }
});

for(const action of ['Allow this copy','Deny'])test(`a terminal clipboard request honors "${action}" on the selected browser backend`,async({page})=>{
  const engine=requestedBackend()??'native';
  await mountNativeSurface(page,engine);
  try {
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(page.url()).origin});
    const clipboard=()=>page.evaluate(()=>navigator.clipboard.readText());
    await page.evaluate(()=>navigator.clipboard.writeText('before consent'));
    await page.evaluate(async()=>{
      const {output}=window.nativeSurface;
      await output('\x1b]52;c;');
      await output(btoa('terminal clipboard marker')+'\x07visible after OSC');
    });
    const consent=page.getByRole('region',{name:'Remote clipboard request',exact:true});
    await expect(consent).toContainText('terminal clipboard marker');
    await expect.poll(()=>screenText(page)).toContain('visible after OSC');
    expect(await clipboard()).toBe('before consent');
    await consent.getByRole('button',{name:action,exact:true}).click();
    await expect(consent).toHaveCount(0);
    await expect.poll(clipboard).toBe(action==='Deny'?'before consent':'terminal clipboard marker');
  } finally {
    await page.evaluate(()=>window.nativeSurface.dispose());
  }
});

test('a long press selects and copies text on the selected browser backend',async({page,isMobile})=>{
  test.skip(!isMobile,'Long press requires a touch viewport.');
  const engine=requestedBackend()??'native';
  await mountNativeSurface(page,engine);
  try {
    await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:new URL(page.url()).origin});
    await page.evaluate(()=>window.nativeSurface.output('fixture_word next'));
    await expect.poll(()=>screenText(page)).toContain('fixture_word next');
    await longPress(page,await terminalCell(page,0,4));
    const copy=page.getByRole('toolbar',{name:'Selection actions'}).getByRole('button',{name:'Copy',exact:true});
    await expect(copy).toBeVisible();
    await copy.click();
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe('fixture_word');
  } finally {
    await page.evaluate(()=>window.nativeSurface.dispose());
  }
});

test('captured Mosh frames control the selected browser backend grid',async({page})=>{
  const engine=requestedBackend()??'native';
  await mountNativeSurface(page,engine);
  try {
    const {frames}=JSON.parse(readFileSync(new URL('./fixtures/mosh-resize-frames.json',import.meta.url),'utf8')) as {
      frames:{cols:number;rows:number;bytesHex:string;expectedCursor:[number,number]}[];
    };
    await onAdapter(page,adapter=>{adapter.enableCanonicalResize!();});
    for(const frame of frames){
      const bytes=Array.from(Buffer.from(frame.bytesHex,'hex'));
      await onAdapter(page,(adapter,data)=>adapter.write!(Uint8Array.from(data)),bytes);
      const actual=await onAdapter(page,adapter=>({size:adapter.size(),cursor:adapter.cursor()}));
      expect(actual).toMatchObject({size:{columns:frame.cols,rows:frame.rows},cursor:{x:frame.expectedCursor[0],y:frame.expectedCursor[1]}});
      await onAdapter(page,adapter=>adapter.requestSize({columns:99,rows:17}));
      expect(await onAdapter(page,adapter=>adapter.size())).toEqual(actual.size);
    }
  } finally {
    await page.evaluate(()=>window.nativeSurface.dispose());
  }
});

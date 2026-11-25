import {expect} from '@playwright/test';
import {requestedBackend} from '../src/e2eTerminalBackend';
import {mountNativeSurface} from './fixtures/nativeSurfacePage';
import {test} from './fixtures/terminalBackend';
import {onAdapter,screenText} from './fixtures/terminalState';

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

test('native composition and Enter accept two identical commands independently',async({page,context})=>{
  test.skip(requestedBackend()==='xterm','This case exercises the native typed-input editor.');
  await mountNativeSurface(page,'native');
  const keyboard=await context.newCDPSession(page);
  try {
    await onAdapter(page,adapter=>adapter.focus());
    const text='你好';
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

import {expect,test,type Page} from '@playwright/test';
import {installLocalTerminal} from './fixtures/localTerminal';
import {setKeyboard} from './fixtures/softKeyboard';

declare global {interface Window {nativeKeyboard:{visible:boolean;calls:string[]}}}

/** A local terminal; `android` adds the native IME controller, which reports the real keyboard state. */
async function openTerminal(page:Page,android=false,preferences?:Record<string,unknown>) {
  await installLocalTerminal(page);
  if(preferences)await page.addInitScript(seed=>localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,...seed})),preferences);
  if(android)await page.addInitScript(()=>{
    window.nativeKeyboard={visible:false,calls:[]};
    window.simpleShortcutKeyboard=action=>{
      window.nativeKeyboard.calls.push(action);
      if(action==='show')window.nativeKeyboard.visible=true;
      if(action==='hide')window.nativeKeyboard.visible=false;
      return window.nativeKeyboard.visible;
    };
  });
  await page.goto('/');
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>typeof window.simpleShortcutOutput)).toBe('function');
}
/** The header button stands in for the toolbar's keyboard key, so it appears once the toolbar is out of the way. */
const hideToolbar=(page:Page)=>page.getByRole('button',{name:'Hide terminal keys',exact:true}).tap();
const input=(page:Page)=>page.locator('.terminal-canvas:visible .xterm-helper-textarea');
/** Terminal input bytes, without xterm's focus reports. */
const typed=(page:Page)=>page.evaluate(()=>window.simpleShortcutWrites.filter(data=>data!=='\x1b[I'&&data!=='\x1b[O'));
const native=(page:Page)=>page.evaluate(()=>window.nativeKeyboard.calls.filter(call=>call!=='status'));

test('desktop windows have no soft keyboard to show or hide',async({page},testInfo)=>{
  test.skip(testInfo.project.name==='phone','Touch devices show the button.');
  await openTerminal(page,true);
  await expect(page.getByRole('button',{name:/^(Show|Hide) keyboard$/})).toHaveCount(0);
  // The toolbar key keeps moving focus, and never asks the native shell for a keyboard.
  const key=page.getByRole('button',{name:'Toggle keyboard',exact:true});
  await key.click();await expect(input(page)).not.toBeFocused();
  await key.click();await expect(input(page)).toBeFocused();
  expect(await native(page)).toEqual([]);
  expect(await typed(page)).toEqual([]);
});

test.describe('touch device',()=>{
  test.beforeEach(({},testInfo)=>{test.skip(testInfo.project.name!=='phone','Only a touch device has an on-screen keyboard.');});

  test('the header button follows the real keyboard and sends no input',async({page},testInfo)=>{
    await openTerminal(page);
    // With the toolbar in view its keyboard key is the toggle; the header only adds a second one when that key is out of reach.
    await expect(page.getByRole('button',{name:'Show keyboard',exact:true})).toHaveCount(0);
    await hideToolbar(page);
    const show=page.getByRole('button',{name:'Show keyboard',exact:true});
    await expect(show).toBeVisible();
    await expect(show).toHaveAttribute('data-keyboard','closed');
    await show.tap();
    await expect(input(page)).toBeFocused();
    // The keyboard comes up and the window shrinks around it: the button now offers to hide it.
    await setKeyboard(page,true);
    const hide=page.getByRole('button',{name:'Hide keyboard',exact:true});
    await expect(hide).toHaveAttribute('data-keyboard','open');
    await page.screenshot({path:testInfo.outputPath('keyboard-open.png'),animations:'disabled'});
    await hide.tap();
    await expect(input(page)).not.toBeFocused();
    await setKeyboard(page,false);
    await expect(page.getByRole('button',{name:'Show keyboard',exact:true})).toBeVisible();
    expect(await typed(page)).toEqual([]);
  });

  test('the header button is there for a toolbar without the keyboard key',async({page})=>{
    await openTerminal(page,false,{toolbar:['esc','tab']});
    await expect(page.getByRole('button',{name:'Toggle keyboard',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Show keyboard',exact:true}).tap();
    await expect(input(page)).toBeFocused();
  });

  test('the toolbar key is the same toggle and reports its state',async({page})=>{
    await openTerminal(page);
    const key=page.getByRole('button',{name:'Toggle keyboard',exact:true});
    await expect(key).toHaveAttribute('aria-pressed','false');
    await key.tap();
    await expect(input(page)).toBeFocused();
    await setKeyboard(page,true);
    await expect(key).toHaveAttribute('aria-pressed','true');
    await key.tap();
    await expect(input(page)).not.toBeFocused();
    await setKeyboard(page,false);
    await expect(key).toHaveAttribute('aria-pressed','false');
    expect(await typed(page)).toEqual([]);
  });

  test('Android shows and hides the keyboard natively, and a keyboard closed by the back gesture is shown again with one tap',async({page})=>{
    await openTerminal(page,true);
    await hideToolbar(page);
    const show=page.getByRole('button',{name:'Show keyboard',exact:true});
    await show.tap();
    await expect(input(page)).toBeFocused();
    expect(await native(page)).toEqual(['show']);
    await setKeyboard(page,true);
    await expect(page.getByRole('button',{name:'Hide keyboard',exact:true})).toBeVisible();
    // The system back gesture closes the keyboard; the terminal input keeps its focus.
    await page.evaluate(()=>{window.nativeKeyboard.visible=false;});
    await setKeyboard(page,false);
    await expect(show).toBeVisible();
    await expect(input(page)).toBeFocused();
    // One tap brings it back: a toggle that trusted focus alone would blur the input and show nothing.
    await show.tap();
    await expect(input(page)).toBeFocused();
    expect(await native(page)).toEqual(['show','show']);
    await setKeyboard(page,true);
    await page.getByRole('button',{name:'Hide keyboard',exact:true}).tap();
    await expect(input(page)).not.toBeFocused();
    expect(await native(page)).toEqual(['show','show','hide']);
    expect(await typed(page)).toEqual([]);
  });

  test('the same button reaches the open composer, whose draft stays',async({page})=>{
    await openTerminal(page,true);
    await page.getByRole('button',{name:'Compose',exact:true}).tap();
    const editor=page.getByRole('textbox',{name:'Compose text',exact:true});
    await editor.fill('keep my draft');
    // Typing in the composer brought the keyboard up, which Android reports.
    await page.evaluate(()=>{window.nativeKeyboard.visible=true;});
    await setKeyboard(page,true);
    await page.getByRole('button',{name:'Hide keyboard',exact:true}).tap();
    await expect(editor).not.toBeFocused();
    await expect(editor).toHaveValue('keep my draft');
    await setKeyboard(page,false);
    await page.getByRole('button',{name:'Show keyboard',exact:true}).tap();
    await expect(editor).toBeFocused();
    expect(await native(page)).toEqual(['hide','show']);
    expect(await typed(page)).toEqual([]);
  });
});

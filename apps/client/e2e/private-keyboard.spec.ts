import {expect,test,type Page} from '@playwright/test';
import {installLocalTerminal,openLocalTerminal as openTerminal} from './fixtures/localTerminal';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';

const android='Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36';
const label='Private keyboard in the terminal';
const storedChoice=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')??'{}').privateKeyboard as boolean|undefined);
/** What the terminal has told the Android shell so far, oldest first. */
const reported=(page:Page)=>page.evaluate(()=>[...window.simpleShortcutPrivateKeyboard]);
const editor=(page:Page)=>page.locator('.terminal-canvas:visible .xterm-helper-textarea');

async function openKeyboardSettings(page:Page) {
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Input');
}

test.describe('on Android',()=>{
  test.use({userAgent:android});

  test('the Private keyboard setting is offered with its trade-off, persists, and tells the shell about the focused terminal only',async({page},testInfo)=>{
    await installLocalTerminal(page);
    await page.goto('/');
    await openTerminal(page,testInfo);
    await openKeyboardSettings(page);
    const toggle=page.getByRole('checkbox',{name:label,exact:true});
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText(/Predictive text, autocorrect and swipe typing stop working in the terminal while this is on/)).toBeVisible();
    expect(await storedChoice(page)).toBeUndefined();
    await toggle.check();
    expect(await storedChoice(page)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('private-keyboard-setting.png')});
    await closePreferences(page);

    // The terminal's own editor keeps the hints Chromium turns into suggestions-off and autocorrect-off; the rest is native.
    await editor(page).focus();
    await expect.poll(()=>reported(page).then(calls=>calls.at(-1))).toBe(true);
    expect(await editor(page).evaluate(area=>({autocomplete:area.getAttribute('autocomplete'),autocorrect:area.getAttribute('autocorrect'),spellcheck:(area as HTMLTextAreaElement).spellcheck,inputmode:area.getAttribute('inputmode')})))
      .toEqual({autocomplete:'off',autocorrect:'off',spellcheck:false,inputmode:null});

    // Another editor, here the composer, is reported as inactive and keeps the keyboard's normal behaviour.
    await page.getByRole('button',{name:'Compose',exact:true}).click();
    const composer=page.locator('.terminal-compose textarea');
    await composer.focus();
    await expect.poll(()=>reported(page).then(calls=>calls.at(-1))).toBe(false);
    await page.getByRole('button',{name:'Close composer',exact:true}).click();
    await editor(page).focus();
    await expect.poll(()=>reported(page).then(calls=>calls.at(-1))).toBe(true);
    await editor(page).blur();
    await expect.poll(()=>reported(page).then(calls=>calls.at(-1))).toBe(false);

    // The choice stays on this device across a reload, and the terminal reports it again.
    await page.reload();
    await openTerminal(page,testInfo);
    expect(await storedChoice(page)).toBe(true);
    await editor(page).focus();
    await expect.poll(()=>reported(page).then(calls=>calls.at(-1))).toBe(true);
  });

  test('switching the setting off stops the report without a reconnect, and Reset preferences clears it',async({page},testInfo)=>{
    await installLocalTerminal(page);
    await page.addInitScript(()=>{if(!sessionStorage.getItem('seeded')){sessionStorage.setItem('seeded','1');localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,privateKeyboard:true}));}});
    await page.goto('/');
    await openTerminal(page,testInfo);
    await editor(page).focus();
    await expect.poll(()=>reported(page).then(calls=>calls.at(-1))).toBe(true);
    const connections=await page.evaluate(()=>window.simpleShortcutResizes.length);
    // The editor stays focused while the setting changes under it: the shell is told at once.
    await page.evaluate(async()=>{const {getPreferences,savePreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),privateKeyboard:undefined});});
    await expect.poll(()=>reported(page).then(calls=>calls.at(-1))).toBe(false);
    expect(await storedChoice(page)).toBeUndefined();
    expect(await page.evaluate(()=>window.simpleShortcutResizes.length)).toBe(connections);

    await openKeyboardSettings(page);
    await page.getByRole('checkbox',{name:label,exact:true}).check();
    await page.getByRole('button',{name:await page.evaluate(async()=>{const {t}=await import('/src/i18n/core.ts');return t('navigationBack');}),exact:true}).click();
    await openPreferenceCategory(page,'Reset');
    await page.getByRole('button',{name:'Reset preferences',exact:true}).click();
    await expect.poll(()=>storedChoice(page)).toBeUndefined();
  });
});

test('off Android the setting is not offered and a saved choice is inert',async({page},testInfo)=>{
  await installLocalTerminal(page);
  await page.addInitScript(()=>{localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,privateKeyboard:true}));});
  await page.goto('/');
  await openTerminal(page,testInfo);
  await openKeyboardSettings(page);
  await expect(page.getByRole('checkbox',{name:'Ctrl+Enter sends the draft (off: it only inserts it)',exact:true})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:label,exact:true})).toHaveCount(0);
  await closePreferences(page);
  await editor(page).focus();
  await page.waitForTimeout(100);
  expect(await reported(page)).toEqual([]);
});

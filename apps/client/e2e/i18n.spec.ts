import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {pseudoEnglish} from '../src/test/pseudoLocale';

declare global {interface Window {localeFixture:{calls:string[];output:()=>void};}}
const nativeReason='RAW native reason <verbatim> 中文';
async function fixture(page: Page) {
  await installNativeBridge(page);
  await page.addInitScript(reason=>{
    Object.defineProperty(navigator,'languages',{configurable:true,get:()=>['en-GB']});
    window.localeFixture={calls:[],output:()=>{}};
    window.nativeFixtureInvoke=async(command,args)=>{
      window.localeFixture.calls.push(command);
      if(command==='list_hosts')return [{id:'locale-host',name:'Host <raw> {{x}} 中文',hostname:'fixture.invalid',username:'agent',port:22}];
      if(command==='local_capability')return {available:true,reason:'Synthetic local terminal; no shell starts.'};
      if(command==='local_connect') {
        const channel=args.events as {onmessage:(event:unknown)=>void};
        window.localeFixture.output=()=>channel.onmessage({type:'data',data:[...new TextEncoder().encode('RAW C-b, {{text}} 世界\r\n')]});
        return {sessionId:'local:locale-fixture'};
      }
      if(['local_resize','local_ack','local_disconnect'].includes(command))return;
      if(command==='app_icon_status')return {available:false,current:'unknown',reason};
      if(command==='credential_protection')return {available:false,reason};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected locale fixture command: ${command}`);
    };
  },nativeReason);
  await page.goto('/');
}
async function hosts(page: Page) {
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
}
test('system and English persist, reset safely, and locale changes preserve the existing live terminal',async({page})=>{
  await fixture(page);await expect(page.locator('html')).toHaveAttribute('lang','en-GB');
  await hosts(page);await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const screen=page.locator('.terminal-canvas .xterm-screen');
  await expect(screen).toBeVisible();
  await page.evaluate(()=>window.localeFixture.output());
  await expect(screen).toContainText('RAW C-b, {{text}} 世界');
  const canvas=await page.locator('.terminal-canvas').elementHandle();
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  const language=page.getByRole('combobox',{name:'App language',exact:true});
  await expect(language).toBeVisible();
  expect(await language.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['system','en']);
  await language.selectOption('en');await expect(page.locator('html')).toHaveAttribute('lang','en');
  expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await page.evaluate(()=>window.localeFixture.calls.filter(name=>name==='local_connect'))).toHaveLength(1);
  expect(await page.evaluate(()=>window.localeFixture.calls.includes('local_disconnect'))).toBe(false);
  await page.keyboard.press('Escape');await expect(screen).toContainText('RAW C-b, {{text}} 世界');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','en');
  await page.getByRole('button',{name:'Preferences',exact:true}).click();
  await expect(page.getByRole('combobox',{name:'App language',exact:true})).toHaveValue('en');
  await page.getByRole('button',{name:'Reset preferences',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','en-GB');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).uiLanguage)).toBe('system');
});
test('pseudo expansion preserves host drafts, native diagnostics, keyboard focus and shortcut bytes',async({page})=>{
  await fixture(page);await hosts(page);
  await page.getByRole('button',{name:'Add host',exact:true}).click();
  const draft='User C-b, <raw> {{untouched}} 中文';
  await page.getByLabel('Name',{exact:true}).fill(draft);
  await page.getByLabel('Hostname or IP',{exact:true}).fill('fixture.invalid');
  await page.getByLabel('Username',{exact:true}).fill('agent');
  const original=await page.getByLabel('Name',{exact:true}).elementHandle();
  const checks=await page.evaluate(()=>window.localeFixture.calls.filter(name=>name==='credential_protection').length);
  await page.evaluate(async()=>{
    const {uiI18n}=await import('/src/i18n/core.ts');
    const {enablePseudoLocale}=await import('/src/test/pseudoLocale.ts');
    await enablePseudoLocale(uiI18n);
  });
  const pseudo=pseudoEnglish();
  const dialog=page.getByRole('dialog',{name:pseudo.appAddAHost,exact:true});
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel(pseudo.appName,{exact:true})).toHaveValue(draft);
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await page.evaluate(()=>window.localeFixture.calls.filter(name=>name==='credential_protection').length)).toBe(checks);
  await expect(page.getByText(nativeReason,{exact:true})).toBeVisible();
  expect(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.keyboard.press('Tab');expect(await dialog.evaluate(node=>node.contains(document.activeElement))).toBe(true);
  await page.getByLabel(pseudo.appName,{exact:true}).fill(' ');
  await page.getByRole('button',{name:pseudo.appSaveHost,exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText(pseudo.appGiveThisHostAName);
  expect(await page.evaluate(()=>window.localeFixture.calls.includes('save_host'))).toBe(false);
  await page.keyboard.press('Escape');
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:pseudo.appCloseHosts,exact:true}).click();
  await page.getByRole('button',{name:pseudo.appPreferences,exact:true}).click();
  await expect(page.getByRole('combobox',{name:pseudo.language,exact:true})).toBeVisible();
  expect(await page.getByRole('combobox',{name:pseudo.language,exact:true}).locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['system','en']);
  await page.getByText(pseudo.preferencesTerminalTouchGestures,{exact:true}).click();
  await page.getByRole('combobox',{name:pseudo.gestureDoubleTap,exact:true}).selectOption('custom');
  const chord=pseudo.shortcutValue1Chord.replace('{{value1}}',pseudo.gestureDoubleTap);
  await page.getByLabel(chord,{exact:true}).fill('C-b, T');
  await page.getByRole('button',{name:pseudo.shortcutSaveValue1Chord.replace('{{value1}}',pseudo.gestureDoubleTap),exact:true}).click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).gestureChords.doubleTap)).toBe('C-b, T');
  expect(await page.locator('[role=dialog]').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await expect(page.locator('img,script[src^="http"]')).toHaveCount(0);
});

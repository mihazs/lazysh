import {workspaceControl} from './fixtures/workspaceControl';
import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {pseudoEnglish} from '../src/test/pseudoLocale';

declare global {interface Window {localeFixture:{calls:string[];sent:string[];copied:string[];output:(text?:string)=>void};}}
const nativeReason='RAW native reason <verbatim> 中文';
async function fixture(page: Page, languages = ['en-GB']) {
  await installNativeBridge(page);
  await page.addInitScript(({reason,languages})=>{
    Object.defineProperty(navigator,'languages',{configurable:true,get:()=>languages});
    window.localeFixture={calls:[],sent:[],copied:[],output:()=>{}};
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{window.localeFixture.copied.push(text);},readText:async()=>"RAW clipboard"}});
    window.nativeFixtureInvoke=async(command,args)=>{
      window.localeFixture.calls.push(command);
      if(command==='list_hosts')return [{id:'locale-host',name:'Host <raw> {{x}} 中文',hostname:'fixture.invalid',username:'agent',port:22}];
      if(command==='local_capability')return {available:true,reason:'Synthetic local terminal; no shell starts.'};
      if(command==='local_connect') {
        const channel=args.events as {onmessage:(event:unknown)=>void};
        window.localeFixture.output=(text='RAW C-b, {{text}} 世界\r\n')=>channel.onmessage({type:'data',data:[...new TextEncoder().encode(text)]});
        return {sessionId:'local:locale-fixture'};
      }
      if(command==='local_write'){window.localeFixture.sent.push(String(args.data));return;}
      if(['local_resize','local_ack','local_disconnect'].includes(command))return;
      if(command==='app_icon_status')return {available:false,current:'unknown',reason};
      if(command==='credential_protection')return {available:false,reason};
      if(command.startsWith('plugin:event|'))return 1;
      throw new Error(`Unexpected locale fixture command: ${command}`);
    };
  },{reason:nativeReason,languages});
  await page.goto('/');
}
async function hosts(page: Page) {
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
}
async function connectedTerminal(page: Page) {
  await hosts(page);await page.getByRole('button',{name:'Open local terminal',exact:true}).click();
  const screen=page.locator('.terminal-canvas .xterm-screen');
  await expect(screen).toBeVisible();
  await page.evaluate(()=>window.localeFixture.output());
  await expect(screen).toContainText('RAW C-b, {{text}} 世界');
  return {screen,canvas:await page.locator('.terminal-canvas').elementHandle()};
}
test('Paste draft returns keyboard Enter to the existing terminal without losing composer staging focus',async({page})=>{
  await fixture(page);const {canvas}=await connectedTerminal(page);
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  const composer=page.getByRole('textbox',{name:'Compose text',exact:true});
  await expect(composer).toBeFocused();
  await composer.fill("printf 'SSH_%s_END\\n' 'owned-challenge'");
  await page.keyboard.press('Enter');
  const draft=await composer.inputValue();
  expect(draft).toContain('\n');
  expect(await page.evaluate(()=>window.localeFixture.sent)).toEqual([]);
  await page.getByRole('button',{name:'Paste draft',exact:true}).click();
  await expect(composer).toHaveValue('');
  await expect(page.locator('.terminal-canvas .xterm-helper-textarea')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.localeFixture.sent)).toEqual([draft.replaceAll('\n','\r'),'\r']);
  expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('lazysh-prompt-draft',{detail:{sessionId:'local:locale-fixture',text:'new staged draft'}})));
  await expect(composer).toHaveValue('new staged draft');
  await expect(composer).toBeFocused();
});
test('system and English persist, reset safely, and locale changes preserve the existing live terminal',async({page})=>{
  await fixture(page);await expect(page.locator('html')).toHaveAttribute('lang','en-GB');
  const {screen,canvas}=await connectedTerminal(page);
  await (await workspaceControl(page,'Preferences')).click();
  const language=page.getByRole('combobox',{name:'App language',exact:true});
  await expect(language).toBeVisible();
  expect(await language.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['system','en','pt-BR','es']);
  await language.selectOption('en');await expect(page.locator('html')).toHaveAttribute('lang','en');
  expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
  expect(await page.evaluate(()=>window.localeFixture.calls.filter(name=>name==='local_connect'))).toHaveLength(1);
  expect(await page.evaluate(()=>window.localeFixture.calls.includes('local_disconnect'))).toBe(false);
  await page.keyboard.press('Escape');await expect(screen).toContainText('RAW C-b, {{text}} 世界');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','en');
  await (await workspaceControl(page,'Preferences')).click();
  await expect(page.getByRole('combobox',{name:'App language',exact:true})).toHaveValue('en');
  await page.getByRole('button',{name:'Reset preferences',exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','en-GB');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).uiLanguage)).toBe('system');
});
test('pseudo expansion preserves host drafts, native diagnostics, keyboard focus and shortcut bytes',async({page})=>{
  await fixture(page);await hosts(page);
  const brand=page.locator('.brand > img.brand-mark');
  await expect(brand).toHaveCount(1);
  const originalBrand=await brand.elementHandle();
  const originalSource=await brand.getAttribute('src');
  expect(originalSource).toBeTruthy();
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
  await (await workspaceControl(page,pseudo.appPreferences)).click();
  await expect(page.getByRole('combobox',{name:pseudo.language,exact:true})).toBeVisible();
  expect(await page.getByRole('combobox',{name:pseudo.language,exact:true}).locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['system','en','pt-BR','es']);
  await page.getByText(pseudo.preferencesTerminalTouchGestures,{exact:true}).click();
  await page.getByRole('combobox',{name:pseudo.gestureDoubleTap,exact:true}).selectOption('custom');
  const chord=pseudo.shortcutValue1Chord.replace('{{value1}}',pseudo.gestureDoubleTap);
  await page.getByLabel(chord,{exact:true}).fill('C-b, T');
  await page.getByRole('button',{name:pseudo.shortcutSaveValue1Chord.replace('{{value1}}',pseudo.gestureDoubleTap),exact:true}).click();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('lazysh.preferences.v1')!).gestureChords.doubleTap)).toBe('C-b, T');
  expect(await page.locator('[role=dialog]').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await expect(page.locator('img')).toHaveCount(2);
  await expect(page.locator('img:not(.brand-mark):not(.welcome-brand-mark)')).toHaveCount(0);
  for (const image of await page.locator('img').all()) await expect(image).toHaveAttribute('src',originalSource!);
  expect(await originalBrand!.evaluate((node,source)=>node.isConnected
    && document.querySelector('.brand > img.brand-mark')===node && node.getAttribute('src')===source,originalSource)).toBe(true);
  await expect(page.locator('script[src^="http"]')).toHaveCount(0);
});

for(const locale of [
  {code:'pt-BR',preferences:'Preferências',language:'Idioma do aplicativo',heading:'Preferências do terminal',add:'Adicionar servidor',dialog:'Adicionar um servidor',name:'Nome',hostname:'Hostname ou IP',username:'Usuário',save:'Salvar servidor',invalid:'Dê um nome a este servidor.',close:'Fechar servidores',reset:'Redefinir preferências'},
  {code:'es',preferences:'Preferencias',language:'Idioma de la aplicación',heading:'Preferencias del terminal',add:'Añadir servidor',dialog:'Añadir un servidor',name:'Nombre',hostname:'Nombre de host o IP',username:'Usuario',save:'Guardar servidor',invalid:'Asigna un nombre a este servidor.',close:'Cerrar servidores',reset:'Restablecer preferencias'},
] as const) test(`${locale.code} selection translates real workflows, persists, and keeps live terminal and host draft identities`,async({page})=>{
  await fixture(page);
  const {screen,canvas:terminal}=await connectedTerminal(page);
  await (await workspaceControl(page,'Preferences')).click();
  await page.getByRole('combobox',{name:'App language',exact:true}).selectOption(locale.code);
  await expect(page.locator('html')).toHaveAttribute('lang',locale.code);
  await expect(page.getByRole('heading',{name:locale.heading,exact:true})).toBeVisible();
  await expect(page.getByRole('combobox',{name:locale.language,exact:true})).toHaveValue(locale.code);
  await expect(page.getByText(nativeReason,{exact:true})).toBeVisible();
  expect(await page.getByRole('dialog').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(screen).toContainText('RAW C-b, {{text}} 世界');
  expect(await terminal!.evaluate(node=>node.isConnected)).toBe(true);
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:'Abrir servidores',exact:true}).click();
  await page.getByRole('button',{name:locale.add,exact:true}).click();
  const hostDialog=page.getByRole('dialog',{name:locale.dialog,exact:true});await expect(hostDialog).toBeVisible();
  const draft='C-b, <raw> $t(language) {{text}} 中文';
  const name=page.getByLabel(locale.name,{exact:true});await name.fill(draft);
  await page.getByLabel(locale.hostname,{exact:true}).fill('fixture.invalid');
  await page.getByLabel(locale.username,{exact:true}).fill('agent');
  const original=await name.elementHandle();
  const credentialCalls=await page.evaluate(()=>window.localeFixture.calls.filter(command=>command==='credential_protection').length);
  // The same public preference writer used by the selector updates an already-open form.
  await page.evaluate(async()=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:'en'});});
  await expect(page.getByLabel('Name',{exact:true})).toHaveValue(draft);
  expect(await original!.evaluate(node=>node.isConnected)).toBe(true);
  await page.evaluate(async code=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:code});},locale.code);
  await expect(name).toHaveValue(draft);
  expect(await page.evaluate(()=>window.localeFixture.calls.filter(command=>command==='credential_protection').length)).toBe(credentialCalls);
  await expect(page.getByText(nativeReason,{exact:true})).toBeVisible();
  await name.fill(' ');await page.getByRole('button',{name:locale.save,exact:true}).click();
  await expect(page.getByRole('alert')).toHaveText(locale.invalid);
  expect(await page.evaluate(()=>window.localeFixture.calls.includes('save_host'))).toBe(false);
  expect(await hostDialog.evaluate(node=>node.scrollWidth<=node.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  if((page.viewportSize()?.width??1280)<=600)await page.getByRole('button',{name:locale.close,exact:true}).click();
  expect(await terminal!.evaluate(node=>node.isConnected)).toBe(true);
  await expect(screen).toContainText('RAW C-b, {{text}} 世界');
  expect(await page.evaluate(()=>window.localeFixture.calls.filter(command=>command==='local_connect'))).toHaveLength(1);
  expect(await page.evaluate(()=>window.localeFixture.calls.includes('local_disconnect'))).toBe(false);
  await page.reload();await expect(page.locator('html')).toHaveAttribute('lang',locale.code);
  await (await workspaceControl(page,locale.preferences)).click();
  await expect(page.getByRole('combobox',{name:locale.language,exact:true})).toHaveValue(locale.code);
  await page.getByRole('button',{name:locale.reset,exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('lang','en-GB');

});

for(const system of [
  {languages:['fr','pt-PT'],locale:'pt-BR',preferences:'Preferências',language:'Idioma do aplicativo',system:'Sistema'},
  {languages:['es-MX'],locale:'es-MX',preferences:'Preferencias',language:'Idioma de la aplicación',system:'Sistema'},
]) test(`System selects bundled resources for ${system.languages.join(',')} without persisting a guessed override`,async({page})=>{
  await fixture(page,system.languages);
  await expect(page.locator('html')).toHaveAttribute('lang',system.locale);
  await (await workspaceControl(page,system.preferences)).click();
  await expect(page.getByRole('combobox',{name:system.language,exact:true})).toHaveValue('system');
  await expect(page.getByRole('option',{name:system.system,exact:true})).toHaveAttribute('value','system');
  expect(await page.evaluate(()=>localStorage.getItem('lazysh.preferences.v1'))).toBeNull();
});

for(const locale of [
  {code:'en',compose:'Compose text',paste:'Paste draft',find:'Find',search:'Search terminal history',next:'Next',match:'Match on line 1',consent:'Remote clipboard request',allow:'Allow this copy'},
  {code:'pt-BR',compose:'Compor texto',paste:'Colar rascunho',find:'Buscar',search:'Buscar no histórico do terminal',next:'Próxima',match:'Resultado na linha 1',consent:'Solicitação remota da área de transferência',allow:'Permitir esta cópia'},
  {code:'es',compose:'Redactar texto',paste:'Pegar borrador',find:'Buscar',search:'Buscar en el historial del terminal',next:'Siguiente',match:'Coincidencia en la línea 1',consent:'Solicitud remota del portapapeles',allow:'Permitir esta copia'},
] as const) test(`terminal-owned ${locale.code} controls retain live content, explicit consent and input bytes`,async({page})=>{
  await fixture(page);const {screen,canvas}=await connectedTerminal(page);
  await page.getByRole('button',{name:'ctrl',exact:true}).dblclick();
  await page.getByRole('button',{name:'Compose',exact:true}).click();
  const draft='RAW Ctrl+b <draft> {{text}} 中文';
  const textarea=page.getByRole('textbox',{name:'Compose text',exact:true});await textarea.fill(draft);
  const editor=await textarea.elementHandle();
  await page.evaluate(()=>window.localeFixture.output('\x1b]52;c;'+btoa('RAW clipboard {{text}}')+'\x07'));
  await expect(page.getByRole('region',{name:'Remote clipboard request',exact:true})).toBeVisible();
  await textarea.focus();
  await page.evaluate(async code=>{const {savePreferences,getPreferences}=await import('/src/preferences.ts');savePreferences({...getPreferences(),uiLanguage:code});},locale.code);
  const localized=page.getByRole('textbox',{name:locale.compose,exact:true});
  await expect(localized).toHaveValue(draft);await expect(localized).toBeFocused();
  expect(await editor!.evaluate(node=>node.isConnected)).toBe(true);expect(await canvas!.evaluate(node=>node.isConnected)).toBe(true);
  await expect(page.getByRole('region',{name:locale.consent,exact:true})).toContainText('RAW clipboard {{text}}');
  expect(await page.evaluate(()=>window.localeFixture.copied)).toEqual([]);expect(await page.evaluate(()=>window.localeFixture.sent)).toEqual([]);
  await page.getByRole('button',{name:locale.allow,exact:true}).click();
  expect(await page.evaluate(()=>window.localeFixture.copied)).toEqual(['RAW clipboard {{text}}']);
  await page.getByRole('button',{name:locale.find,exact:true}).click();
  await page.getByRole('textbox',{name:locale.search,exact:true}).fill('RAW');
  await page.getByRole('button',{name:locale.next,exact:true}).click();await expect(page.getByText(locale.match,{exact:true})).toBeVisible();
  await expect(screen).toContainText('RAW C-b, {{text}} 世界');
  await page.getByRole('button',{name:'c',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.localeFixture.sent)).toEqual(['\x03']);
  expect(await page.evaluate(()=>window.localeFixture.calls.filter(command=>command==='local_connect').length)).toBe(1);
  expect(await page.evaluate(()=>window.localeFixture.calls.includes('local_disconnect'))).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth)).toBe(true);
});

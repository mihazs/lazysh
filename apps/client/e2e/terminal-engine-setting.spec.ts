import {expect,test,type Page} from '@playwright/test';
import {installNativeBridge} from './fixtures/nativeBridge';
import {closePreferences,openPreferenceCategory,workspaceControl} from './fixtures/workspaceControl';
import {openLocalizedApp} from './fixtures/localizedApp';
import {onEngine} from '../src/e2eTerminalBackend';

/** What the app's `terminal_core_available` answers: the registry's probe of the native engine. */
type Core={available:true}|{available:false;reason:string};
const notBuilt:Core={available:false,reason:'The native terminal core is not built into this app'};
const engineRadio=(page:Page,name:'Auto'|'Native'|'xterm.js')=>page.getByRole('radio',{name,exact:true});

/** The app on a synthetic host and a native bridge that answers the probe as `core`; `stored` seeds the device's preferences once, so a reload keeps what the spec chose. */
async function openApp(page:Page,core:Core,stored:Record<string,unknown>={},screenReaderActive=false) {
  await installNativeBridge(page,undefined,{screenReaderActive});
  await page.addInitScript(({core,stored})=>{
    if(!sessionStorage.getItem('seeded')){
      sessionStorage.setItem('seeded','1');
      localStorage.setItem('lazysh.preferences.v1',JSON.stringify({version:1,...stored}));
    }
    let sessions=0;
    (window as unknown as {opened:string[]}).opened=[];
    window.nativeFixtureInvoke=async (command,args)=>{
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22}];
      if(command==='local_capability'||command==='apple_status_capability')return {available:false,reason:'Synthetic engine fixture.'};
      if(command==='transport_capabilities')return {mosh:false,et:false};
      if(command==='has_credentials')return false;
      if(command==='connect')return {sessionId:`engine-${++sessions}`};
      if(command==='native_terminal_probe')return core.available?{available:true}:{available:false,reason:core.reason};
      if(command==='terminal_core_available')return {...core,reason:'reason' in core?core.reason:'The native terminal core and its surface host are present'};
      if(command==='native_terminal_surface_place')return {placed:true,ready:true,generation:1,width:1,height:1};
      if(command==='open_web_url'){(window as unknown as {opened:string[]}).opened.push(String(args.url));return undefined;}
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command.startsWith('plugin:event|')||command.startsWith('terminal_core_')||command.startsWith('native_terminal_surface_')||['resize','ack_output','disconnect','write_stdin','cancel_credential_auth'].includes(command))return undefined;
      throw new Error(`Unexpected synthetic engine command: ${command}`);
    };
  },{core,stored});
  await page.goto('/');
}

async function openEngineSettings(page:Page) {
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Terminal');
  await expect(page.getByRole('group',{name:'Engine for new sessions',exact:true})).toBeVisible();
}

/** Opens a new session on the synthetic host and reads what its terminal got. */
async function connect(page:Page,phone:boolean) {
  if(phone)await page.getByRole('button',{name:'Open hosts',exact:true}).click();
  await page.getByRole('button',{name:'Connect to Fixture',exact:true}).click();
  await page.getByLabel('Password',{exact:true}).fill('synthetic-entry');
  await page.getByRole('button',{name:'Connect',exact:true}).click();
  await expect(page.locator('.terminal-canvas:visible')).toBeVisible();
  return onEngine(page);
}

const refused=(reason:string)=>`Native is turned off: the native engine cannot run here (${reason}).`;

test('each engine choice survives a reload and decides the engine of the next session, with the reason recorded',async({page},testInfo)=>{
  const phone=testInfo.project.name==='phone';
  await openApp(page,{available:true});
  await openEngineSettings(page);
  await expect(engineRadio(page,'Auto')).toBeChecked();
  await expect(engineRadio(page,'Native')).toBeEnabled();
  await expect(page.getByText(/^Native is turned off/)).toHaveCount(0);
  await expect(page.getByText(/open from now on; a session that is already open keeps its engine/)).toBeVisible();

  const expected={
    'xterm.js':{backend:'xterm',selection:{id:'xterm',reason:'preference',fallbacks:[]}},
    Native:{backend:'native',selection:{id:'native',reason:'preference',fallbacks:[]}},
    // Auto picks native only for a platform whose own default flip made it eligible; this build has not flipped.
    Auto:{backend:'xterm',selection:{id:'xterm',reason:'automatic',fallbacks:[]}},
  } as const;
  for(const choice of ['xterm.js','Native','Auto'] as const) {
    await engineRadio(page,choice).check();
    await page.reload();
    await openEngineSettings(page);
    await expect(engineRadio(page,choice)).toBeChecked();
    await closePreferences(page);
    expect(await connect(page,phone)).toEqual(expected[choice]);
    await page.reload();
    await openEngineSettings(page);
  }
});

test('Native is shown disabled with the registry\'s reason where the app cannot run it, and the choice never hides it',async({page})=>{
  await openApp(page,notBuilt);
  await openEngineSettings(page);
  await expect(engineRadio(page,'Native')).toBeVisible();
  await expect(engineRadio(page,'Native')).toBeDisabled();
  await expect(engineRadio(page,'Auto')).toBeChecked();
  for(const choice of ['Auto','xterm.js'] as const)await expect(engineRadio(page,choice)).toBeEnabled();
  await expect(page.getByText(refused(notBuilt.reason),{exact:true})).toBeVisible();
  await expect(engineRadio(page,'Native')).toHaveAccessibleDescription(refused(notBuilt.reason));
});

test('a stored Native choice stays visible and the next session records why it runs xterm.js',async({page},testInfo)=>{
  await openApp(page,notBuilt,{terminalEngine:'native'});
  await openEngineSettings(page);
  await expect(engineRadio(page,'Native')).toBeChecked();
  await expect(engineRadio(page,'Native')).toBeDisabled();
  await closePreferences(page);
  expect(await connect(page,testInfo.project.name==='phone')).toEqual({backend:'xterm',selection:{id:'xterm',reason:'fallback',fallbacks:[{id:'native',reason:notBuilt.reason}]}});
});

test('while a screen reader is active Native is refused with that message and new sessions use xterm.js',async({page},testInfo)=>{
  await openApp(page,{available:true});
  await openEngineSettings(page);
  await engineRadio(page,'Native').check();
  const message='Native is turned off: a screen reader is active and the native engine cannot be read by it.';
  await expect(page.getByText(message,{exact:true})).toHaveCount(0);
  const screenReader=page.getByRole('checkbox',{name:'Screen reader announcements',exact:true});
  await screenReader.check();
  await expect(page.getByText(message,{exact:true})).toBeVisible();
  await expect(engineRadio(page,'Native')).toBeDisabled();
  await closePreferences(page);
  expect(await connect(page,testInfo.project.name==='phone')).toEqual({backend:'xterm',selection:{id:'xterm',reason:'fallback',fallbacks:[{id:'native',reason:'lacks accessibility'}]}});
  await page.reload();
  await openEngineSettings(page);
  await screenReader.uncheck();
  await expect(page.getByText(message,{exact:true})).toHaveCount(0);
  await expect(engineRadio(page,'Native')).toBeEnabled();
  await expect(engineRadio(page,'Native')).toBeChecked();
});

test('desktop accessibility refuses Native even with in-app announcements off',async({page,isMobile})=>{
  test.skip(isMobile || process.platform !== 'linux','Linux desktop accessibility.');
  await openApp(page,{available:true},{terminalEngine:'native',screenReader:false},true);
  await openEngineSettings(page);
  await expect(engineRadio(page,'Native')).toBeDisabled();
  await expect(page.getByRole('checkbox',{name:'Screen reader announcements',exact:true})).not.toBeChecked();
  await closePreferences(page);
  expect(await connect(page,false)).toMatchObject({backend:'xterm',selection:{fallbacks:[{id:'native',reason:'lacks accessibility'}]}});
});

test('the keyboard alone chooses the engine and passes over a disabled Native',async({page})=>{
  await openApp(page,notBuilt);
  await openEngineSettings(page);
  await engineRadio(page,'Auto').focus();
  await page.keyboard.press('ArrowRight');
  await expect(engineRadio(page,'xterm.js')).toBeChecked();
  await expect(engineRadio(page,'xterm.js')).toBeFocused();
  await page.reload();
  await openEngineSettings(page);
  await expect(engineRadio(page,'xterm.js')).toBeChecked();
  await engineRadio(page,'xterm.js').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(engineRadio(page,'Auto')).toBeChecked();
});

const translated={
  'pt-BR':{group:'Mecanismo das novas sessões',auto:'Automático',off:'Nativo está desativado: o mecanismo nativo não pode ser executado aqui (this is not the lazysh app).',report:'Relatar um problema do terminal'},
  es:{group:'Motor de las nuevas sesiones',auto:'Automático',off:'Nativo está desactivado: el motor nativo no puede ejecutarse aquí (this is not the lazysh app).',report:'Informar un problema del terminal'},
};
for(const [locale,text] of Object.entries(translated))test(`the engine choice and the reason Native is off are shown in ${locale}`,async({page})=>{
  await openLocalizedApp(page,locale);
  await (await workspaceControl(page,await page.evaluate(async()=>(await import('/src/i18n/core.ts')).t('appPreferences')))).click();
  await openPreferenceCategory(page,'Terminal');
  await expect(page.getByRole('group',{name:text.group,exact:true})).toBeVisible();
  await expect(page.getByRole('radio',{name:text.auto,exact:true})).toBeChecked();
  await expect(page.getByRole('radio',{name:'Nativo',exact:true})).toBeDisabled();
  await expect(page.getByText(text.off,{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:text.report,exact:true})).toBeVisible();
});

test('Report a terminal problem opens the prefilled issue form in the browser and the app makes no request of its own',async({page,baseURL})=>{
  const outside:string[]=[];
  page.on('request',request=>{if(!request.url().startsWith(baseURL!))outside.push(request.url());});
  await openApp(page,notBuilt,{terminalEngine:'native'});
  await openEngineSettings(page);
  await page.getByRole('button',{name:'Report a terminal problem',exact:true}).click();
  const opened=await page.evaluate(()=>(window as unknown as {opened:string[]}).opened);
  expect(opened).toHaveLength(1);
  const url=new URL(opened[0]);
  expect(url.origin+url.pathname).toBe('https://github.com/mihazs/lazysh/issues/new');
  expect(url.searchParams.get('body')).toContain(`- Setting: native\n- Reason: native: ${notBuilt.reason}`);
  expect(outside).toEqual([]);
});

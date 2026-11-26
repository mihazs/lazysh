import {expect,test,type Page} from '@playwright/test';
import {connectHost} from './fixtures/connectHost';
import {installNativeBridge} from './fixtures/nativeBridge';
import {closePreferences,openPreferenceCategory,openToolsPageWith,workspaceControl} from './fixtures/workspaceControl';
import {onEngine} from '../src/e2eTerminalBackend';

const notBuilt='The native terminal core is not built into this app';

/** Opens a session on a synthetic host. `storage` seeds localStorage once; `coreReason` is why the app's probe refuses the native engine, or absent when it accepts it. */
async function openSession(page:Page,phone:boolean,storage:Record<string,string>={},coreReason?:string,mosh=false) {
  await installNativeBridge(page);
  await page.addInitScript(({storage,coreReason,mosh})=>{
    if(!sessionStorage.getItem('engine-seeded')) {
      sessionStorage.setItem('engine-seeded','1');
      for(const [key,value] of Object.entries(storage))localStorage.setItem(key,value);
    }
    window.nativeFixtureInvoke=async (command,args)=>{
      if(command==='list_hosts')return [{id:'fixture',name:'Fixture',hostname:'fixture.invalid',username:'owner',port:22,transport:mosh?'mosh':'ssh'}];
      if(command==='terminal_core_available')return coreReason?{available:false,reason:coreReason}:{available:true,reason:'present'};
      if(command==='native_terminal_probe')return {available:true,reason:'present',elapsedMs:1};
      if(command==='terminal_core_release'){
        if(!mosh)return null;
        const events=args.events as {onmessage:(event:{type:'data';data:number[]})=>void};
        const frame='\x1b]7777;lazysh-mosh;1;begin;1;42;9\x1b\\\x1b[2;1HNext Mosh frame\x1b]7777;lazysh-mosh;1;end;1\x1b\\';
        events.onmessage({type:'data',data:[...new TextEncoder().encode(frame)]});
        return {ansi:'Restored Mosh screen',columns:30,rows:6};
      }
      if(command==='connect_mosh')return {sessionId:'mosh-engine-session'};
      if(command==='connect')return {sessionId:'engine-session'};
      if(command==='native_terminal_surface_place')return {placed:true,ready:true,generation:1,width:1,height:1};
      if(command==='transport_capabilities')return {mosh,et:false};
      if(command==='agent_snapshot')return {schemaVersion:1,sessions:[]};
      if(command==='has_credentials')return false;
      if(command.endsWith('_capability'))return {available:false,reason:'Synthetic engine fixture.'};
      // The session's own traffic has no answer to give; anything else is refused, as an app without that feature would.
      if(/^(plugin:event\||terminal_core_|native_terminal_surface_|resize$|ack_output$|write_stdin$|disconnect$|cancel_credential_auth$)/.test(command))return undefined;
      throw new Error(`Unexpected synthetic engine command: ${command}`);
    };
  },{storage,coreReason,mosh});
  await connectHost(page,'Fixture',phone);
  await expect(page.locator('.terminal-canvas:visible')).toBeVisible();
}

const preferences=(stored:Record<string,unknown>)=>({'lazysh.preferences.v1':JSON.stringify({version:1,...stored})});

const cases:{name:string;storage?:Record<string,string>;coreReason?:string;line:string}[]=[
  {name:'chosen automatically',line:'xterm.js: chosen automatically'},
  {name:'chosen in Settings',storage:preferences({terminalEngine:'xterm'}),line:'xterm.js: chosen in Settings'},
  {name:'chosen by the developer override',storage:{'lazysh.terminal.backend':'native'},line:'Native: chosen by the developer override'},
  {name:'refused for a screen reader',storage:preferences({terminalEngine:'native',screenReader:true}),line:'xterm.js: a screen reader is active and the native engine cannot be read by it'},
  {name:'refused by a failed probe',storage:preferences({terminalEngine:'native'}),coreReason:notBuilt,line:`xterm.js: the native engine cannot run here (${notBuilt})`},
];
for(const {name,storage,coreReason,line} of cases)test(`the Workspace tools menu and Settings say which engine the session uses when it was ${name}`,async({page},testInfo)=>{
  await openSession(page,testInfo.project.name==='phone',storage,coreReason);
  const sentence=`The current session's terminal engine is ${line}`;
  // The menu page that holds the line is the one with this action.
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await openToolsPageWith(page,'New connection');
  const menu=page.getByRole('dialog',{name:'Workspace tools',exact:true});
  await expect(menu.getByRole('note').filter({hasText:sentence})).toHaveText(sentence);
  await expect(menu.getByRole('button',{name:'Report a terminal problem',exact:true})).toBeVisible();
  await menu.getByRole('button',{name:'Close Workspace tools',exact:true}).click();
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Terminal');
  await expect(page.getByRole('dialog',{name:'Preferences',exact:true}).getByRole('note').filter({hasText:sentence})).toHaveText(sentence);
});

test('the Workspace tools menu moves a native session to xterm.js, and the engine line follows',async({page},testInfo)=>{
  await openSession(page,testInfo.project.name==='phone',preferences({terminalEngine:'native'}));
  const native={backend:'native',selection:{id:'native',reason:'preference',fallbacks:[]}};
  expect(await onEngine(page)).toEqual(native);
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await openToolsPageWith(page,'Switch this session to xterm.js');
  const menu=page.getByRole('dialog',{name:'Workspace tools',exact:true});
  await menu.getByRole('button',{name:'Switch this session to xterm.js',exact:true}).click();
  await expect.poll(()=>onEngine(page)).toEqual({backend:'xterm',selection:{id:'xterm',reason:'switched',fallbacks:[]}});
  await expect(page.locator('.terminal-canvas:visible')).toBeVisible();
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  await openToolsPageWith(page,'New connection');
  const sentence="The current session's terminal engine is xterm.js: you switched this session from the native engine";
  await expect(menu.getByRole('note').filter({hasText:sentence})).toHaveText(sentence);
  await expect(menu.getByRole('button',{name:'Switch this session to xterm.js',exact:true})).toHaveCount(0);
});

test('the Workspace tools menu restores a native Mosh session before applying its next frame',async({page},testInfo)=>{
  await openSession(page,testInfo.project.name==='phone',preferences({terminalEngine:'native'}),undefined,true);
  expect((await onEngine(page)).backend).toBe('native');
  await page.getByRole('button',{name:'Workspace tools',exact:true}).click();
  const action='Switch this session to xterm.js';
  await openToolsPageWith(page,action);
  await page.getByRole('dialog',{name:'Workspace tools',exact:true}).getByRole('button',{name:action,exact:true}).click();
  await expect.poll(()=>onEngine(page)).toEqual({backend:'xterm',selection:{id:'xterm',reason:'switched',fallbacks:[]}});
  const rows=page.locator('.terminal-canvas:visible .xterm-rows > div');
  await expect(rows).toHaveCount(9);
  await expect(rows.nth(0)).toContainText('Restored Mosh screen');
  await expect(rows.nth(1)).toContainText('Next Mosh frame');
});

test('Settings shows no engine line while no session is open',async({page})=>{
  await page.goto('/');
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Terminal');
  await expect(page.getByRole('heading',{name:'Cursor and history',exact:true})).toBeVisible();
  await expect(page.getByText(/terminal engine is/)).toHaveCount(0);
});

const translated={
  'pt-BR':`O mecanismo de terminal da sessão atual é xterm.js: o mecanismo nativo não pode ser executado aqui (${notBuilt})`,
  es:`El motor de terminal de la sesión actual es xterm.js: el motor nativo no puede ejecutarse aquí (${notBuilt})`,
};
for(const [locale,sentence] of Object.entries(translated))test(`the engine line is shown in ${locale}`,async({page},testInfo)=>{
  await openSession(page,testInfo.project.name==='phone',preferences({terminalEngine:'native'}),notBuilt);
  await (await workspaceControl(page,'Preferences')).click();
  await openPreferenceCategory(page,'Language');
  await page.getByRole('group',{name:'App language',exact:true}).locator(`input[value="${locale}"]`).check();
  await openPreferenceCategory(page,'Terminal');
  await expect(page.getByRole('note').filter({hasText:sentence})).toHaveText(sentence);
  await closePreferences(page);
});

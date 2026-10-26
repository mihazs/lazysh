// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import ThemeLinkPanel from './ThemeLinkPanel';
import ThemeImportPanel from './ThemeImportPanel';
import {acknowledgeAccessReady,accessSnapshot,applyAccessStatus} from './access';
import {defaults,getPreferences,savePreferences} from './preferences';
import * as preferences from './preferences';
import {exportTheme} from './themeImport';
vi.mock('@tauri-apps/api/core',()=>({invoke:vi.fn()}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn()}));
let generation=0,pending: {receipt:string;code:string}|null,changed:()=>void;
const receipt='11111111-1111-4111-8111-111111111111';
function ready() {
  applyAccessStatus({initialized:true,supported:true,reason:'synthetic',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});
  acknowledgeAccessReady(accessSnapshot().epoch);
}
function offer(name='Linked 日光',id=receipt) {
  pending={receipt:id,code:exportTheme({v:1,name,mode:'light',colors:{background:'#ffffff',foreground:'#111111'}}).code};
}
beforeEach(()=>{
  vi.clearAllMocks();savePreferences({...defaults});ready();offer();
  vi.mocked(listen).mockImplementation(async(_name,handler)=>{changed=()=>{handler({payload:null} as never);};return()=>{};});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='theme_link_status')return !!pending;
    if(command==='theme_link_read')return pending;
    if(command==='theme_link_ack'){if((args as {receipt:string}).receipt===pending?.receipt)pending=null;return null;}
    throw new Error('unexpected command');
  });
});
import {t,uiI18n} from './i18n/core';
afterEach(async()=>{cleanup();await uiI18n.changeLanguage('en');});
it('requires explicit review and apply while preserving the manual import draft',async()=>{
  render(<><ThemeLinkPanel/><ThemeImportPanel preferences={defaults} apply={()=>true}/></>);
  const input=screen.getByLabelText('Theme JSON or share code');
  fireEvent.change(input,{target:{value:'unfinished manual draft'}});
  await screen.findByRole('button',{name:'Review linked theme'});
  expect(getPreferences().theme).toBe('forest');
  expect(invoke).not.toHaveBeenCalledWith('theme_link_read',expect.anything(),expect.anything());
  fireEvent.click(screen.getByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});
  expect(getPreferences().theme).toBe('forest');
  expect((input as HTMLTextAreaElement).value).toBe('unfinished manual draft');
  fireEvent.click(screen.getByRole('button',{name:'Apply linked theme'}));
  await screen.findByRole('status');
  expect(getPreferences().customThemeInfo).toEqual({name:'Linked 日光',mode:'light'});
  expect(pending).toBeNull();
  expect((input as HTMLTextAreaElement).value).toBe('unfinished manual draft');
});
it('discards without changing preferences and never acknowledges a replacement receipt',async()=>{
  render(<ThemeLinkPanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});
  offer('New pending','22222222-2222-4222-8222-222222222222');
  act(()=>changed());
  expect(screen.getByRole('heading',{name:'Linked 日光'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Discard theme link'}));
  await screen.findByRole('button',{name:'Review linked theme'});
  expect(pending?.receipt).not.toBe(receipt);expect(getPreferences().theme).toBe('forest');
  fireEvent.click(screen.getByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'New pending'});
});
it('does not claim an applied theme was kept unchanged when metadata refresh fails',async()=>{
  render(<ThemeLinkPanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});
  vi.mocked(invoke).mockImplementation(async(command)=>{
    if(command==='theme_link_ack')return null;
    throw new Error('Synthetic status refresh failure');
  });
  fireEvent.click(screen.getByRole('button',{name:'Apply linked theme'}));
  expect((await screen.findByRole('status')).textContent).toContain('applied');
  expect(screen.queryByRole('alert')).toBeNull();expect(getPreferences().theme).toBe('custom');
});
it('does not fetch before ready, and the original mount stays revoked across lock/unlock with a held ack',async()=>{
  applyAccessStatus({initialized:true,supported:true,reason:'waiting for ready',enabled:true,locked:false,generation:String(++generation),nonce:'a'.repeat(64)});
  render(<ThemeLinkPanel/>);
  await act(async()=>{});expect(invoke).not.toHaveBeenCalled();
  act(()=>acknowledgeAccessReady(accessSnapshot().epoch));
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});
  let finish:()=>void=()=>{};
  vi.mocked(invoke).mockImplementation(async(command)=>command==='theme_link_ack'?new Promise(resolve=>{pending=null;finish=()=>resolve(null);}):true);
  fireEvent.click(screen.getByRole('button',{name:'Apply linked theme'}));
  expect(getPreferences().theme).toBe('custom');
  expect(pending).toBeNull();
  act(()=>applyAccessStatus({initialized:true,supported:true,reason:'locked',enabled:true,locked:true,generation:String(++generation)}));
  act(()=>ready());
  await act(async()=>finish());
  expect(getPreferences().theme).toBe('custom');
  const before=vi.mocked(invoke).mock.calls.length;
  expect((screen.getByRole('button',{name:'Apply linked theme'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Discard theme link'}));
  await act(async()=>{});
  expect(invoke).toHaveBeenCalledTimes(before);
});
it('discards held review results and cannot freshen an obsolete mount after immediate reunlock',async()=>{
  render(<ThemeLinkPanel/>);
  const button=await screen.findByRole('button',{name:'Review linked theme'});
  let finish:()=>void=()=>{};
  vi.mocked(invoke).mockImplementation(async(command)=>command==='theme_link_read'?new Promise(resolve=>{finish=()=>resolve(pending);}):true);
  fireEvent.click(button);
  act(()=>applyAccessStatus({initialized:true,supported:true,reason:'locked',enabled:true,locked:true,generation:String(++generation)}));
  act(()=>ready());
  await act(async()=>finish());
  expect(screen.queryByRole('heading',{name:'Linked 日光'})).toBeNull();
  expect((button as HTMLButtonElement).disabled).toBe(true);
  const before=vi.mocked(invoke).mock.calls.length;
  fireEvent.click(button);await act(async()=>{});
  expect(invoke).toHaveBeenCalledTimes(before);expect(getPreferences().theme).toBe('forest');
});
it.each([{label:'unsupported',json:'{"v":1,"colors":{"background":"url(evil)"}}'},{label:'oversized',json:'x'.repeat(8193)}])('offers explicit discard for $label linked JSON without applying it',async({json})=>{
  pending={receipt,code:'lazysh-theme:'+btoa(json).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')};
  render(<ThemeLinkPanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button',{name:'Apply linked theme'})).toBeNull();
  expect(getPreferences().theme).toBe('forest');
  fireEvent.click(screen.getByRole('button',{name:'Discard theme link'}));
  await waitFor(()=>expect(pending).toBeNull());
});

it('reports acknowledgement failure separately after saving the reviewed theme',async()=>{
  render(<ThemeLinkPanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});
  vi.mocked(invoke).mockRejectedValueOnce(new Error('Synthetic ack failure'));
  fireEvent.click(screen.getByRole('button',{name:'Apply linked theme'}));
  expect((await screen.findByRole('alert')).textContent).toContain('already applied');
  expect(screen.getByRole('status').textContent).toContain('applied');
  expect(getPreferences().theme).toBe('custom');expect(pending?.receipt).toBe(receipt);
});
it('does not acknowledge a theme whose preference persistence fails',async()=>{
  render(<ThemeLinkPanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});
  const save=vi.spyOn(preferences,'savePreferences').mockImplementationOnce(()=>{throw new Error('Synthetic storage failure');});
  try {
    fireEvent.click(screen.getByRole('button',{name:'Apply linked theme'}));
    await screen.findByRole('alert');
    expect(vi.mocked(invoke).mock.calls.some(([command])=>command==='theme_link_ack')).toBe(false);
    expect(pending?.receipt).toBe(receipt);expect(getPreferences().theme).toBe('forest');
  } finally {save.mockRestore();}
});
it('ignores an older post-ack status reply after a newer replacement event refresh',async()=>{
  render(<ThemeLinkPanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});
  let finish:()=>void=()=>{},held=false;
  vi.mocked(invoke).mockImplementation(async(command)=>{
    if(command==='theme_link_ack'){pending=null;return null;}
    if(command==='theme_link_status' && !held){held=true;return new Promise(resolve=>{finish=()=>resolve(false);});}
    if(command==='theme_link_status')return !!pending;
    if(command==='theme_link_read')return pending;
    throw new Error('unexpected command');
  });
  fireEvent.click(screen.getByRole('button',{name:'Discard theme link'}));
  await waitFor(()=>expect(held).toBe(true));
  offer('New pending','22222222-2222-4222-8222-222222222222');
  await act(async()=>changed());
  await screen.findByRole('button',{name:'Review linked theme'});
  await act(async()=>finish());
  expect(screen.getByRole('button',{name:'Review linked theme'})).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'New pending'});
});

async function linkedLanguages(check:()=>void){
  const{enablePseudoLocale}=await import('./test/pseudoLocale');
  const calls=[...vi.mocked(invoke).mock.calls],listeners=vi.mocked(listen).mock.calls.length;
  for(const locale of ['pt-BR','es','en-XA']){
    await act(async()=>{if(locale==='en-XA')await enablePseudoLocale(uiI18n);else await uiI18n.changeLanguage(locale);});
    check();expect(vi.mocked(invoke).mock.calls).toEqual(calls);expect(listen).toHaveBeenCalledTimes(listeners);
  }
}
it('preserves the original held read and raw preview name through language changes',async()=>{
  const name='RAW <name> {{literal}} 中文';offer(name);
  let finish!:(value:unknown)=>void;
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='theme_link_read'?new Promise(resolve=>{finish=resolve;}) as never:original(command,args,options));
  render(<ThemeLinkPanel/>);const review=await screen.findByRole('button',{name:'Review linked theme'});fireEvent.click(review);
  await linkedLanguages(()=>{expect(screen.getByRole('button',{name:t('themeLinkReviewLinkedTheme')})).toBe(review);expect(review).toHaveProperty('disabled',true);expect(getPreferences().theme).toBe('forest');});
  const originalCandidate=pending;await act(async()=>finish(originalCandidate));
  const preview=screen.getByRole('region',{name:t('themeLinkLinkedThemePreview')});
  await linkedLanguages(()=>{expect(screen.getByRole('region',{name:t('themeLinkLinkedThemePreview')})).toBe(preview);expect(screen.getByRole('heading',{name})).toBeTruthy();expect(pending).toBe(originalCandidate);expect(getPreferences().theme).toBe('forest');});
});
it.each(['success','failure'] as const)('retains the applied notice and original receipt through a held %s acknowledgement',async(outcome)=>{
  let finish!:()=>void;
  const original=vi.mocked(invoke).getMockImplementation()!;
  vi.mocked(invoke).mockImplementation((command,args,options)=>command==='theme_link_ack'?new Promise((resolve,reject)=>{finish=()=>outcome==='failure'?reject(new Error('RAW ack refused')):original(command,args,options).then(resolve,reject);}) as never:original(command,args,options));
  render(<ThemeLinkPanel/>);fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));
  await screen.findByRole('heading',{name:'Linked 日光'});fireEvent.click(screen.getByRole('button',{name:'Apply linked theme'}));
  const notice=await screen.findByRole('status');const persisted=JSON.stringify(getPreferences());
  await linkedLanguages(()=>{expect(screen.getByRole('status')).toBe(notice);expect(notice.textContent).toBe(t('themeLinkLinkedThemeAppliedToAppAndTerminal'));expect(JSON.stringify(getPreferences())).toBe(persisted);});
  expect(vi.mocked(invoke).mock.calls.filter(([command])=>command==='theme_link_ack')).toEqual([['theme_link_ack',{receipt},{headers:{'X-Lazysh-Access':'a'.repeat(64)}}]]);
  await act(async()=>finish());
  await linkedLanguages(()=>{
    expect(screen.getByRole('status').textContent).toBe(t('themeLinkLinkedThemeAppliedToAppAndTerminal'));
    expect(screen.queryByRole('alert')?.textContent??'').toBe(outcome==='failure'?t('appTheLinkedThemeIsAlreadyAppliedButItsPending'):'');
    expect(JSON.stringify(getPreferences())).toBe(persisted);
  });
});
it('translates the retained unsupported-link error without reading or acknowledging it again',async()=>{
  pending={receipt,code:'lazysh-theme:'+btoa('{}').replace(/=+$/,'')};render(<ThemeLinkPanel/>);
  fireEvent.click(await screen.findByRole('button',{name:'Review linked theme'}));await screen.findByRole('alert');
  await linkedLanguages(()=>{expect(screen.getByRole('alert').textContent).toBe(t('themeLinkThisLinkDoesNotContainASupportedThemeDiscard'));expect(pending?.receipt).toBe(receipt);expect(getPreferences().theme).toBe('forest');});
});

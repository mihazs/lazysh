// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import ThemeLinkPanel from './ThemeLinkPanel';
import ThemeImportPanel from './ThemeImportPanel';
import {acknowledgeAccessReady,accessSnapshot,applyAccessStatus} from './access';
import {defaults,getPreferences,savePreferences} from './preferences';
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
  vi.mocked(listen).mockImplementation(async(_name,handler)=>{changed=()=>handler({payload:null} as never);return()=>{};});
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==='theme_link_status')return !!pending;
    if(command==='theme_link_read')return pending;
    if(command==='theme_link_ack'){if((args as {receipt:string}).receipt===pending?.receipt)pending=null;return null;}
    throw new Error('unexpected command');
  });
});
afterEach(cleanup);
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
  vi.mocked(invoke).mockImplementation(async(command)=>command==='theme_link_ack'?new Promise(resolve=>{finish=()=>resolve(null);}):true);
  fireEvent.click(screen.getByRole('button',{name:'Apply linked theme'}));
  act(()=>applyAccessStatus({initialized:true,supported:true,reason:'locked',enabled:true,locked:true,generation:String(++generation)}));
  act(()=>ready());
  await act(async()=>finish());
  expect(getPreferences().theme).toBe('forest');
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

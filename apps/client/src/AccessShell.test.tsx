// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listener: undefined as undefined | ((event: {payload:unknown})=>void), order: [] as string[] }));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
vi.mock('@tauri-apps/api/event',()=>({listen:vi.fn(async(_event:string,listener:(event:{payload:unknown})=>void)=>{
  mocks.listener=listener;return()=>{mocks.listener=undefined;};
})}));
import AccessShell, {type SessionRegistry} from './AccessShell';
import AccessPanel from './AccessPanel';
import { applyAccessStatus, useProtectedInvoke } from './access';
import {defaults,savePreferences} from './preferences';
import {t,uiI18n} from './i18n/core';
import {useClientLocale} from './i18n/useClientLocale';
import {listen} from '@tauri-apps/api/event';
vi.mock('./i18n/nativeLocale',()=>({useNativeLocale:()=>({mode:'frontend',phase:'ready'}),nativeLocale:{start:vi.fn(),snapshot:()=>({mode:'frontend'})}}));
let generationBase=0;
const unlocked=(generation='a')=>({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+({a:1,b:2,c:3}[generation]??0)),nonce:generation.repeat(64)});
const locked=()=>({initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+2)});
beforeEach(()=>{
  generationBase+=10;mocks.invoke.mockReset();mocks.order=[];applyAccessStatus(unlocked());
  vi.mocked(listen).mockClear();
  mocks.invoke.mockImplementation(async(command:string)=>{
    if(command==='app_lock_status')return unlocked();
    if(command==='app_lock_ready')mocks.order.push('ready');
  });
});
afterEach(async()=>{cleanup();vi.restoreAllMocks();await uiI18n.changeLanguage('en');});
function Workspace({registry}:{registry:SessionRegistry}) {
  const [draft,setDraft]=useState('');
  const invoke=useProtectedInvoke();
  useEffect(()=>{mocks.order.push('commit');},[]);
  return <><input aria-label="Private draft" value={draft} onChange={e=>setDraft(e.target.value)}/>
    <p>{registry.activeId || 'No retained session'}</p>
    <button onClick={()=>{registry.activeId='retained-session';}}>Retain session</button>
    <button onClick={()=>void invoke('read_file').then(value=>setDraft(String(value))).catch(()=>{})}>Read</button></>;
}
it('keeps the unlocked workspace absent until native initialization actually completes',async()=>{
  let complete!:(value:unknown)=>void;
  const pending={...unlocked(),initialized:false,locked:true,nonce:undefined};
  applyAccessStatus(pending);
  mocks.invoke.mockImplementation((command:string)=>command==='app_lock_status'?new Promise(resolve=>{complete=resolve;}):Promise.resolve(undefined));
  const workspace=vi.fn(()=> <button aria-label="Add host"/>);
  render(<AccessShell native>{workspace}</AccessShell>);
  expect(screen.queryByRole('button',{name:'Add host'})).toBeNull();
  expect(workspace).not.toHaveBeenCalled();
  await waitFor(()=>expect(complete).toBeTypeOf('function'));
  await act(async()=>complete(pending));
  expect(screen.queryByRole('button',{name:'Add host'})).toBeNull();
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('app_lock_status');
  await act(async()=>mocks.listener!({payload:unlocked('c')}));
  expect(await screen.findByRole('button',{name:'Add host'})).toBeTruthy();
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith('app_lock_ready',{generation:unlocked('c').generation}));
});
it('clears transient drafts before ready and retains the session registry across lock/unlock',async()=>{
  render(<AccessShell native>{registry=><Workspace registry={registry}/>}</AccessShell>);
  const input=await screen.findByLabelText('Private draft');
  fireEvent.change(input,{target:{value:'private draft'}});fireEvent.click(screen.getByText('Retain session'));
  await waitFor(()=>expect(mocks.order.slice(0,2)).toEqual(['commit','ready']));
  await act(async()=>mocks.listener!({payload:locked()}));
  expect(screen.queryByLabelText('Private draft')).toBeNull();expect(screen.getByText('lazysh is locked')).toBeTruthy();
  await act(async()=>mocks.listener!({payload:unlocked('c')}));
  expect((await screen.findByLabelText('Private draft') as HTMLInputElement).value).toBe('');
  expect(screen.getByText('retained-session')).toBeTruthy();
  expect(mocks.order).toEqual(['commit','ready','commit','ready']);
});
it('cannot repaint a late pre-lock result into the new workspace',async()=>{
  let finish!: (value:string)=>void;
  mocks.invoke.mockImplementation((command:string)=>command==='read_file'?new Promise<string>(resolve=>{finish=resolve;}):Promise.resolve(command==='app_lock_status'?unlocked():undefined));
  render(<AccessShell native>{registry=><Workspace registry={registry}/>}</AccessShell>);
  fireEvent.click(await screen.findByText('Read'));
  await act(async()=>mocks.listener!({payload:locked()}));
  await act(async()=>mocks.listener!({payload:unlocked('c')}));
  await act(async()=>finish('old private contents'));
  expect((screen.getByLabelText('Private draft') as HTMLInputElement).value).toBe('');
});
it('shows unsupported reason and cannot configure without supported native protection',()=>{
  applyAccessStatus({...unlocked(),supported:false,enabled:false,reason:'Unavailable on this platform.'});
  render(<AccessPanel/>);
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  expect(screen.getByText('Unavailable on this platform.')).toBeTruthy();expect(mocks.invoke).not.toHaveBeenCalled();
});
it('requires native configure authentication and leaves the opt-in disabled on rejection',async()=>{
  applyAccessStatus({...unlocked(),enabled:false});mocks.invoke.mockRejectedValue(new Error('Native authentication cancelled'));
  render(<AccessPanel/>);fireEvent.click(screen.getByRole('checkbox'));
  expect(mocks.invoke).toHaveBeenCalledWith('app_lock_configure',{enabled:true},{headers:{'X-Lazysh-Access':'a'.repeat(64)}});
  await screen.findByRole('alert');expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});

function LocalizedAccessShell({children}:{children:()=>ReactNode}) {
  useClientLocale();return <AccessShell native>{children}</AccessShell>;
}
it.each([
  ['event','accessNativeAppLockStatusIsUnavailable'],
  ['status','accessNativeAppLockStatusIsUnavailableRestartLazyshTo'],
  ['ready','accessNativeAppUnlockCouldNotFinish'],
] as const)('retranslates retained %s failure through System language changes without repeating native access work',async(cause,key)=>{
  savePreferences({...defaults});
  const languages=vi.spyOn(navigator,'languages','get').mockReturnValue(['en']);
  const workspace=vi.fn(()=> <p>Protected workspace</p>);
  let reject!:()=>void;
  mocks.invoke.mockImplementation((command:string)=>{
    if(command===(cause==='status'?'app_lock_status':'app_lock_ready') && cause!=='event')
      return new Promise((_yes,no)=>{reject=()=>no(new Error('PRIVATE_NATIVE_FAILURE'));});
    return Promise.resolve(command==='app_lock_status'?unlocked():undefined);
  });
  render(<LocalizedAccessShell>{workspace}</LocalizedAccessShell>);
  await waitFor(()=>expect(document.documentElement.lang).toBe('en'));
  if(cause==='event') {
    await screen.findByText('Protected workspace');
    await waitFor(()=>expect(mocks.invoke.mock.calls.some(([command])=>command==='app_lock_ready')).toBe(true));
  } else await waitFor(()=>expect(reject).toBeTypeOf('function'));
  await act(async()=>{if(cause==='event')mocks.listener!({payload:{}});else reject();});
  const error=await screen.findByText(t(key));
  const calls=mocks.invoke.mock.calls.slice(),renders=workspace.mock.calls.length;
  for(const language of ['pt-BR','es','en']) {
    languages.mockReturnValue([language]);
    await act(async()=>{window.dispatchEvent(new Event('languagechange'));});
    await waitFor(()=>expect(document.documentElement.lang).toBe(language));
    expect(screen.getByText(t(key))).toBe(error);
    expect(document.body.textContent).not.toContain('PRIVATE_NATIVE_FAILURE');
    expect(screen.queryByText('Protected workspace')).toBeNull();
    expect(mocks.invoke.mock.calls).toEqual(calls);expect(workspace).toHaveBeenCalledTimes(renders);
    expect(listen).toHaveBeenCalledTimes(1);
  }
});

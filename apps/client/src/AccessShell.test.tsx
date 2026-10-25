// @vitest-environment jsdom
import { useEffect, useState } from 'react';
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
let generationBase=0;
const unlocked=(generation='a')=>({initialized:true,supported:true,reason:'',enabled:true,locked:false,generation:String(generationBase+({a:1,b:2,c:3}[generation]??0)),nonce:generation.repeat(64)});
const locked=()=>({initialized:true,supported:true,reason:'',enabled:true,locked:true,generation:String(generationBase+2)});
beforeEach(()=>{
  generationBase+=10;mocks.invoke.mockReset();mocks.order=[];applyAccessStatus(unlocked());
  mocks.invoke.mockImplementation(async(command:string)=>{
    if(command==='app_lock_status')return unlocked();
    if(command==='app_lock_ready')mocks.order.push('ready');
  });
});
afterEach(cleanup);
function Workspace({registry}:{registry:SessionRegistry}) {
  const [draft,setDraft]=useState('');
  const invoke=useProtectedInvoke();
  useEffect(()=>{mocks.order.push('commit');},[]);
  return <><input aria-label="Private draft" value={draft} onChange={e=>setDraft(e.target.value)}/>
    <p>{registry.activeId || 'No retained session'}</p>
    <button onClick={()=>{registry.activeId='retained-session';}}>Retain session</button>
    <button onClick={()=>void invoke('read_file').then(value=>setDraft(String(value))).catch(()=>{})}>Read</button></>;
}
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
